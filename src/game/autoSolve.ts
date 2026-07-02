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

// Result of trying to auto-solve a "drop new meld" from a set of hand cards.
export type AutoSolveDropResult =
  | { kind: 'sequence'; cards: SequenceMeldCard[] }
  | { kind: 'triplet'; cards: TripletMeldCard[] }
  | { kind: 'ambiguous' }
  | { kind: 'no-fit' };

// Given the raw cards the user picked for a new sequence, try to figure out
// the intent without asking. Handles the common case: 3+ same-suit cards with
// contiguous natural ranks (no jokers in play). Anything with 2s-as-jokers or
// gaps returns "ambiguous" and the modal handles it.
export function autoSolveDropSequence(cards: Card[]): AutoSolveDropResult {
  if (cards.length < 3) return { kind: 'no-fit' };
  // All same suit? If not, we can't figure it out (2s might be jokers).
  const suit = cards[0].suit;
  const allSameSuit = cards.every((c) => c.suit === suit);
  if (!allSameSuit) return { kind: 'ambiguous' };

  // No 2s (2s are always ambiguous — could be natural or joker).
  const hasTwo = cards.some((c) => c.rank === JOKER_RANK);
  if (hasTwo) return { kind: 'ambiguous' };

  // Sort by rank, treat Ace (1) as high only if the rest are K-topped.
  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
  const hasAce = ranks[0] === 1;
  const rest = hasAce ? ranks.slice(1) : ranks;

  // Are the non-Ace ranks strictly contiguous?
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] !== rest[i - 1] + 1) return { kind: 'ambiguous' };
  }

  // With no 2s in play, an Ace can only be natural-low if the next rank is 2 —
  // which we filtered out. So Ace here must be K-topped (Ace-high) or invalid.
  let aceHigh = false;
  if (hasAce) {
    if (rest[rest.length - 1] !== 13) return { kind: 'no-fit' };
    aceHigh = true;
  }

  // Build the meld cards. Preserve the input order — user's drag order.
  const originalOrder = [...cards].sort((a, b) => {
    const aPos = a.rank === 1 && aceHigh ? 14 : a.rank;
    const bPos = b.rank === 1 && aceHigh ? 14 : b.rank;
    return aPos - bPos;
  });
  const result: SequenceMeldCard[] = originalOrder.map((c) => ({
    card: c,
    actingAs: (c.rank === 1 && aceHigh ? 14 : c.rank) as SeqPos,
    isJoker: false,
  }));
  return { kind: 'sequence', cards: result };
}

// Given raw cards for a new triplet, figure out the intent. A clean triplet
// is 3+ cards of the same rank, optionally with one 2 acting as a joker.
export function autoSolveDropTriplet(cards: Card[]): AutoSolveDropResult {
  if (cards.length < 3) return { kind: 'no-fit' };

  // Find the majority rank.
  const rankCounts = new Map<number, number>();
  for (const c of cards) rankCounts.set(c.rank, (rankCounts.get(c.rank) ?? 0) + 1);
  const nonTwoRanks = [...rankCounts.entries()].filter(([r]) => r !== JOKER_RANK);
  if (nonTwoRanks.length !== 1) {
    // Either zero non-2s (all 2s → that's a triplet of 2s, fine) or multiple ranks.
    if (nonTwoRanks.length === 0 && (rankCounts.get(JOKER_RANK) ?? 0) === cards.length) {
      // All 2s: natural triplet of 2s.
      const result: TripletMeldCard[] = cards.map((c) => ({ card: c, isJoker: false }));
      return { kind: 'triplet', cards: result };
    }
    return { kind: 'ambiguous' };
  }

  const [naturalRank] = nonTwoRanks[0];
  const twoCount = rankCounts.get(JOKER_RANK) ?? 0;
  // A triplet can have at most one joker.
  if (twoCount > 1) return { kind: 'ambiguous' };

  const result: TripletMeldCard[] = cards.map((c) => ({
    card: c,
    isJoker: c.rank === JOKER_RANK && naturalRank !== JOKER_RANK,
  }));
  return { kind: 'triplet', cards: result };
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
