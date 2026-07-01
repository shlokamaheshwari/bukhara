import type {
  Rank,
  SeqPos,
  SequenceMeld,
  SequenceMeldCard,
  TripletMeld,
  TripletMeldCard,
} from './types';
import { JOKER_RANK } from './types';

// Player supplies an ordered attempt where each card has an intended slot
// (actingAs) and a flag saying whether it's playing as a wildcard.
export type SequenceAttempt = SequenceMeldCard[];
export type TripletAttempt = TripletMeldCard[];

export type ValidateResult<M> =
  | { ok: true; meld: M; pure: boolean }
  | { ok: false; reason: string };

// Ace can play low (1) or high (14). Non-jokers must fill their natural slot
// except Ace which can also fill slot 14.
function isNaturalPlacement(card: SequenceMeldCard): boolean {
  if (card.isJoker) return card.card.rank === JOKER_RANK; // only 2s can be jokers
  if (card.actingAs === card.card.rank) return true;
  if (card.card.rank === 1 && card.actingAs === 14) return true;
  return false;
}

export function validateSequence(
  attempt: SequenceAttempt,
): ValidateResult<SequenceMeld> {
  if (attempt.length < 3) return { ok: false, reason: 'Sequence needs at least 3 cards' };
  if (attempt.length > 14) return { ok: false, reason: 'Sequence longer than 14 is impossible' };

  const jokers = attempt.filter((c) => c.isJoker);
  if (jokers.length > 1) return { ok: false, reason: 'Only one joker allowed per sequence' };
  for (const j of jokers) {
    if (j.card.rank !== JOKER_RANK) {
      return { ok: false, reason: 'Only 2s can act as jokers' };
    }
  }

  for (const c of attempt) {
    if (!isNaturalPlacement(c)) {
      return { ok: false, reason: `${c.card.suit}${c.card.rank} cannot play as slot ${c.actingAs}` };
    }
  }

  const naturals = attempt.filter((c) => !c.isJoker);
  const suits = new Set(naturals.map((c) => c.card.suit));
  if (suits.size > 1) return { ok: false, reason: 'All non-joker cards must share a suit' };
  if (suits.size === 0) return { ok: false, reason: 'Sequence needs at least one non-joker card' };
  const suit = [...suits][0];

  const positions = attempt.map((c) => c.actingAs).sort((a, b) => a - b);
  const posSet = new Set(positions);
  if (posSet.size !== positions.length) {
    return { ok: false, reason: 'Two cards playing the same slot' };
  }
  const min = positions[0];
  const max = positions[positions.length - 1];
  if (max - min + 1 !== positions.length) {
    return { ok: false, reason: 'Sequence must be consecutive with no gaps' };
  }
  if (min < 1 || max > 14) return { ok: false, reason: 'Sequence out of range' };
  // Wrap around K-A is disallowed: cannot cross from 13 to 14 unless via Ace-high (13,14).
  // K,A,2 would mean positions [2, 13, 14] — not consecutive, so caught above. Good.

  const ordered = attempt.slice().sort((a, b) => a.actingAs - b.actingAs);
  const pure = jokers.length === 0;
  const meld: SequenceMeld = {
    id: newMeldId('seq'),
    kind: 'sequence',
    suit,
    cards: ordered,
  };
  return { ok: true, meld, pure };
}

export function validateTriplet(attempt: TripletAttempt): ValidateResult<TripletMeld> {
  if (attempt.length < 3) return { ok: false, reason: 'Triplet needs at least 3 cards' };
  if (attempt.length > 8) return { ok: false, reason: 'Triplet cannot exceed 8 cards (deck limit)' };

  const jokers = attempt.filter((c) => c.isJoker);
  if (jokers.length > 1) return { ok: false, reason: 'Only one joker allowed per triplet' };
  for (const j of jokers) {
    if (j.card.rank !== JOKER_RANK) {
      return { ok: false, reason: 'Only 2s can act as jokers' };
    }
  }

  const naturals = attempt.filter((c) => !c.isJoker);
  if (naturals.length === 0) return { ok: false, reason: 'Triplet needs at least one non-joker card' };
  const ranks = new Set(naturals.map((c) => c.card.rank));
  if (ranks.size > 1) return { ok: false, reason: 'All non-joker cards must share a rank' };
  const rank = [...ranks][0] as Rank;

  // A triplet of 2s cannot contain a joker (a 2 acting as a 2 is natural, not a joker).
  if (rank === JOKER_RANK && jokers.length > 0) {
    return { ok: false, reason: 'A triplet of 2s has no joker slot — all 2s are natural' };
  }

  const pure = jokers.length === 0;
  const meld: TripletMeld = {
    id: newMeldId('trip'),
    kind: 'triplet',
    rank,
    cards: attempt.slice(),
  };
  return { ok: true, meld, pure };
}

// Whether an existing meld is currently pure (no card acting as joker).
export function isPure(meld: SequenceMeld | TripletMeld): boolean {
  return meld.cards.every((c) => !c.isJoker);
}

// Small ID generator — collision-resistant enough for a single game session.
let _meldCounter = 0;
export function newMeldId(prefix: string): string {
  _meldCounter += 1;
  return `${prefix}-${_meldCounter}`;
}

// Test hook — reset the counter so meld IDs are deterministic across tests.
export function _resetMeldIdsForTests(): void {
  _meldCounter = 0;
}

// Helpers to construct SequenceMeldCard entries from a raw Card + intent.
export function asNatural(
  card: { id: string; suit: 'H' | 'D' | 'C' | 'S'; rank: Rank },
  actingAs?: SeqPos,
): SequenceMeldCard {
  return {
    card,
    actingAs: (actingAs ?? card.rank) as SeqPos,
    isJoker: false,
  };
}

export function asJoker(
  card: { id: string; suit: 'H' | 'D' | 'C' | 'S'; rank: Rank },
  actingAs: SeqPos,
): SequenceMeldCard {
  return { card, actingAs, isJoker: true };
}
