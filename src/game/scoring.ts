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

// Size bonuses — the largest tier that applies wins (bonuses do NOT stack).
//   ≥ 13 cards & pure  → 500 (full-length "ganastha")
//   ≥ 7  cards & pure  → 200
//   ≥ 7  cards & impure → 100
//   otherwise → 0
export function meldSizeBonus(meld: Meld): number {
  const n = meld.cards.length;
  const pure = isPure(meld);
  if (n >= 13 && pure) return 500;
  if (n >= 7) return pure ? 200 : 100;
  return 0;
}

// Full team score for a match. Cards in your team's melds count positive;
// cards still held by your team's players at match end count negative.
// The closing team's hands are empty (that's how they closed) — the losing
// team eats the penalty for whatever they still held.
export type MatchScoreInputs = {
  melds: Meld[];
  bhukaraPicked: boolean;
  closedMatch: boolean;
  ownHeldCardValues: number; // sum of card values still in this team's hands
  midMatchPenalty: number;   // -200 penalties incurred this match
};

// Structured breakdown so a scoreboard can show *why* the score is what it is.
export type MatchScoreBreakdown = {
  meldCards: number;
  sizeBonuses: number;
  bhukaraBonus: number;
  closingBonus: number;
  heldPenalty: number; // subtracted
  midMatchPenalty: number; // subtracted
  total: number;
};

export function scoreBreakdown(inp: MatchScoreInputs): MatchScoreBreakdown {
  const meldCards = inp.melds.reduce((s, m) => s + meldCardTotal(m), 0);
  const sizeBonuses = inp.melds.reduce((s, m) => s + meldSizeBonus(m), 0);
  const bhukaraBonus = inp.bhukaraPicked ? 50 : 0;
  const closingBonus = inp.closedMatch ? 50 : 0;
  const heldPenalty = inp.ownHeldCardValues;
  const midMatchPenalty = inp.midMatchPenalty;
  return {
    meldCards,
    sizeBonuses,
    bhukaraBonus,
    closingBonus,
    heldPenalty,
    midMatchPenalty,
    total:
      meldCards + sizeBonuses + bhukaraBonus + closingBonus -
      heldPenalty - midMatchPenalty,
  };
}

export function scoreMatchForTeam(inp: MatchScoreInputs): number {
  return scoreBreakdown(inp).total;
}

// Convenience: is this meld a pure sequence? (Used for first-drop enforcement.)
export function isPureSequence(meld: Meld): meld is SequenceMeld {
  return meld.kind === 'sequence' && isPure(meld);
}

export function isTriplet(meld: Meld): meld is TripletMeld {
  return meld.kind === 'triplet';
}
