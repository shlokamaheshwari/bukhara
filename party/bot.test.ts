import { describe, it, expect } from 'vitest';
import { newGame } from '../src/game/newGame';
import {
  addToSequence, addToTriplet, discard, drawStock, dropMeld, moveJoker, pickDiscard,
} from '../src/game/moves';
import { pickBotMove } from './bot';
import type { MoveResult } from '../src/game/moves';
import type { Game, Match, PlayerId } from '../src/game/types';
import type { MoveMessage } from '../src/net/messages';

function applyMove(match: Match, move: MoveMessage): MoveResult {
  switch (move.type) {
    case 'move-draw-stock': return drawStock(match);
    case 'move-pick-discard': return pickDiscard(match);
    case 'move-drop-meld': return dropMeld(match, move.input);
    case 'move-add-to-sequence': return addToSequence(match, move.input);
    case 'move-add-to-triplet': return addToTriplet(match, move.input);
    case 'move-joker': return moveJoker(match, move.meldId, move.jokerCardId, move.newActingAs);
    case 'move-discard': return discard(match, move.cardId);
    default: return { ok: false, reason: 'unknown' };
  }
}

// Drive a full 4-bot match exactly the way party/room.ts does, including its
// illegal-move fallback (brute-force a discard to end the turn). Returns the
// terminal phase, or 'runaway'/'stuck' if the game failed to progress.
function runBotMatch(seed: number, moveBudget = 3000): { phase: string; moves: number } {
  let game: Game = newGame({ seed, playerNames: ['A0', 'B1', 'A2', 'B3'] });
  let moves = 0;
  while (game.currentMatch.phase === 'playing') {
    if (moves++ > moveBudget) return { phase: 'runaway', moves };
    const match = game.currentMatch;
    const seat = match.currentTurn as PlayerId;
    let move = pickBotMove(match, seat);
    if (!move) {
      const hand = match.players[seat].hand;
      if (match.turnPhase === 'may-meld' && hand.length > 0) move = { type: 'move-discard', cardId: hand[0].id };
      else if (match.turnPhase === 'awaiting-draw') move = { type: 'move-draw-stock' };
      else return { phase: 'stuck', moves };
    }
    let result = applyMove(match, move);
    if (!result.ok && match.turnPhase === 'may-meld') {
      // room.ts fallback: try each card as a discard to escape may-meld.
      for (const c of match.players[seat].hand) {
        const fb = discard(match, c.id);
        if (fb.ok) { result = fb; break; }
      }
    }
    if (!result.ok) return { phase: 'stuck', moves };
    game = { ...game, currentMatch: result.match };
  }
  return { phase: game.currentMatch.phase, moves };
}

describe('bot self-play never deadlocks', () => {
  // Regression: (1) the bot used to always take the 1-card discard pile instead
  // of drawing stock, so the deck never emptied and an all-bot match ran
  // forever; (2) the bot would meld its hand down to 1 card even when it could
  // not legally close (bhukara taken, no 7+ meld), leaving it unable to discard
  // and freezing the turn. Every seeded all-bot match must terminate.
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
  for (const seed of seeds) {
    it(`match with seed ${seed} terminates`, () => {
      const { phase } = runBotMatch(seed);
      expect(['ended-normal', 'ended-void']).toContain(phase);
    });
  }
});
