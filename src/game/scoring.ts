import type { Meld, Rank, SequenceMeld, TripletMeld } from './types';
import { isPure } from './melds';

// Individual card point values for scoring (used both for meld totals and
// the deduction of leftover cards in opponents' hands).
export function cardValue(rank: Rank): number {
  if (rank === 1) return 15; // Ace
  if (rank === 2) return 10; // 2 — always 10, joker use or not
  if (rank >= 3 && rank <= 7) return 5;
  return 10; // 8-K
}

// Sum of point values for all physical cards in a meld.
export function meldCardTotal(meld: Meld): number {
  return meld.cards.reduce((sum, mc) => sum + cardValue(mc.card.rank), 0);
}

// Bonus for a completed 7+ card meld: 200 pure, 100 impure. Zero below 7.
export function meldSizeBonus(meld: Meld): number {
  if (meld.cards.length < 7) return 0;
  return isPure(meld) ? 200 : 100;
}

// Full team score for a match given committed melds, bhukara pickup, closing,
// and (subtracted) opponents' hand cards.
export type MatchScoreInputs = {
  melds: Meld[];
  bhukaraPicked: boolean;
  closedMatch: boolean;
  opponentHeldCardValues: number; // sum of card values still in opponents' hands
};

export function scoreMatchForTeam(inp: MatchScoreInputs): number {
  const meldCards = inp.melds.reduce((s, m) => s + meldCardTotal(m), 0);
  const sizeBonuses = inp.melds.reduce((s, m) => s + meldSizeBonus(m), 0);
  const bhukaraBonus = inp.bhukaraPicked ? 50 : 0;
  const closingBonus = inp.closedMatch ? 50 : 0;
  return meldCards + sizeBonuses + bhukaraBonus + closingBonus - inp.opponentHeldCardValues;
}

// Convenience: is this meld a pure sequence? (Used for first-drop enforcement.)
export function isPureSequence(meld: Meld): meld is SequenceMeld {
  return meld.kind === 'sequence' && isPure(meld);
}

export function isTriplet(meld: Meld): meld is TripletMeld {
  return meld.kind === 'triplet';
}
