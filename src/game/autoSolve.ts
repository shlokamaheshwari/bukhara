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
// the intent. Handles jokers (2s) filling gaps and Ace-high vs Ace-low —
// as long as exactly one interpretation is consistent. Falls back to
// "ambiguous" if two configurations are both legal.
export function autoSolveDropSequence(cards: Card[]): AutoSolveDropResult {
  if (cards.length < 3) return { kind: 'no-fit' };

  // Split into potential naturals (non-2s) and potential jokers (2s).
  const naturals = cards.filter((c) => c.rank !== JOKER_RANK);
  const twos = cards.filter((c) => c.rank === JOKER_RANK);

  // Need at least one natural to fix the suit.
  if (naturals.length === 0) return { kind: 'ambiguous' };

  // All naturals must share a suit; that suit is the meld's suit.
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return { kind: 'ambiguous' };

  // Try every plausible placement for the Ace (if any) and every valid start
  // offset for the sequence. Collect all consistent configurations.
  const configs: SequenceMeldCard[][] = [];
  const hasAce = naturals.some((c) => c.rank === 1);
  const aceOptions = hasAce ? [1, 14] : [null];

  for (const aceAs of aceOptions) {
    // Positions used by natural cards (with Ace mapped per aceAs).
    const naturalPositions = naturals.map((c) => (c.rank === 1 ? (aceAs as number) : c.rank));
    // Any duplicate natural positions → impossible.
    if (new Set(naturalPositions).size !== naturalPositions.length) continue;
    naturalPositions.sort((a, b) => a - b);
    const size = cards.length;
    const minNat = naturalPositions[0];
    const maxNat = naturalPositions[naturalPositions.length - 1];

    // The meld spans size consecutive slots [start, start+size-1] with all
    // natural positions inside. Bounds on start:
    const startLow = Math.max(1, maxNat - size + 1);
    const startHigh = Math.min(minNat, 15 - size);
    for (let start = startLow; start <= startHigh; start++) {
      const end = start + size - 1;
      const slots = new Set<number>();
      for (let s = start; s <= end; s++) slots.add(s);
      // Every natural must land in a slot.
      if (!naturalPositions.every((p) => slots.has(p))) continue;
      // Gaps = slots minus naturals; jokers must exactly fill them.
      const gaps: number[] = [];
      for (let s = start; s <= end; s++) {
        if (!naturalPositions.includes(s)) gaps.push(s);
      }
      if (gaps.length !== twos.length) continue;

      // Build the meld cards, sorted by slot.
      const meldCards: SequenceMeldCard[] = [];
      // Naturals
      for (const c of naturals) {
        const pos = c.rank === 1 ? (aceAs as number) : c.rank;
        meldCards.push({ card: c, actingAs: pos as SeqPos, isJoker: false });
      }
      // Twos filling gaps. A 2 of the meld's suit dropped into slot 2 is
      // natural (pure); anything else counts as a joker (impure).
      const twoQueue = [...twos];
      for (const g of gaps) {
        const two = twoQueue.shift()!;
        const isNaturalTwo = g === 2 && two.suit === suit;
        meldCards.push({ card: two, actingAs: g as SeqPos, isJoker: !isNaturalTwo });
      }
      meldCards.sort((a, b) => a.actingAs - b.actingAs);
      configs.push(meldCards);
    }
  }

  if (configs.length === 0) return { kind: 'no-fit' };
  // Prefer configurations with the fewest jokers (purest sequence). If
  // multiple configs tie for the min, the intent is genuinely ambiguous.
  const jokerCount = (m: SequenceMeldCard[]) => m.filter((c) => c.isJoker).length;
  const minJokers = Math.min(...configs.map(jokerCount));
  const best = configs.filter((m) => jokerCount(m) === minJokers);
  if (best.length > 1) return { kind: 'ambiguous' };
  return { kind: 'sequence', cards: best[0] };
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
