// Auto-solver for drag-drop card additions to an existing meld. Given the
// dropped card + the target meld, tries to figure out the intended add
// deterministically. Returns "ambiguous" for cases with more than one legal
// interpretation — the caller should then open the manual modal.
//
// Kept intentionally conservative: it only fires on clear, unambiguous cases.

import type {
  Card,
  Meld,
  SeqPos,
  SequenceMeldCard,
  TripletMeldCard,
} from './types';
import { JOKER_RANK } from './types';

export type AutoSolveResult =
  | {
      kind: 'sequence';
      additions: SequenceMeldCard[];
      reassignments?: { cardId: string; newActingAs: SeqPos; newIsJoker: boolean }[];
    }
  | {
      kind: 'triplet';
      additions: TripletMeldCard[];
    }
  | { kind: 'ambiguous' } // multiple valid interpretations — open the modal
  | { kind: 'no-fit' };   // card doesn't fit here at all

// The one entry point the UI calls on drop.
export function autoSolveAdd(card: Card, meld: Meld): AutoSolveResult {
  if (meld.kind === 'triplet') return solveTriplet(card, meld);
  return solveSequence(card, meld);
}

function solveTriplet(card: Card, meld: Extract<Meld, { kind: 'triplet' }>): AutoSolveResult {
  const rank = meld.rank;
  const alreadyHasJoker = meld.cards.some((c) => c.isJoker);

  // Natural add: same rank.
  if (card.rank === rank) {
    // Triplet of 2s can only have natural 2s.
    return { kind: 'triplet', additions: [{ card, isJoker: false }] };
  }
  // Joker (2) can be added to a non-2 triplet if none already exists.
  if (card.rank === JOKER_RANK && rank !== JOKER_RANK && !alreadyHasJoker) {
    return { kind: 'triplet', additions: [{ card, isJoker: true }] };
  }
  return { kind: 'no-fit' };
}

function solveSequence(card: Card, meld: Extract<Meld, { kind: 'sequence' }>): AutoSolveResult {
  const suit = meld.suit;
  const positions = meld.cards.map((c) => c.actingAs).sort((a, b) => a - b);
  const minPos = positions[0];
  const maxPos = positions[positions.length - 1];

  // Case A — same-suit natural extends the high end.
  if (card.suit === suit && card.rank === maxPos + 1 && maxPos + 1 <= 13) {
    return {
      kind: 'sequence',
      additions: [{ card, actingAs: (maxPos + 1) as SeqPos, isJoker: false }],
    };
  }
  // Case B — same-suit natural extends the low end.
  if (card.suit === suit && card.rank === minPos - 1 && minPos - 1 >= 1) {
    return {
      kind: 'sequence',
      additions: [{ card, actingAs: (minPos - 1) as SeqPos, isJoker: false }],
    };
  }
  // Case C — Ace-high (rank 1 dropped on a K-topped run of the same suit).
  if (card.rank === 1 && card.suit === suit && maxPos === 13) {
    return {
      kind: 'sequence',
      additions: [{ card, actingAs: 14 as SeqPos, isJoker: false }],
    };
  }
  // Case D — the card fills the slot a joker is currently occupying. Move the
  // joker to whichever end has room (prefer extending high, fall back to low).
  const jokerAtRank = meld.cards.find(
    (c) => c.isJoker && c.actingAs === card.rank && card.suit === suit,
  );
  if (jokerAtRank) {
    const highRoom = maxPos + 1 <= 13 ? (maxPos + 1) : null;
    const lowRoom = minPos - 1 >= 1 ? (minPos - 1) : null;
    const targetPos = highRoom ?? lowRoom;
    if (targetPos !== null) {
      return {
        kind: 'sequence',
        additions: [{ card, actingAs: card.rank as SeqPos, isJoker: false }],
        reassignments: [{
          cardId: jokerAtRank.card.id,
          newActingAs: targetPos as SeqPos,
          newIsJoker: true,
        }],
      };
    }
  }
  return { kind: 'no-fit' };
}
