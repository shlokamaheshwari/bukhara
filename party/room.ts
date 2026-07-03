// Room Durable Object — one instance per room code. Holds authoritative game
// state, verifies incoming WebSocket connections against TOKEN_SECRET, and
// broadcasts a redacted game state to everyone. Game logic (rules engine +
// bot) lives in the shared src/game/* and bot.ts modules.

import { DurableObject } from 'cloudflare:workers';
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

type Env = {
  TOKEN_SECRET: string;
  INVITE_CODE: string;
};

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

export class RoomDO extends DurableObject<Env> {
  connections: Map<string, WebSocket> = new Map();
  presences: Map<string, Presence> = new Map();
  started = false;
  game: Game | null = null;
  seatToUsername: Record<PlayerId, string | null> = { 0: null, 1: null, 2: null, 3: null };
  roomCode = '';
  loaded = false;

  // Restore persisted state on first access so a deploy or DO restart doesn't
  // wipe an in-progress game.
  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const stored = await this.ctx.storage.get<{
      started: boolean;
      game: Game | null;
      seatToUsername: Record<PlayerId, string | null>;
      presences: Presence[]; // seat-holding entries so bots + seat claims survive
      roomCode: string;
    }>('state');
    if (!stored) return;
    this.started = stored.started;
    this.game = stored.game;
    this.seatToUsername = stored.seatToUsername;
    this.roomCode = stored.roomCode;
    // Rebuild presence map — restored humans start offline until they reconnect.
    for (const p of stored.presences) {
      this.presences.set(p.connectionId, {
        ...p,
        online: p.isBot, // bots are always online; humans wait to reconnect
      });
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', {
      started: this.started,
      game: this.game,
      seatToUsername: this.seatToUsername,
      // Only persist seat-holders — non-seated observers are ephemeral.
      presences: [...this.presences.values()].filter((p) => p.seatIdx !== null),
      roomCode: this.roomCode,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ctx.blockConcurrencyWhile(() => this.loadState());

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) return new Response('Missing token', { status: 401 });
    const payload = await verifyToken(token, this.env.TOKEN_SECRET);
    if (!payload || typeof payload.username !== 'string') {
      return new Response('Invalid or expired token', { status: 401 });
    }
    const username = String(payload.username);
    const displayName = String(payload.displayName ?? payload.username);

    // The room code is baked into the URL path. Cache it so state broadcasts
    // include it (clients display it in the lobby UI).
    const match = url.pathname.match(/\/parties\/main\/([^/]+)/);
    if (match) this.roomCode = match[1].toLowerCase();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const connId = crypto.randomUUID();
    this.connections.set(connId, server);

    this.onConnect(connId, username, displayName);

    server.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.onMessage(event.data, connId);
    });
    server.addEventListener('close', () => this.onClose(connId));
    server.addEventListener('error', () => this.onClose(connId));

    return new Response(null, { status: 101, webSocket: client });
  }

  private onConnect(connId: string, username: string, displayName: string): void {
    // If the same user already had a connection, migrate their presence.
    const previous = [...this.presences.values()].find((p) => p.username === username);
    const presence: Presence = {
      connectionId: connId,
      username,
      displayName: previous?.displayName ?? displayName,
      seatIdx: previous?.seatIdx ?? null,
      avatarUrl: previous?.avatarUrl ?? null,
      isReady: previous?.isReady ?? false,
      online: true,
      isBot: false,
    };
    if (previous) this.presences.delete(previous.connectionId);
    this.presences.set(connId, presence);
    this.broadcast();
  }

  private onClose(connId: string): void {
    this.connections.delete(connId);
    const presence = this.presences.get(connId);
    if (!presence) return;
    presence.online = false;
    this.broadcast();
    // If not in a game yet, fully evict after a grace period.
    if (!this.started) {
      setTimeout(() => {
        const still = this.presences.get(connId);
        if (still && !still.online) {
          this.presences.delete(connId);
          this.broadcast();
        }
      }, 15_000);
    }
  }

  private onMessage(raw: string, senderId: string): void {
    let data: ClientMessage;
    try { data = JSON.parse(raw) as ClientMessage; } catch { return; }
    const presence = this.presences.get(senderId);
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
      case 'react': {
        // Ephemeral — not persisted. Rebroadcast to every open socket so all
        // players see the emoji fly up from the sender's seat.
        const emoji = String(data.emoji ?? '').slice(0, 8);
        if (!emoji) return; // discard
        const seat = presence.seatIdx as 0 | 1 | 2 | 3 | null;
        for (const ws of this.connections.values()) {
          this.sendTo(ws, {
            type: 'reaction',
            emoji,
            fromUsername: presence.username,
            fromDisplayName: presence.displayName,
            fromSeat: seat,
            at: Date.now(),
          });
        }
        return; // no broadcast, no persist
      }
      case 'chat': {
        // Ephemeral chat — echoed to every open socket, not persisted. Server
        // clamps length so a runaway client can't spam huge payloads.
        const text = String(data.text ?? '').slice(0, 500).trim();
        if (!text) return;
        const seat = presence.seatIdx as 0 | 1 | 2 | 3 | null;
        const now = Date.now();
        const id = `chat-${now}-${Math.random().toString(36).slice(2, 8)}`;
        for (const ws of this.connections.values()) {
          this.sendTo(ws, {
            type: 'chat-message',
            id,
            text,
            fromUsername: presence.username,
            fromDisplayName: presence.displayName,
            fromSeat: seat,
            at: now,
          });
        }
        return;
      }
      default:
        this.handleMove(data as MoveMessage, senderId, presence);
        return;
    }
    this.broadcast();
  }

  private addBot(seatIdx: 0 | 1 | 2 | 3): void {
    const id = `bot-${seatIdx}`;
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
    this.scheduleBotTurnIfNeeded();
  }

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
    if (this.game.currentMatch.currentTurn !== seat) return;

    const match = this.game.currentMatch;
    const move = pickBotMove(match, seat);
    if (!move) return;
    let result: { ok: true; match: typeof match } | { ok: false; reason: string };
    switch (move.type) {
      case 'move-draw-stock': result = drawStock(match); break;
      case 'move-pick-discard': result = pickDiscard(match); break;
      case 'move-drop-meld': result = dropMeld(match, move.input); break;
      case 'move-add-to-sequence': result = addToSequence(match, move.input); break;
      case 'move-add-to-triplet': result = addToTriplet(match, move.input); break;
      case 'move-joker': result = moveJoker(match, move.meldId, move.jokerCardId, move.newActingAs); break;
      case 'move-discard': result = discard(match, move.cardId); break;
      default: return;
    }
    if (!result.ok) return;
    this.game = { ...this.game, currentMatch: result.match };
    this.broadcast();
    if (this.game.currentMatch.currentTurn === seat) {
      setTimeout(() => this.playBotTurn(seat), 700);
    } else {
      this.scheduleBotTurnIfNeeded();
    }
  }

  private seatFor(username: string): PlayerId | null {
    for (const s of [0, 1, 2, 3] as PlayerId[]) {
      if (this.seatToUsername[s] === username) return s;
    }
    return null;
  }

  private handleMove(msg: MoveMessage, senderId: string, presence: Presence): void {
    const senderWs = this.connections.get(senderId);
    if (!this.started || !this.game) return;
    const mySeat = this.seatFor(presence.username);
    if (mySeat === null) {
      if (senderWs) this.sendTo(senderWs, { type: 'move-rejected', reason: 'You are not seated in this game' });
      return;
    }

    if (msg.type === 'next-match') {
      const m = this.game.currentMatch;
      if (m.phase === 'playing') {
        if (senderWs) this.sendTo(senderWs, { type: 'move-rejected', reason: 'Match is still in progress' });
        return;
      }
      this.game = endMatchAndAdvance(this.game);
      this.broadcast();
      this.scheduleBotTurnIfNeeded();
      return;
    }

    if (mySeat !== this.game.currentMatch.currentTurn) {
      if (senderWs) this.sendTo(senderWs, { type: 'move-rejected', reason: 'Not your turn' });
      return;
    }

    const match = this.game.currentMatch;
    let result: { ok: true; match: typeof match } | { ok: false; reason: string };
    switch (msg.type) {
      case 'move-draw-stock': result = drawStock(match); break;
      case 'move-pick-discard': result = pickDiscard(match); break;
      case 'move-drop-meld': result = dropMeld(match, msg.input); break;
      case 'move-add-to-sequence': result = addToSequence(match, msg.input); break;
      case 'move-add-to-triplet': result = addToTriplet(match, msg.input); break;
      case 'move-joker': result = moveJoker(match, msg.meldId, msg.jokerCardId, msg.newActingAs); break;
      case 'move-discard': result = discard(match, msg.cardId); break;
      default: result = { ok: false, reason: 'Unknown move' };
    }

    if (!result.ok) {
      if (senderWs) this.sendTo(senderWs, { type: 'move-rejected', reason: result.reason });
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
      roomCode: this.roomCode,
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
    // Persist first (fire-and-forget), then push to every socket.
    this.saveState().catch(() => { /* best-effort */ });
    for (const [connId, ws] of this.connections.entries()) {
      const presence = this.presences.get(connId);
      if (!presence) continue;
      this.sendTo(ws, this.buildRoomState(presence));
      const gs = this.buildGameState(presence);
      if (gs) this.sendTo(ws, gs);
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* connection dropped */ }
  }
}
