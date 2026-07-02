import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type {
  Card,
  Game,
  Match,
  Meld,
  PlayerId,
  SeqPos,
  SequenceMeldCard,
  TripletMeldCard,
} from '../game/types';
import { TEAM_OF } from '../game/types';
import { newGame } from '../game/newGame';
import {
  addToSequence,
  addToTriplet,
  discard,
  drawStock,
  dropMeld,
  moveJoker,
  pickDiscard,
} from '../game/moves';
import { cardLabel } from '../game/deck';
import { endMatchAndAdvance } from '../game/matchEnd';
import { isPure } from '../game/melds';
import { meldCardTotal, meldSizeBonus, scoreBreakdown } from '../game/scoring';
import { CardFace, StackedCards } from '../ui/Card';
import { autoSolveAdd, autoSolveDropSequence, autoSolveDropTriplet } from '../game/autoSolve';
import type { MoveMessage } from '../net/messages';
import '../ui/Card.css';
import '../App.css';

type MeldModalMode =
  | { kind: 'drop-sequence'; cardIds: string[] }
  | { kind: 'drop-triplet'; cardIds: string[] }
  | { kind: 'add-to-sequence'; meldId: string; cardIds: string[] }
  | { kind: 'add-to-triplet'; meldId: string; cardIds: string[] }
  | { kind: 'move-joker'; meldId: string; jokerCardId: string };

type MoveResult = { ok: true; match: Match } | { ok: false; reason: string };

// Which player has "revealed" their hand on this device. In hot-seat mode, the
// device is passed physically between turns; the gate ensures the next player
// intentionally reveals before we render their cards.
type RevealState = { revealedFor: PlayerId | null };

// Per-player visual arrangement of the hand into groups. Each group is an
// ordered list of card IDs. Cards not yet placed (freshly drawn) auto-append
// to the first group.
type HandLayout = string[][];

export type GameScreenProps = {
  // Local hot-seat mode: game runs entirely client-side.
  playerNames?: [string, string, string, string];
  onExit?: () => void;

  // Multiplayer mode: game state is authoritative on the server. All move
  // handlers dispatch a message via `netSend`; the server responds with a
  // fresh `netGame` prop.
  netGame?: Game;
  netHandSizes?: Record<0 | 1 | 2 | 3, number>;
  netYourSeat?: PlayerId;
  netSend?: (msg: MoveMessage) => void;
  netMoveError?: string | null;
};

const DEFAULT_NAMES: [string, string, string, string] = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];

export default function GameScreen(props: GameScreenProps = {}) {
  const { playerNames, onExit, netGame, netYourSeat, netSend, netMoveError } = props;
  const isMP = netGame !== undefined && netSend !== undefined && netYourSeat !== undefined;
  const initialNames = playerNames ?? DEFAULT_NAMES;

  // Solo game lives in local state; multiplayer game comes from the prop.
  const [soloGame, setSoloGame] = useState<Game>(() => newGame({ playerNames: initialNames }));
  const game: Game = isMP ? netGame! : soloGame;
  function setGame(next: Game) {
    if (!isMP) setSoloGame(next);
    // In MP the server owns state; local writes are ignored.
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);
  const [meldModal, setMeldModal] = useState<MeldModalMode | null>(null);
  const [reveal, setReveal] = useState<RevealState>({ revealedFor: 0 });
  const [layouts, setLayouts] = useState<Record<PlayerId, HandLayout>>({
    0: [[]], 1: [[]], 2: [[]], 3: [[]],
  });
  const [showSetup, setShowSetup] = useState(!isMP && !playerNames);
  const [showDiscardPile, setShowDiscardPile] = useState(false);
  // Match-end modal is shown automatically when the match ends and hidden
  // when the user clicks "Next match" (or after they've dismissed it).
  const [dismissedMatchEnd, setDismissedMatchEnd] = useState<number | null>(null);
  // Show a floating banner when someone picks up the bhukara.
  const [bhukaraAnnouncement, setBhukaraAnnouncement] = useState<string | null>(null);

  const match = game.currentMatch;
  // Whose "view" is at the bottom of the table:
  //   - Multiplayer: always YOU
  //   - Solo: whoever's turn it is (hot-seat)
  const viewingSeat: PlayerId = isMP ? netYourSeat! : match.currentTurn;
  const viewingPlayer = match.players[viewingSeat];
  const isYourTurn = viewingSeat === match.currentTurn;
  // The one place to show move errors — either local (solo) or server-provided (MP).
  const error = isMP ? netMoveError ?? null : localError;
  const setError = (e: string | null) => { if (!isMP) setLocalError(e); };

  // Clear selection whenever the server sends a fresh game state — the move
  // we sent was applied.
  useEffect(() => {
    if (isMP) setSelected(new Set());
  }, [isMP, netGame]);

  function apply(result: MoveResult) {
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
    const nextMatch = result.match;
    const turnChanged = nextMatch.currentTurn !== match.currentTurn;
    setGame({ ...game, currentMatch: nextMatch });
    setSelected(new Set());
    if (turnChanged && !isMP) {
      // Solo mode only: pass-and-play reveal gate.
      setReveal({ revealedFor: null });
    }
  }

  // Detect a fresh bhukara pickup — flash a banner for a few seconds.
  const prevBhukaraTakenBy = useRef<number | null>(null);
  useEffect(() => {
    const now = match.bhukaraTakenBy;
    if (now !== null && now !== prevBhukaraTakenBy.current) {
      const who = match.players[now]?.name ?? `Player ${now + 1}`;
      const team = match.players[now]?.teamId ?? '?';
      setBhukaraAnnouncement(`${who} picked up the Bukhara — Team ${team} +50`);
      const t = setTimeout(() => setBhukaraAnnouncement(null), 4000);
      return () => clearTimeout(t);
    }
    prevBhukaraTakenBy.current = now;
  }, [match.bhukaraTakenBy, match.players]);

  // When the match number advances, clear the previous dismiss.
  useEffect(() => {
    setDismissedMatchEnd(null);
  }, [match.matchNumber]);

  function toggleSelect(cardId: string) {
    const next = new Set(selected);
    if (next.has(cardId)) next.delete(cardId);
    else next.add(cardId);
    setSelected(next);
    setError(null);
  }

  function onDraw() {
    if (isMP) return netSend!({ type: 'move-draw-stock' });
    apply(drawStock(match));
  }
  function onPickDiscard() {
    if (isMP) return netSend!({ type: 'move-pick-discard' });
    apply(pickDiscard(match));
  }
  function onStartDropSequence() {
    if (selected.size < 3) return setError('Select at least 3 cards');
    const cardIds = [...selected];
    const cards = cardIds
      .map((id) => viewingPlayer.hand.find((c) => c.id === id))
      .filter((c): c is Card => !!c);
    const solved = autoSolveDropSequence(cards);
    if (solved.kind === 'sequence') {
      // Unambiguous — drop directly.
      const input = { kind: 'sequence' as const, cards: solved.cards };
      if (isMP) netSend!({ type: 'move-drop-meld', input });
      else apply(dropMeld(match, input));
      return;
    }
    // Ambiguous or unclear — fall back to the manual picker.
    setMeldModal({ kind: 'drop-sequence', cardIds });
  }
  function onStartDropTriplet() {
    if (selected.size < 3) return setError('Select at least 3 cards');
    const cardIds = [...selected];
    const cards = cardIds
      .map((id) => viewingPlayer.hand.find((c) => c.id === id))
      .filter((c): c is Card => !!c);
    const solved = autoSolveDropTriplet(cards);
    if (solved.kind === 'triplet') {
      const input = { kind: 'triplet' as const, cards: solved.cards };
      if (isMP) netSend!({ type: 'move-drop-meld', input });
      else apply(dropMeld(match, input));
      return;
    }
    setMeldModal({ kind: 'drop-triplet', cardIds });
  }
  function onDiscard() {
    if (selected.size !== 1) return setError('Select exactly one card to discard');
    if (isMP) return netSend!({ type: 'move-discard', cardId: [...selected][0] });
    apply(discard(match, [...selected][0]));
  }
  function onNextMatch() {
    if (isMP) return netSend!({ type: 'next-match' });
    setGame(endMatchAndAdvance(game));
    setSelected(new Set());
    setError(null);
    setReveal({ revealedFor: game.currentMatch.startingPlayer });
  }
  function onNewGame() {
    // In multiplayer we return to the room lobby; in solo we prompt for names.
    if (onExit) onExit();
    else setShowSetup(true);
  }

  function onSetupSubmit(names: [string, string, string, string]) {
    const g = newGame({ playerNames: names });
    setGame(g);
    setSelected(new Set());
    setError(null);
    setLayouts({ 0: [[]], 1: [[]], 2: [[]], 3: [[]] });
    setReveal({ revealedFor: g.currentMatch.startingPlayer });
    setShowSetup(false);
  }
  function beginAddTo(meld: Meld) {
    if (selected.size < 1) return setError('Select cards from your hand first');
    setMeldModal(
      meld.kind === 'sequence'
        ? { kind: 'add-to-sequence', meldId: meld.id, cardIds: [...selected] }
        : { kind: 'add-to-triplet', meldId: meld.id, cardIds: [...selected] },
    );
  }
  function beginMoveJoker(meldId: string, jokerCardId: string) {
    setMeldModal({ kind: 'move-joker', meldId, jokerCardId });
  }

  // Drag a hand card onto an existing meld. Auto-solver figures out the intent
  // when it's unambiguous; otherwise we fall back to the pick-a-slot modal
  // (single-card preselected).
  function onDropCardOnMeld(meld: Meld, cardId: string) {
    if (!isYourTurn || match.turnPhase !== 'may-meld') return;
    const myTeam = TEAM_OF[viewingSeat];
    const meldIsOnMyTeam = match.teams[myTeam].sequenceBox.some((m) => m.id === meld.id);
    if (!meldIsOnMyTeam) return;
    const card = viewingPlayer.hand.find((c) => c.id === cardId);
    if (!card) return;

    const solved = autoSolveAdd(card, meld);
    if (solved.kind === 'no-fit') {
      setError("That card doesn't fit this meld.");
      return;
    }
    if (solved.kind === 'ambiguous') {
      // Fall back to the manual picker with just this card preselected.
      setSelected(new Set([cardId]));
      setMeldModal(
        meld.kind === 'sequence'
          ? { kind: 'add-to-sequence', meldId: meld.id, cardIds: [cardId] }
          : { kind: 'add-to-triplet', meldId: meld.id, cardIds: [cardId] },
      );
      return;
    }
    if (solved.kind === 'sequence') {
      if (isMP) {
        netSend!({
          type: 'move-add-to-sequence',
          input: {
            meldId: meld.id,
            additions: solved.additions,
            cardReassignments: solved.reassignments,
          },
        });
      } else {
        apply(addToSequence(match, {
          meldId: meld.id,
          additions: solved.additions,
          cardReassignments: solved.reassignments,
        }));
      }
      return;
    }
    if (solved.kind === 'triplet') {
      if (isMP) {
        netSend!({
          type: 'move-add-to-triplet',
          input: { meldId: meld.id, additions: solved.additions },
        });
      } else {
        apply(addToTriplet(match, {
          meldId: meld.id,
          additions: solved.additions,
        }));
      }
    }
  }

  // Pass-and-play reveal gate applies to solo only. Multiplayer always shows your hand.
  const isRevealed = isMP ? true : reveal.revealedFor === match.currentTurn;
  const matchOver = match.phase !== 'playing';
  const currentPlayer = match.players[match.currentTurn];

  return (
    <div className="table-app">
      <header className="topbar">
        <h1>Bukhara</h1>
        <div className="scores">
          <div className={`score-chip team-a`}>
            Team A · {game.teams.A.totalScore}
          </div>
          <div className={`score-chip team-b`}>
            Team B · {game.teams.B.totalScore}
          </div>
          <div className="match-chip">Match {match.matchNumber}</div>
          {game.winner && <div className="winner-chip">🏆 Team {game.winner}</div>}
          <button className="minor" onClick={onNewGame}>New game</button>
        </div>
      </header>

      <div className="table">
        {/* Bhukara pile lives off to the side of the main play area. */}
        <div className="bhukara-side">
          <div className="pile-label">
            Bukhara ({match.bhukaraTakenBy === null ? match.bhukara.length : 'taken'})
          </div>
          {match.bhukaraTakenBy === null ? (
            <StackedCards count={match.bhukara.length} />
          ) : (
            <div className="bhukara-taken">
              Taken by {match.players[match.bhukaraTakenBy].name}
            </div>
          )}
        </div>
        {/* Seats rotate so the current player is always at the bottom.
            Clockwise order from bottom: bottom → right → top → left. */}
        <div className="seat seat-top">
          <SeatSummary
            player={match.players[seatAt(viewingSeat, 'top')]}
            isTurn={match.currentTurn === seatAt(viewingSeat, 'top')}
            label="Partner"
            handSize={props.netHandSizes?.[seatAt(viewingSeat, 'top')]}
          />
        </div>
        <div className="seat seat-left">
          <SeatSummary
            player={match.players[seatAt(viewingSeat, 'left')]}
            isTurn={match.currentTurn === seatAt(viewingSeat, 'left')}
            vertical
            label="Opponent"
            handSize={props.netHandSizes?.[seatAt(viewingSeat, 'left')]}
          />
        </div>
        <div className="seat seat-right">
          <SeatSummary
            player={match.players[seatAt(viewingSeat, 'right')]}
            isTurn={match.currentTurn === seatAt(viewingSeat, 'right')}
            vertical
            label="Opponent"
            handSize={props.netHandSizes?.[seatAt(viewingSeat, 'right')]}
          />
        </div>

        {/* Center: table felt with piles and sequence boxes */}
        <div className="table-center">
          <div className="piles">
            <div className="pile">
              <div className="pile-label">Draw pile ({match.stock.length})</div>
              <StackedCards count={match.stock.length} />
            </div>
            <div
              className={`pile discard-pile ${match.discard.length > 0 ? 'clickable' : ''}`}
              onClick={() => match.discard.length > 0 && setShowDiscardPile(true)}
              title={match.discard.length > 0 ? 'Click to see all discarded cards' : ''}
            >
              <div className="pile-label">Discard pile ({match.discard.length})</div>
              <div className="discard-fan">
                {match.discard.length === 0 && <div className="empty-slot" />}
                {match.discard.map((c, i) => (
                  <div key={c.id} className="discard-slot" style={{ marginLeft: i === 0 ? 0 : -30 }}>
                    <CardFace card={c} size="sm" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="team-boxes">
            <TeamBox team="A" match={match} viewingSeat={viewingSeat} isYourTurn={isYourTurn} onAddTo={beginAddTo} onMoveJoker={beginMoveJoker} onDropCardOnMeld={onDropCardOnMeld} />
            <TeamBox team="B" match={match} viewingSeat={viewingSeat} isYourTurn={isYourTurn} onAddTo={beginAddTo} onMoveJoker={beginMoveJoker} onDropCardOnMeld={onDropCardOnMeld} />
          </div>

          <div className="turn-status">
            <strong>{currentPlayer.name}'s turn</strong> · Team {currentPlayer.teamId} · <code>{match.turnPhase}</code>
            {matchOver && ` · Match ${match.phase}`}
          </div>
          {error && <div className="table-error">⚠ {error}</div>}
        </div>

        {/* Bottom: current player's hand (revealed via gate) */}
        <div className="seat seat-bottom">
          {isRevealed ? (
            <>
              <ActionsToolbar
                match={match}
                selectedCount={selected.size}
                canAct={isYourTurn}
                onDraw={onDraw}
                onPickDiscard={onPickDiscard}
                onDropSequence={onStartDropSequence}
                onDropTriplet={onStartDropTriplet}
                onDiscard={onDiscard}
                onNextMatch={onNextMatch}
                showNextMatch={matchOver && !game.winner}
              />
              <CurrentHand
                player={viewingPlayer}
                selected={selected}
                onToggle={toggleSelect}
                layout={layouts[viewingSeat]}
                setLayout={(next) =>
                  setLayouts((l) => ({ ...l, [viewingSeat]: next }))
                }
              />
            </>
          ) : (
            !isMP && (
              <div className="reveal-gate">
                <div className="reveal-inner">
                  <div className="reveal-text">
                    Pass the device to <strong>{currentPlayer.name}</strong>
                  </div>
                  <button
                    className="reveal-btn"
                    onClick={() => setReveal({ revealedFor: match.currentTurn })}
                  >
                    I'm {currentPlayer.name} — reveal my hand
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {meldModal && (
        <MeldModal
          mode={meldModal}
          match={match}
          onClose={() => setMeldModal(null)}
          onSubmit={(action) => {
            setMeldModal(null);
            apply(action());
          }}
          onMultiplayerSubmit={
            isMP
              ? (msg) => {
                  setMeldModal(null);
                  netSend!(msg);
                }
              : undefined
          }
        />
      )}

      {showSetup && !isMP && (
        <SetupModal
          currentNames={[
            match.players[0].name,
            match.players[1].name,
            match.players[2].name,
            match.players[3].name,
          ]}
          onStart={onSetupSubmit}
        />
      )}

      {showDiscardPile && (
        <DiscardPileModal
          cards={match.discard}
          onClose={() => setShowDiscardPile(false)}
        />
      )}

      {bhukaraAnnouncement && (
        <div className="announcement-banner">
          <div className="announcement-emoji">🎴</div>
          <div className="announcement-text">{bhukaraAnnouncement}</div>
        </div>
      )}

      {matchOver && dismissedMatchEnd !== match.matchNumber && (
        <MatchEndModal
          game={game}
          match={match}
          onClose={() => setDismissedMatchEnd(match.matchNumber)}
          onNextMatch={game.winner ? undefined : () => {
            setDismissedMatchEnd(match.matchNumber);
            onNextMatch();
          }}
        />
      )}
    </div>
  );
}

// Shows the final scores when a match ends. Breaks down each team's total
// so you can see exactly how the number came together — melds + bonuses -
// held cards. Also shows the running series total after this match.
function MatchEndModal({
  game,
  match,
  onClose,
  onNextMatch,
}: {
  game: Game;
  match: Match;
  onClose: () => void;
  onNextMatch?: () => void;
}) {
  const heldByTeam: Record<'A' | 'B', number> = { A: 0, B: 0 };
  for (const pid of [0, 1, 2, 3] as PlayerId[]) {
    const t = TEAM_OF[pid];
    for (const c of match.players[pid].hand) {
      heldByTeam[t] += cardValueOf(c.rank);
    }
  }
  const bhukaraTeam = match.bhukaraTakenBy !== null ? TEAM_OF[match.bhukaraTakenBy] : null;
  const closerTeam = match.closedBy !== null ? TEAM_OF[match.closedBy] : null;
  const voidMatch = match.phase === 'ended-void';

  const teamRow = (t: 'A' | 'B') => {
    const b = scoreBreakdown({
      melds: match.teams[t].sequenceBox,
      bhukaraPicked: bhukaraTeam === t,
      closedMatch: closerTeam === t,
      ownHeldCardValues: heldByTeam[t],
    });
    return { team: t, ...b };
  };
  const rows = voidMatch
    ? null
    : { A: teamRow('A'), B: teamRow('B') };

  const totalsAfter = {
    A: game.teams.A.totalScore + (voidMatch ? 0 : rows!.A.total),
    B: game.teams.B.totalScore + (voidMatch ? 0 : rows!.B.total),
  };
  const winnerThisHand = voidMatch
    ? null
    : rows!.A.total === rows!.B.total
      ? 'Tie'
      : rows!.A.total > rows!.B.total ? 'A' : 'B';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content match-end-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Match {match.matchNumber} — {voidMatch ? 'Void' : winnerThisHand === 'Tie' ? 'Tied' : `Team ${winnerThisHand} takes it`}
        </h2>
        <p className="hint">
          {voidMatch
            ? 'The stock ran out before anyone closed. No score change; the deck is reshuffled for the next match.'
            : `${match.closedBy !== null ? match.players[match.closedBy].name : 'Someone'} closed the match. Below is the full tally — cards in your melds add, cards still in hand subtract.`}
        </p>

        {rows && (
          <table className="match-end-table">
            <thead>
              <tr>
                <th>Team</th>
                <th>Meld cards</th>
                <th>7-card bonus</th>
                <th>Bukhara</th>
                <th>Closing</th>
                <th>Held (−)</th>
                <th>This match</th>
                <th>Running total</th>
              </tr>
            </thead>
            <tbody>
              {(['A', 'B'] as const).map((t) => (
                <tr key={t} className={`team-${t.toLowerCase()} ${winnerThisHand === t ? 'winner' : ''}`}>
                  <td>Team {t}</td>
                  <td>{rows[t].meldCards}</td>
                  <td>{rows[t].sizeBonuses}</td>
                  <td>{rows[t].bhukaraBonus}</td>
                  <td>{rows[t].closingBonus}</td>
                  <td>−{rows[t].heldPenalty}</td>
                  <td className={rows[t].total >= 0 ? 'pos' : 'neg'}>{rows[t].total >= 0 ? '+' : ''}{rows[t].total}</td>
                  <td className="running">{totalsAfter[t]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {game.winner && (
          <div className="game-winner">🏆 Team {game.winner} wins the series</div>
        )}

        <div className="modal-buttons">
          {onNextMatch && (
            <button className="primary" onClick={onNextMatch}>
              Start next match →
            </button>
          )}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Small local helper so the match-end modal doesn't need extra imports.
function cardValueOf(rank: number): number {
  if (rank === 1) return 15;
  if (rank === 2) return 10;
  if (rank >= 3 && rank <= 7) return 5;
  return 10;
}

// Shows every card in the discard pile, oldest first, most-recent last.
// Purely informational — no interaction beyond dismiss.
function DiscardPileModal({
  cards,
  onClose,
}: {
  cards: Card[];
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content discard-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Discard pile · {cards.length} card{cards.length === 1 ? '' : 's'}</h2>
        <p className="hint">
          Oldest at the top-left, most-recent at the bottom-right. Picking the discard pile takes them all.
        </p>
        <div className="discard-grid">
          {cards.map((c, i) => (
            <div key={c.id} className="discard-grid-card">
              <span className="discard-grid-index">#{i + 1}</span>
              <CardFace card={c} size="md" />
              {i === cards.length - 1 && <span className="discard-grid-newest">Top</span>}
            </div>
          ))}
        </div>
        <div className="modal-buttons">
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Full-screen setup modal shown on first load and when starting a new game.
// The user names all four players; those names show up in seats, reveals, and
// meld boxes throughout the session.
function SetupModal({
  currentNames,
  onStart,
}: {
  currentNames: [string, string, string, string];
  onStart: (names: [string, string, string, string]) => void;
}) {
  const [names, setNames] = useState<[string, string, string, string]>(currentNames);
  const trimmed = names.map((n) => n.trim()) as [string, string, string, string];
  const allFilled = trimmed.every((n) => n.length > 0);
  const seatSlots: { id: PlayerId; role: string; team: 'A' | 'B' }[] = [
    { id: 0, role: 'Player 1', team: 'A' },
    { id: 1, role: 'Player 2', team: 'B' },
    { id: 2, role: 'Player 3 (P1\'s partner)', team: 'A' },
    { id: 3, role: 'Player 4 (P2\'s partner)', team: 'B' },
  ];
  return (
    <div className="modal-backdrop">
      <div className="modal-content setup-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Who's playing?</h2>
        <p className="hint">
          Enter names for all four players. Teams are fixed: <strong style={{ color: '#4287f5' }}>Team A</strong> plays
          against <strong style={{ color: '#f56042' }}>Team B</strong>. Partners sit across from each other.
        </p>
        <div className="setup-seats">
          {seatSlots.map((slot) => (
            <div key={slot.id} className={`setup-seat team-${slot.team.toLowerCase()}`}>
              <div className="setup-seat-role">{slot.role}</div>
              <input
                type="text"
                value={names[slot.id]}
                onChange={(e) => {
                  const copy = [...names] as [string, string, string, string];
                  copy[slot.id] = e.target.value;
                  setNames(copy);
                }}
                placeholder={`Player ${slot.id + 1}`}
                maxLength={20}
              />
              <div className="setup-seat-team">Team {slot.team}</div>
            </div>
          ))}
        </div>
        <div className="modal-buttons">
          <button
            className="primary"
            disabled={!allFilled}
            onClick={() => onStart(trimmed)}
          >
            Start game
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionsToolbar({
  match,
  selectedCount,
  canAct,
  onDraw,
  onPickDiscard,
  onDropSequence,
  onDropTriplet,
  onDiscard,
  onNextMatch,
  showNextMatch,
}: {
  match: Match;
  selectedCount: number;
  canAct: boolean; // false = it's not your turn; all action buttons stay disabled
  onDraw: () => void;
  onPickDiscard: () => void;
  onDropSequence: () => void;
  onDropTriplet: () => void;
  onDiscard: () => void;
  onNextMatch: () => void;
  showNextMatch: boolean;
}) {
  const canDraw = canAct && match.turnPhase === 'awaiting-draw' && match.stock.length > 0;
  const canPick = canAct && match.turnPhase === 'awaiting-draw' && match.discard.length > 0;
  const canMeld = canAct && match.turnPhase === 'may-meld';
  const canDiscard = canAct && match.turnPhase === 'may-meld' && selectedCount === 1;
  const canDropMeld = canMeld && selectedCount >= 3;

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <span className="toolbar-label">Draw</span>
        <button className="tb-btn" onClick={onDraw} disabled={!canDraw}>
          <span className="tb-icon">↓</span> Stock ({match.stock.length})
        </button>
        <button className="tb-btn" onClick={onPickDiscard} disabled={!canPick}>
          <span className="tb-icon">↩</span> Discard ({match.discard.length})
        </button>
      </div>

      <div className="toolbar-group">
        <span className="toolbar-label">Meld</span>
        <button className="tb-btn" onClick={onDropSequence} disabled={!canDropMeld}>
          Sequence
        </button>
        <button className="tb-btn" onClick={onDropTriplet} disabled={!canDropMeld}>
          Triplet
        </button>
      </div>

      <div className="toolbar-group toolbar-right">
        <span className={`selected-count ${selectedCount > 0 ? 'active' : ''}`}>
          {selectedCount} selected
        </span>
        <button className="tb-btn tb-primary" onClick={onDiscard} disabled={!canDiscard}>
          Discard & end turn
        </button>
        {showNextMatch && (
          <button className="tb-btn tb-primary" onClick={onNextMatch}>
            Next match →
          </button>
        )}
      </div>
    </div>
  );
}

function SeatSummary({
  player,
  isTurn,
  vertical,
  label,
  handSize,
}: {
  player: { id: PlayerId; name: string; teamId: 'A' | 'B'; hand: Card[] };
  isTurn: boolean;
  vertical?: boolean;
  label?: string;
  handSize?: number; // authoritative count from server (hand itself is redacted for opponents)
}) {
  const initials = player.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'P?';
  const avatarPalette = {
    A: ['#4287f5', '#5aa3ff'],
    B: ['#f56042', '#ff7f5a'],
  } as const;
  const [dark, light] = avatarPalette[player.teamId];
  return (
    <div className={`seat-summary ${isTurn ? 'seat-active' : ''} ${vertical ? 'seat-vertical' : ''}`}>
      <div className="seat-avatar-wrap">
        <div
          className="seat-avatar"
          style={{
            background: `linear-gradient(135deg, ${light} 0%, ${dark} 100%)`,
          }}
        >
          {initials}
        </div>
        {isTurn && <div className="seat-turn-glow" />}
        <div className={`team-dot team-dot-${player.teamId.toLowerCase()}`} />
      </div>
      <div className="seat-info">
        {label && <div className="seat-role">{label}</div>}
        <div className="seat-name">{player.name}</div>
        <div className="seat-count">
          <span className="dot" /> {handSize ?? player.hand.length} cards
        </div>
      </div>
    </div>
  );
}

// Given the current player's id, returns which player sits at a given seat
// position on the visual table. Bottom is always you; clockwise from there
// goes right → top (partner) → left.
function seatAt(current: PlayerId, position: 'bottom' | 'right' | 'top' | 'left'): PlayerId {
  const offset = { bottom: 0, right: 1, top: 2, left: 3 }[position];
  return ((current + offset) % 4) as PlayerId;
}

// Cards being dragged. When the user starts a drag on a card that's part of
// the current selection (>1), all selected cards travel together.
type DragBundle = { cardIds: string[] };

function CurrentHand({
  player,
  selected,
  onToggle,
  layout,
  setLayout,
}: {
  player: { id: PlayerId; name: string; teamId: 'A' | 'B'; hand: Card[] };
  selected: Set<string>;
  onToggle: (id: string) => void;
  layout: HandLayout;
  setLayout: (l: HandLayout) => void;
}) {
  const cardsById = useMemo(() => {
    const m = new Map<string, Card>();
    for (const c of player.hand) m.set(c.id, c);
    return m;
  }, [player.hand]);

  // Keep the layout in sync with the actual hand: drop absent cards, append new ones.
  useEffect(() => {
    const cleaned = layout
      .map((section) => section.filter((id) => cardsById.has(id)))
      .filter((section) => section.length > 0);
    const known = new Set(cleaned.flat());
    const missing = player.hand.filter((c) => !known.has(c.id)).map((c) => c.id);
    if (missing.length > 0) {
      if (cleaned.length === 0) cleaned.push([]);
      cleaned[0] = [...cleaned[0], ...missing];
    }
    if (cleaned.length === 0) cleaned.push([]);
    const same =
      cleaned.length === layout.length &&
      cleaned.every(
        (s, i) => s.length === layout[i]?.length && s.every((id, j) => id === layout[i][j]),
      );
    if (!same) setLayout(cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.hand]);

  const [dragBundle, setDragBundle] = useState<DragBundle | null>(null);
  // Insertion indicator: which section, which slot within (index), or 'new-at-end' / gap N
  const [dropTarget, setDropTarget] = useState<
    | null
    | { kind: 'in-section'; section: number; index: number }
    | { kind: 'gap-before'; section: number } // gap to the left of this section — new section
    | { kind: 'end' }                          // past the last section
  >(null);

  // Compute the drag bundle at drag start: if the grabbed card is in the
  // selection, take the whole selection; otherwise just that card.
  function bundleFor(cardId: string): DragBundle {
    if (selected.size > 1 && selected.has(cardId)) {
      // Preserve their current order in the layout so they stay coherent.
      const ordered = layout.flat().filter((id) => selected.has(id));
      return { cardIds: ordered };
    }
    return { cardIds: [cardId] };
  }

  function moveBundle(
    bundle: DragBundle,
    target:
      | { kind: 'in-section'; section: number; index: number }
      | { kind: 'gap-before'; section: number }
      | { kind: 'end' },
  ) {
    const bundleSet = new Set(bundle.cardIds);
    const withoutBundle = layout.map((s) => s.filter((id) => !bundleSet.has(id)));
    let next: HandLayout;
    if (target.kind === 'end') {
      next = [...withoutBundle, bundle.cardIds.slice()];
    } else if (target.kind === 'gap-before') {
      const idx = target.section;
      next = [
        ...withoutBundle.slice(0, idx),
        bundle.cardIds.slice(),
        ...withoutBundle.slice(idx),
      ];
    } else {
      next = withoutBundle.map((s, si) => {
        if (si !== target.section) return s;
        const copy = s.slice();
        copy.splice(Math.min(target.index, copy.length), 0, ...bundle.cardIds);
        return copy;
      });
    }
    next = next.filter((s) => s.length > 0);
    if (next.length === 0) next = [bundle.cardIds.slice()];
    setLayout(next);
  }

  function autoSort() {
    const sorted = [...player.hand]
      .sort((a, b) => (a.suit !== b.suit ? a.suit.localeCompare(b.suit) : a.rank - b.rank))
      .map((c) => c.id);
    setLayout([sorted]);
  }

  const endTarget = dragBundle !== null && dropTarget?.kind === 'end';
  const bundleSize = dragBundle?.cardIds.length ?? 0;

  return (
    <div className="current-hand">
      <div className="hand-label">
        <span>
          <strong>{player.name}</strong> · Team {player.teamId} · {player.hand.length} cards
          <span className="hand-hint">
            {' '}· drag cards to reorder or split into groups · select multiple then drag to move them together
          </span>
        </span>
        <button className="ghost-btn" onClick={autoSort}>Auto-sort</button>
      </div>

      <div
        className="hand-strip"
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDropTarget(null)}
      >
        {layout.map((section, sIdx) => (
          <Fragment key={sIdx}>
            {sIdx > 0 && (
              <SectionGap
                active={dragBundle !== null}
                highlighted={dropTarget?.kind === 'gap-before' && dropTarget.section === sIdx}
                bundleSize={bundleSize}
                onOver={() => setDropTarget({ kind: 'gap-before', section: sIdx })}
                onDrop={() => {
                  if (dragBundle) moveBundle(dragBundle, { kind: 'gap-before', section: sIdx });
                  setDropTarget(null);
                  setDragBundle(null);
                }}
              />
            )}
            <HandSection
              cards={section}
              sectionIdx={sIdx}
              cardsById={cardsById}
              selected={selected}
              onToggle={onToggle}
              dragBundle={dragBundle}
              beginDrag={(cardId) => setDragBundle(bundleFor(cardId))}
              endDrag={() => { setDragBundle(null); setDropTarget(null); }}
              dropTarget={dropTarget}
              setDropTarget={setDropTarget}
              onDropAt={(idx) => {
                if (dragBundle) moveBundle(dragBundle, { kind: 'in-section', section: sIdx, index: idx });
                setDropTarget(null);
                setDragBundle(null);
              }}
            />
          </Fragment>
        ))}

        {/* End-of-strip drop target: appears only while dragging, creates a new section at the end. */}
        <div
          className={`end-target ${dragBundle !== null ? 'visible' : ''} ${endTarget ? 'highlighted' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropTarget({ kind: 'end' });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragBundle) moveBundle(dragBundle, { kind: 'end' });
            setDropTarget(null);
            setDragBundle(null);
          }}
        >
          + group{bundleSize > 1 ? ` (${bundleSize} cards)` : ''}
        </div>
      </div>
    </div>
  );
}

function SectionGap({
  active,
  highlighted,
  bundleSize,
  onOver,
  onDrop,
}: {
  active: boolean;
  highlighted: boolean;
  bundleSize: number;
  onOver: () => void;
  onDrop: () => void;
}) {
  return (
    <div
      className={`section-gap ${active ? 'active' : ''} ${highlighted ? 'highlighted' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="section-gap-indicator">
        {highlighted && bundleSize > 1 && <span className="bundle-hint">{bundleSize}</span>}
      </div>
    </div>
  );
}

function HandSection({
  cards,
  sectionIdx,
  cardsById,
  selected,
  onToggle,
  dragBundle,
  beginDrag,
  endDrag,
  dropTarget,
  setDropTarget,
  onDropAt,
}: {
  cards: string[];
  sectionIdx: number;
  cardsById: Map<string, Card>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  dragBundle: DragBundle | null;
  beginDrag: (cardId: string) => void;
  endDrag: () => void;
  dropTarget:
    | null
    | { kind: 'in-section'; section: number; index: number }
    | { kind: 'gap-before'; section: number }
    | { kind: 'end' };
  setDropTarget: (
    v:
      | null
      | { kind: 'in-section'; section: number; index: number }
      | { kind: 'gap-before'; section: number }
      | { kind: 'end' },
  ) => void;
  onDropAt: (idx: number) => void;
}) {
  function onCardDragOver(e: ReactDragEvent, idx: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    setDropTarget({ kind: 'in-section', section: sectionIdx, index: isLeft ? idx : idx + 1 });
  }

  function onCardDrop(e: ReactDragEvent, idx: number) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    onDropAt(isLeft ? idx : idx + 1);
  }

  const activeHoverIndex =
    dropTarget?.kind === 'in-section' && dropTarget.section === sectionIdx
      ? dropTarget.index
      : null;

  const draggingSet = dragBundle ? new Set(dragBundle.cardIds) : null;

  return (
    <div
      className="hand-section"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropAt(cards.length);
      }}
    >
      {cards.map((cardId, idx) => {
        const card = cardsById.get(cardId);
        if (!card) return null;
        const isDragged = draggingSet?.has(cardId) === true;
        return (
          <span key={cardId} className="card-with-indicator">
            {activeHoverIndex === idx && (
              <span className="drop-indicator">
                {dragBundle && dragBundle.cardIds.length > 1 && (
                  <span className="drop-indicator-count">{dragBundle.cardIds.length}</span>
                )}
              </span>
            )}
            <div
              className={`hand-slot ${isDragged ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', cardId);
                e.dataTransfer.effectAllowed = 'move';
                beginDrag(cardId);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => onCardDragOver(e, idx)}
              onDrop={(e) => onCardDrop(e, idx)}
            >
              <CardFace
                card={card}
                size="md"
                selected={selected.has(cardId)}
                onClick={() => onToggle(cardId)}
              />
            </div>
            {idx === cards.length - 1 && activeHoverIndex === cards.length && (
              <span className="drop-indicator">
                {dragBundle && dragBundle.cardIds.length > 1 && (
                  <span className="drop-indicator-count">{dragBundle.cardIds.length}</span>
                )}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function TeamBox({
  team,
  match,
  viewingSeat,
  isYourTurn,
  onAddTo,
  onMoveJoker,
  onDropCardOnMeld,
}: {
  team: 'A' | 'B';
  match: Match;
  viewingSeat: PlayerId;
  isYourTurn: boolean;
  onAddTo: (meld: Meld) => void;
  onMoveJoker: (meldId: string, jokerCardId: string) => void;
  onDropCardOnMeld: (meld: Meld, cardId: string) => void;
}) {
  const state = match.teams[team];
  const canAct = isYourTurn && TEAM_OF[viewingSeat] === team && match.turnPhase === 'may-meld';
  const [hoveredMeld, setHoveredMeld] = useState<string | null>(null);
  return (
    <div className={`team-box team-box-${team.toLowerCase()}`}>
      <div className="team-box-header">
        Team {team} · {state.sequenceBox.length} meld(s)
        {state.mustFirstDropReach100 && !state.firstDropDone && (
          <span className="badge">first drop ≥100</span>
        )}
      </div>
      {state.sequenceBox.length === 0 && <div className="empty-melds">No melds yet</div>}
      {state.sequenceBox.map((m) => (
        <div
          key={m.id}
          className={`meld-strip ${isPure(m) ? 'pure' : 'impure'} ${hoveredMeld === m.id ? 'drop-target' : ''}`}
          onDragOver={canAct ? (e) => { e.preventDefault(); setHoveredMeld(m.id); } : undefined}
          onDragLeave={canAct ? () => setHoveredMeld(null) : undefined}
          onDrop={canAct ? (e) => {
            e.preventDefault();
            setHoveredMeld(null);
            const cardId = e.dataTransfer.getData('text/plain');
            if (cardId) onDropCardOnMeld(m, cardId);
          } : undefined}
        >
          <div className="meld-strip-label">
            {m.kind === 'sequence' ? `Seq ${suitGlyph(m.suit)}` : `Trip ${rankLabel(m.rank)}`} · {meldCardTotal(m)}pt
            {meldSizeBonus(m) > 0 && <span className="bonus"> +{meldSizeBonus(m)}</span>}
            <span className={`meld-purity ${isPure(m) ? 'pure' : 'impure'}`}>
              {isPure(m) ? 'PURE' : 'IMPURE'}
            </span>
          </div>
          <div className="meld-strip-cards">
            {m.cards.map((mc) => (
              <CardFace
                key={mc.card.id}
                card={mc.card}
                size="sm"
                onClick={mc.isJoker && canAct ? () => onMoveJoker(m.id, mc.card.id) : undefined}
                jokerBadge={mc.isJoker && m.kind === 'sequence' && 'actingAs' in mc ? String(mc.actingAs) : undefined}
              />
            ))}
          </div>
          {canAct && (
            <button className="tiny" onClick={() => onAddTo(m)}>Add selected</button>
          )}
        </div>
      ))}
    </div>
  );
}

function suitGlyph(s: string) {
  return { H: '♥', D: '♦', C: '♣', S: '♠' }[s as 'H' | 'D' | 'C' | 'S'];
}
function rankLabel(r: number) {
  return r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r);
}

function findCards(match: Match, ids: string[]): Card[] {
  const p = match.players[match.currentTurn];
  return ids
    .map((id) => p.hand.find((c) => c.id === id))
    .filter((c): c is Card => c !== undefined);
}

function MeldModal({
  mode,
  match,
  onClose,
  onSubmit,
  onMultiplayerSubmit,
}: {
  mode: MeldModalMode;
  match: Match;
  onClose: () => void;
  onSubmit: (action: () => MoveResult) => void;
  onMultiplayerSubmit?: (msg: MoveMessage) => void;
}) {
  if (mode.kind === 'drop-sequence' || mode.kind === 'add-to-sequence') {
    // For add-to-sequence, pass the target meld so the picker can also
    // reposition its jokers atomically with the new additions.
    const targetMeldId = mode.kind === 'add-to-sequence' ? mode.meldId : undefined;
    return (
      <SequencePicker
        cardIds={mode.cardIds}
        match={match}
        targetMeldId={targetMeldId}
        title={mode.kind === 'drop-sequence' ? 'Drop new sequence' : 'Add to sequence'}
        onCancel={onClose}
        onConfirm={(attempt, reassignments) => {
          if (onMultiplayerSubmit) {
            if (mode.kind === 'drop-sequence') {
              onMultiplayerSubmit({ type: 'move-drop-meld', input: { kind: 'sequence', cards: attempt } });
            } else {
              onMultiplayerSubmit({
                type: 'move-add-to-sequence',
                input: { meldId: mode.meldId, additions: attempt, cardReassignments: reassignments },
              });
            }
            return;
          }
          if (mode.kind === 'drop-sequence') {
            onSubmit(() => dropMeld(match, { kind: 'sequence', cards: attempt }));
          } else {
            onSubmit(() => addToSequence(match, {
              meldId: mode.meldId,
              additions: attempt,
              cardReassignments: reassignments,
            }));
          }
        }}
      />
    );
  }
  if (mode.kind === 'drop-triplet' || mode.kind === 'add-to-triplet') {
    return (
      <TripletPicker
        cardIds={mode.cardIds}
        match={match}
        title={mode.kind === 'drop-triplet' ? 'Drop new triplet' : 'Add to triplet'}
        onCancel={onClose}
        onConfirm={(attempt) => {
          if (onMultiplayerSubmit) {
            if (mode.kind === 'drop-triplet') {
              onMultiplayerSubmit({ type: 'move-drop-meld', input: { kind: 'triplet', cards: attempt } });
            } else {
              onMultiplayerSubmit({ type: 'move-add-to-triplet', input: { meldId: mode.meldId, additions: attempt } });
            }
            return;
          }
          if (mode.kind === 'drop-triplet') {
            onSubmit(() => dropMeld(match, { kind: 'triplet', cards: attempt }));
          } else {
            onSubmit(() => addToTriplet(match, { meldId: mode.meldId, additions: attempt }));
          }
        }}
      />
    );
  }
  if (mode.kind === 'move-joker') {
    return (
      <MoveJokerModal
        meldId={mode.meldId}
        jokerCardId={mode.jokerCardId}
        match={match}
        onCancel={onClose}
        onConfirm={(newPos) => {
          if (onMultiplayerSubmit) {
            onMultiplayerSubmit({ type: 'move-joker', meldId: mode.meldId, jokerCardId: mode.jokerCardId, newActingAs: newPos });
            return;
          }
          onSubmit(() => moveJoker(match, mode.meldId, mode.jokerCardId, newPos));
        }}
      />
    );
  }
  return null;
}

function SequencePicker({
  cardIds,
  match,
  title,
  targetMeldId,
  onCancel,
  onConfirm,
}: {
  cardIds: string[];
  match: Match;
  title: string;
  targetMeldId?: string; // set when adding to an existing sequence
  onCancel: () => void;
  onConfirm: (
    attempt: SequenceMeldCard[],
    reassignments?: { cardId: string; newActingAs: SeqPos; newIsJoker: boolean }[],
  ) => void;
}) {
  const cards = useMemo(() => findCards(match, cardIds), [match, cardIds]);
  const [rows, setRows] = useState(() =>
    cards.map((c) => ({
      card: c,
      actingAs: c.rank as SeqPos,
      isJoker: false,
    })),
  );

  // Look up the target meld — user can reinterpret ANY of its cards (natural
  // → joker, joker → different slot, joker → natural) atomically with the
  // add. This is required for swaps like: sequence 2♦,3♦,4♦, add 6♦, want
  // 3♦,4♦,2♦(joker at 5),6♦.
  const targetMeld = useMemo(() => {
    if (!targetMeldId) return null;
    for (const team of ['A', 'B'] as const) {
      const found = match.teams[team].sequenceBox.find((m) => m.id === targetMeldId);
      if (found && found.kind === 'sequence') return found;
    }
    return null;
  }, [match, targetMeldId]);
  // Track a "reinterpreted" view of every existing card in the meld. Defaults
  // to the current role. User can edit slot + joker flag.
  const [existingRows, setExistingRows] = useState<
    { cardId: string; card: Card; actingAs: SeqPos; isJoker: boolean }[]
  >(() =>
    (targetMeld?.cards ?? []).map((c) => ({
      cardId: c.card.id,
      card: c.card,
      actingAs: c.actingAs,
      isJoker: c.isJoker,
    })),
  );

  function update(idx: number, patch: Partial<(typeof rows)[number]>) {
    setRows((r) => r.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function updateExisting(idx: number, patch: Partial<(typeof existingRows)[number]>) {
    setExistingRows((r) => r.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  function submit() {
    const reassignments: {
      cardId: string;
      newActingAs: SeqPos;
      newIsJoker: boolean;
    }[] = [];
    for (const orig of targetMeld?.cards ?? []) {
      const edited = existingRows.find((e) => e.cardId === orig.card.id);
      if (!edited) continue;
      const changed = edited.actingAs !== orig.actingAs || edited.isJoker !== orig.isJoker;
      if (changed) {
        reassignments.push({
          cardId: edited.cardId,
          newActingAs: edited.actingAs,
          newIsJoker: edited.isJoker,
        });
      }
    }
    onConfirm(rows, reassignments.length > 0 ? reassignments : undefined);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="hint">
          Set which slot each card fills. Ace = 1 (low) or 14 (high). Only 2s can act as jokers.
        </p>
        <table>
          <thead><tr><th>Card</th><th>Slot</th><th>Joker?</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.card.id}>
                <td>{cardLabel(r.card)}</td>
                <td>
                  <input
                    type="number" min={1} max={14} value={r.actingAs}
                    onChange={(e) => update(i, { actingAs: Number(e.target.value) as SeqPos })}
                    style={{ width: 60 }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox" checked={r.isJoker}
                    disabled={r.card.rank !== 2}
                    onChange={(e) => update(i, { isJoker: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {targetMeld && existingRows.length > 0 && (
          <>
            <p className="hint" style={{ marginTop: 16 }}>
              Cards already in this meld — reinterpret if you need to. For example, flip a natural 2 into a joker and change its slot so a new card fits.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Existing card</th>
                  <th>Slot</th>
                  <th>Joker?</th>
                </tr>
              </thead>
              <tbody>
                {existingRows.map((r, i) => (
                  <tr key={r.cardId}>
                    <td>{cardLabel(r.card)}</td>
                    <td>
                      <input
                        type="number" min={1} max={14}
                        value={r.actingAs}
                        onChange={(e) => updateExisting(i, { actingAs: Number(e.target.value) as SeqPos })}
                        style={{ width: 60 }}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={r.isJoker}
                        disabled={r.card.rank !== 2}
                        onChange={(e) => updateExisting(i, { isJoker: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="modal-buttons">
          <button className="primary" onClick={submit}>Submit</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function TripletPicker({
  cardIds,
  match,
  title,
  onCancel,
  onConfirm,
}: {
  cardIds: string[];
  match: Match;
  title: string;
  onCancel: () => void;
  onConfirm: (attempt: TripletMeldCard[]) => void;
}) {
  const cards = useMemo(() => findCards(match, cardIds), [match, cardIds]);
  const [rows, setRows] = useState(() =>
    cards.map((c) => ({ card: c, isJoker: false })),
  );
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="hint">Only 2s can act as jokers.</p>
        <table>
          <thead><tr><th>Card</th><th>Joker?</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.card.id}>
                <td>{cardLabel(r.card)}</td>
                <td>
                  <input
                    type="checkbox" checked={r.isJoker}
                    disabled={r.card.rank !== 2}
                    onChange={(e) =>
                      setRows((rs) =>
                        rs.map((x, idx) => (idx === i ? { ...x, isJoker: e.target.checked } : x)),
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-buttons">
          <button className="primary" onClick={() => onConfirm(rows)}>Submit</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function MoveJokerModal({
  meldId,
  jokerCardId,
  match,
  onCancel,
  onConfirm,
}: {
  meldId: string;
  jokerCardId: string;
  match: Match;
  onCancel: () => void;
  onConfirm: (newPos: SeqPos) => void;
}) {
  const currentTeam = match.teams[TEAM_OF[match.currentTurn]];
  const meld = currentTeam.sequenceBox.find((m) => m.id === meldId);
  const jokerCard =
    meld && meld.kind === 'sequence'
      ? meld.cards.find((c) => c.card.id === jokerCardId)
      : null;
  const [pos, setPos] = useState<SeqPos>((jokerCard?.actingAs ?? 1) as SeqPos);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Move joker</h2>
        <p>
          Joker: {jokerCard ? cardLabel(jokerCard.card) : '?'} — currently at slot{' '}
          {jokerCard?.actingAs}. Pick new slot (1–14).
        </p>
        <input
          type="number" min={1} max={14} value={pos}
          onChange={(e) => setPos(Number(e.target.value) as SeqPos)}
          style={{ width: 80 }}
        />
        <div className="modal-buttons">
          <button className="primary" onClick={() => onConfirm(pos)}>Move</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
