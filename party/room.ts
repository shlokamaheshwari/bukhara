// Room party — one instance per room code. Holds authoritative game state
// for that room. Clients send lobby ops and move messages; server validates
// against the rules engine and broadcasts a redacted game state to everyone.

import type * as Party from 'partykit/server';
import { verifyToken } from './util';
import { newGame } from '../src/game/newGame';
import {
  addToSequence,
  addToTriplet,
  discard,
  drawStock,
  dropMeld,
  moveJoker,
  pickDiscard,
} from '../src/game/moves';
import { endMatchAndAdvance } from '../src/game/matchEnd';
import type { Game, PlayerId } from '../src/game/types';
import type {
  ClientMessage,
  GameStateMessage,
  MoveMessage,
  RoomStateMessage,
  ServerMessage,
} from '../src/net/messages';
import { pickBotMove } from './bot';

type Presence = {
  connectionId: string; // for bots: `bot-${seatIdx}`
  username: string;
  displayName: string;
  seatIdx: number | null;
  avatarUrl: string | null;
  isReady: boolean;
  online: boolean;
  isBot: boolean;
};

export default class RoomServer implements Party.Server {
  presences: Map<string, Presence> = new Map(); // connectionId → presence
  started = false;
  game: Game | null = null;
  seatToUsername: Record<PlayerId, string | null> = { 0: null, 1: null, 2: null, 3: null };

  constructor(readonly party: Party.Party) {}

  static async onBeforeConnect(
    req: Party.Request,
    lobby: Party.FetchLobby,
  ): Promise<Response | Request> {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (!token) return new Response('Missing token', { status: 401 });

    const secret =
      (lobby.env as Record<string, string | undefined>).TOKEN_SECRET ?? 'dev-secret-change-me';
    const payload = await verifyToken(token, secret);
    if (!payload || typeof payload.username !== 'string') {
      return new Response('Invalid or expired token', { status: 401 });
    }
    const forwarded = new Request(req);
    forwarded.headers.set('X-User', String(payload.username));
    forwarded.headers.set('X-Display', String(payload.displayName ?? payload.username));
    return forwarded;
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const username = ctx.request.headers.get('X-User') ?? 'unknown';
    const displayName = ctx.request.headers.get('X-Display') ?? username;

    // If this user already had a connection, migrate their presence.
    const previous = [...this.presences.values()].find((p) => p.username === username);
    const presence: Presence = {
      connectionId: conn.id,
      username,
      displayName: previous?.displayName ?? displayName,
      seatIdx: previous?.seatIdx ?? null,
      avatarUrl: previous?.avatarUrl ?? null,
      isReady: previous?.isReady ?? false,
      online: true,
      isBot: false,
    };
    if (previous) this.presences.delete(previous.connectionId);
    this.presences.set(conn.id, presence);

    this.broadcast();
  }

  onClose(conn: Party.Connection): void {
    const presence = this.presences.get(conn.id);
    if (!presence) return;
    presence.online = false;
    this.broadcast();
    // If the game hasn't started, fully evict after a grace period so a stale
    // seat doesn't block others. Once the game is running, keep the seat so
    // they can reconnect and resume.
    if (!this.started) {
      setTimeout(() => {
        const still = this.presences.get(conn.id);
        if (still && !still.online) {
          this.presences.delete(conn.id);
          this.broadcast();
        }
      }, 15_000);
    }
  }

  onMessage(raw: string, sender: Party.Connection): void {
    let data: ClientMessage;
    try {
      data = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    const presence = this.presences.get(sender.id);
    if (!presence) return;

    switch (data.type) {
      case 'set-profile':
        if (typeof data.displayName === 'string') {
          presence.displayName = data.displayName.trim().slice(0, 30) || presence.displayName;
        }
        if (typeof data.avatarUrl === 'string') {
          presence.avatarUrl = data.avatarUrl.slice(0, 300_000);
        }
        break;
      case 'take-seat': {
        if ([0, 1, 2, 3].includes(data.seatIdx) && !this.started) {
          const occupied = [...this.presences.values()].find(
            (p) => p.seatIdx === data.seatIdx && p.username !== presence.username,
          );
          if (!occupied) presence.seatIdx = data.seatIdx;
        }
        break;
      }
      case 'leave-seat':
        if (!this.started) {
          presence.seatIdx = null;
          presence.isReady = false;
        }
        break;
      case 'ready':
        if (presence.seatIdx !== null && !this.started) presence.isReady = !!data.ready;
        break;
      case 'start-game':
        this.tryStartGame();
        break;
      case 'add-bot': {
        if (this.started) break;
        if (![0, 1, 2, 3].includes(data.seatIdx)) break;
        const occupied = [...this.presences.values()].find((p) => p.seatIdx === data.seatIdx);
        if (occupied) break;
        this.addBot(data.seatIdx);
        break;
      }
      case 'remove-bot': {
        if (this.started) break;
        const bot = [...this.presences.values()].find((p) => p.seatIdx === data.seatIdx && p.isBot);
        if (bot) this.presences.delete(bot.connectionId);
        break;
      }
      default:
        // Move messages
        this.handleMove(data as MoveMessage, sender, presence);
        return;
    }

    this.broadcast();
  }

  private addBot(seatIdx: 0 | 1 | 2 | 3): void {
    const id = `bot-${seatIdx}`;
    // Remove any prior bot at this slot, then insert a fresh one.
    this.presences.delete(id);
    const bot: Presence = {
      connectionId: id,
      username: id,
      displayName: `Bot ${seatIdx + 1}`,
      seatIdx,
      avatarUrl: null,
      isReady: true,
      online: true,
      isBot: true,
    };
    this.presences.set(id, bot);
  }

  private tryStartGame(): void {
    if (this.started) return;
    const seated = [...this.presences.values()].filter((p) => p.seatIdx !== null);
    if (seated.length !== 4 || !seated.every((p) => p.isReady)) return;

    // Snapshot who sits where before we lock the game state.
    const bySeat: Record<PlayerId, string> = { 0: '', 1: '', 2: '', 3: '' };
    const names: [string, string, string, string] = ['?', '?', '?', '?'];
    for (const p of seated) {
      const s = p.seatIdx as PlayerId;
      bySeat[s] = p.username;
      names[s] = p.displayName;
    }
    this.seatToUsername = bySeat;
    this.game = newGame({ playerNames: names });
    this.started = true;
    // If a bot starts the match, kick off its play loop.
    this.scheduleBotTurnIfNeeded();
  }

  // If it's currently a bot's turn, schedule that bot to act after a short
  // pause so humans see the moves at a natural pace. Repeats until control
  // returns to a human or the match ends.
  private scheduleBotTurnIfNeeded(): void {
    if (!this.started || !this.game) return;
    if (this.game.currentMatch.phase !== 'playing') return;
    const seat = this.game.currentMatch.currentTurn as PlayerId;
    const username = this.seatToUsername[seat];
    const presence = [...this.presences.values()].find((p) => p.username === username);
    if (!presence || !presence.isBot) return;
    setTimeout(() => this.playBotTurn(seat), 900);
  }

  private playBotTurn(seat: PlayerId): void {
    if (!this.started || !this.game) return;
    if (this.game.currentMatch.currentTurn !== seat) return; // turn already changed

    const match = this.game.currentMatch;
    const move = pickBotMove(match, seat);
    if (!move) return;
    let result: { ok: true; match: typeof match } | { ok: false; reason: string };
    switch (move.type) {
      case 'move-draw-stock':
        result = drawStock(match);
        break;
      case 'move-pick-discard':
        result = pickDiscard(match);
        break;
      case 'move-drop-meld':
        result = dropMeld(match, move.input);
        break;
      case 'move-add-to-sequence':
        result = addToSequence(match, move.input);
        break;
      case 'move-add-to-triplet':
        result = addToTriplet(match, move.input);
        break;
      case 'move-joker':
        result = moveJoker(match, move.meldId, move.jokerCardId, move.newActingAs);
        break;
      case 'move-discard':
        result = discard(match, move.cardId);
        break;
      default:
        return;
    }
    if (!result.ok) return; // bot picked an illegal move — bail rather than loop
    this.game = { ...this.game, currentMatch: result.match };
    this.broadcast();
    // Bot may still have more actions this turn (e.g. dropped meld, now needs
    // to discard). Loop until the turn advances or match ends.
    if (this.game.currentMatch.currentTurn === seat) {
      setTimeout(() => this.playBotTurn(seat), 700);
    } else {
      this.scheduleBotTurnIfNeeded();
    }
  }

  // Which seat (PlayerId) the given username occupies, or null.
  private seatFor(username: string): PlayerId | null {
    for (const s of [0, 1, 2, 3] as PlayerId[]) {
      if (this.seatToUsername[s] === username) return s;
    }
    return null;
  }

  private handleMove(msg: MoveMessage, sender: Party.Connection, presence: Presence): void {
    if (!this.started || !this.game) return;
    const mySeat = this.seatFor(presence.username);
    if (mySeat === null) {
      this.sendTo(sender, { type: 'move-rejected', reason: 'You are not seated in this game' });
      return;
    }

    // For a "next-match" message we just advance; other ops must come from the
    // player whose turn it currently is.
    if (msg.type === 'next-match') {
      const match = this.game.currentMatch;
      if (match.phase === 'playing') {
        this.sendTo(sender, { type: 'move-rejected', reason: 'Match is still in progress' });
        return;
      }
      this.game = endMatchAndAdvance(this.game);
      this.broadcast();
      this.scheduleBotTurnIfNeeded();
      return;
    }

    if (mySeat !== this.game.currentMatch.currentTurn) {
      this.sendTo(sender, { type: 'move-rejected', reason: 'Not your turn' });
      return;
    }

    const match = this.game.currentMatch;
    let result: { ok: true; match: typeof match } | { ok: false; reason: string };
    switch (msg.type) {
      case 'move-draw-stock':
        result = drawStock(match);
        break;
      case 'move-pick-discard':
        result = pickDiscard(match);
        break;
      case 'move-drop-meld':
        result = dropMeld(match, msg.input);
        break;
      case 'move-add-to-sequence':
        result = addToSequence(match, msg.input);
        break;
      case 'move-add-to-triplet':
        result = addToTriplet(match, msg.input);
        break;
      case 'move-joker':
        result = moveJoker(match, msg.meldId, msg.jokerCardId, msg.newActingAs);
        break;
      case 'move-discard':
        result = discard(match, msg.cardId);
        break;
      default:
        result = { ok: false, reason: 'Unknown move' };
    }

    if (!result.ok) {
      this.sendTo(sender, { type: 'move-rejected', reason: result.reason });
      return;
    }
    this.game = { ...this.game, currentMatch: result.match };
    this.broadcast();
    this.scheduleBotTurnIfNeeded();
  }

  // ---- Broadcasting -----------------------------------------------------

  private buildRoomState(you: Presence): RoomStateMessage {
    return {
      type: 'room-state',
      roomCode: this.party.id,
      started: this.started,
      you: you.username,
      players: [...this.presences.values()].map(({ connectionId: _c, ...p }) => p),
    };
  }

  private buildGameState(you: Presence): GameStateMessage | null {
    if (!this.game) return null;
    const yourSeat = this.seatFor(you.username);
    const match = this.game.currentMatch;
    const redactedPlayers = {} as typeof match.players;
    const handSizes: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const pid of [0, 1, 2, 3] as PlayerId[]) {
      const p = match.players[pid];
      handSizes[pid] = p.hand.length;
      redactedPlayers[pid] = pid === yourSeat ? p : { ...p, hand: [] };
    }
    const redactedGame: Game = {
      ...this.game,
      currentMatch: { ...match, players: redactedPlayers },
    };
    return { type: 'game-state', game: redactedGame, handSizes, yourSeat };
  }

  private broadcast(): void {
    for (const conn of this.party.getConnections()) {
      const presence = this.presences.get(conn.id);
      if (!presence) continue;
      this.sendTo(conn, this.buildRoomState(presence));
      const gs = this.buildGameState(presence);
      if (gs) this.sendTo(conn, gs);
    }
  }

  private sendTo(conn: Party.Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }
}
