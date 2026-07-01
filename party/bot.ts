// Bukhara bot with real strategy. On each turn the bot:
//   1. Decides whether to draw stock or pick the discard pile based on
//      whether that pile lets it form new melds.
//   2. Looks for pure sequences, impure sequences (using jokers), triplets,
//      and additions to existing team melds. Drops what it can.
//   3. If it's on track to empty, tries to close via Bhukara.
//   4. Discards its least useful card — one that's isolated in its hand
//      and (heuristically) low value to opponents.
//
// The bot works only from data visible to it: its own hand, the shared
// discard pile, the visible melds on the table.

import type {
  Card,
  Match,
  Meld,
  PlayerId,
  Rank,
  SeqPos,
  SequenceMeldCard,
  Suit,
  TripletMeldCard,
} from '../src/game/types';
import type { MoveMessage } from '../src/net/messages';
import { JOKER_RANK, TEAM_OF } from '../src/game/types';
import { cardValue, isPureSequence } from '../src/game/scoring';

const RANK_LOW = 1;
const RANK_HIGH = 13;

// ---------------- Helpers ------------------------------------------------

function cardsById(hand: Card[]): Map<string, Card> {
  const m = new Map<string, Card>();
  for (const c of hand) m.set(c.id, c);
  return m;
}

// Non-joker consecutive same-suit runs of length >= 3.
function findPureSequences(hand: Card[]): SequenceMeldCard[][] {
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of hand) bySuit[c.suit].push(c);
  const runs: SequenceMeldCard[][] = [];
  for (const suit of ['H', 'D', 'C', 'S'] as Suit[]) {
    const arr = bySuit[suit].slice().sort((a, b) => a.rank - b.rank);
    // Deduplicate cards at same rank (we have 2 decks, either copy is fine).
    const uniq: Card[] = [];
    const seen = new Set<number>();
    for (const c of arr) {
      if (!seen.has(c.rank)) { uniq.push(c); seen.add(c.rank); }
    }
    let run: Card[] = [];
    for (const c of uniq) {
      if (run.length === 0 || c.rank === run[run.length - 1].rank + 1) {
        run.push(c);
      } else {
        if (run.length >= 3) runs.push(runToAttempt(run));
        run = [c];
      }
    }
    if (run.length >= 3) runs.push(runToAttempt(run));
  }
  return runs;
}

function runToAttempt(run: Card[]): SequenceMeldCard[] {
  return run.map((c) => ({
    card: c,
    actingAs: c.rank as SeqPos,
    isJoker: false,
  }));
}

// Cards of the same rank (natural), grouped for triplet detection.
function findTriplets(hand: Card[]): TripletMeldCard[][] {
  const byRank = new Map<Rank, Card[]>();
  for (const c of hand) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank)!.push(c);
  }
  const trips: TripletMeldCard[][] = [];
  for (const [rank, cards] of byRank.entries()) {
    // Triplet cannot use jokers if rank is 2 (natural).
    if (rank === JOKER_RANK && cards.length >= 3) {
      trips.push(cards.map((c) => ({ card: c, isJoker: false })));
    } else if (cards.length >= 3) {
      trips.push(cards.map((c) => ({ card: c, isJoker: false })));
    }
  }
  return trips;
}

// Try to form an impure sequence using a joker (a 2) with two same-suit
// consecutive naturals. Returns the sequence attempt if found.
function findImpureSequence(hand: Card[]): SequenceMeldCard[] | null {
  const jokers = hand.filter((c) => c.rank === JOKER_RANK);
  if (jokers.length === 0) return null;
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of hand) if (c.rank !== JOKER_RANK) bySuit[c.suit].push(c);
  for (const suit of ['H', 'D', 'C', 'S'] as Suit[]) {
    const arr = bySuit[suit].slice().sort((a, b) => a.rank - b.rank);
    // Look for two consecutive that could bracket the joker (a,a+2) or extend a pair (a,a+1) + joker at either end.
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      // Extend pair (a, a+1) by joker on either side.
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (b.rank - a.rank === 1) {
          const joker = jokers[0];
          // joker before a (if a.rank > 1) or after b (if b.rank < 13)
          if (a.rank > RANK_LOW) {
            return [
              { card: joker, actingAs: (a.rank - 1) as SeqPos, isJoker: true },
              { card: a, actingAs: a.rank as SeqPos, isJoker: false },
              { card: b, actingAs: b.rank as SeqPos, isJoker: false },
            ];
          }
          if (b.rank < RANK_HIGH) {
            return [
              { card: a, actingAs: a.rank as SeqPos, isJoker: false },
              { card: b, actingAs: b.rank as SeqPos, isJoker: false },
              { card: joker, actingAs: (b.rank + 1) as SeqPos, isJoker: true },
            ];
          }
        } else if (b.rank - a.rank === 2) {
          // Joker sits between a and b.
          const joker = jokers[0];
          return [
            { card: a, actingAs: a.rank as SeqPos, isJoker: false },
            { card: joker, actingAs: (a.rank + 1) as SeqPos, isJoker: true },
            { card: b, actingAs: b.rank as SeqPos, isJoker: false },
          ];
        }
      }
    }
  }
  return null;
}

// Which cards in the current discard pile would combine with our hand into a
// pure sequence? Returns the count of "hits" — higher is better for picking.
function discardPileValueForHand(hand: Card[], pile: Card[]): number {
  if (pile.length === 0) return 0;
  // Cheap approximation: count pile cards that are within-1-rank of a same-suit
  // card in our hand, or match our hand ranks (potential triplet).
  const bySuit: Record<Suit, Set<number>> = { H: new Set(), D: new Set(), C: new Set(), S: new Set() };
  const rankCounts: Record<number, number> = {};
  for (const c of hand) {
    bySuit[c.suit].add(c.rank);
    rankCounts[c.rank] = (rankCounts[c.rank] ?? 0) + 1;
  }
  let hits = 0;
  for (const c of pile) {
    const sameSuit = bySuit[c.suit];
    if (sameSuit.has(c.rank - 1) || sameSuit.has(c.rank + 1) || sameSuit.has(c.rank)) hits += 2;
    if ((rankCounts[c.rank] ?? 0) >= 2) hits += 2; // instant triplet potential
  }
  return hits;
}

// Cards to add to existing team melds. Returns the first opportunity found.
type AddOp =
  | { kind: 'sequence'; meldId: string; addition: SequenceMeldCard }
  | { kind: 'triplet'; meldId: string; addition: TripletMeldCard };

function findAddition(hand: Card[], melds: Meld[]): AddOp | null {
  for (const meld of melds) {
    if (meld.kind === 'sequence') {
      const positions = meld.cards.map((c) => c.actingAs);
      const suit = meld.suit;
      const minPos = Math.min(...positions);
      const maxPos = Math.max(...positions);
      // Extend low or high with a same-suit natural card of the required rank.
      const need = [
        { pos: minPos - 1, rank: minPos - 1 },
        { pos: maxPos + 1, rank: maxPos + 1 },
      ];
      for (const n of need) {
        if (n.pos < RANK_LOW || n.pos > 14) continue;
        // Prefer a natural card whose rank == pos and matches suit.
        const nat = hand.find((c) => c.suit === suit && c.rank === n.pos);
        if (nat) {
          return {
            kind: 'sequence',
            meldId: meld.id,
            addition: { card: nat, actingAs: n.pos as SeqPos, isJoker: false },
          };
        }
      }
    } else {
      // Triplet: add another card of the same rank (any suit).
      const rank = meld.rank;
      const nat = hand.find((c) => c.rank === rank);
      if (nat) {
        return { kind: 'triplet', meldId: meld.id, addition: { card: nat, isJoker: false } };
      }
    }
  }
  return null;
}

// Discard heuristic: prefer cards that are isolated in our hand, high value,
// and not adjacent to what opponents just discarded (avoid feeding them).
function pickCardToDiscard(hand: Card[], recentDiscards: Card[]): string {
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of hand) bySuit[c.suit].push(c);
  for (const arr of Object.values(bySuit)) arr.sort((a, b) => a.rank - b.rank);
  const rankCounts: Record<number, number> = {};
  for (const c of hand) rankCounts[c.rank] = (rankCounts[c.rank] ?? 0) + 1;

  // Isolated = no same-suit neighbour within ±2 ranks, and no other copy of
  // the same rank (no potential triplet).
  function isIsolated(c: Card): boolean {
    if (c.rank === JOKER_RANK) return false;
    const near = (bySuit[c.suit] ?? []).some(
      (o) => o.id !== c.id && Math.abs(o.rank - c.rank) <= 2,
    );
    if (near) return false;
    if ((rankCounts[c.rank] ?? 0) >= 2) return false;
    return true;
  }

  // Also avoid dumping a card the opponents were just discarding — if opponents
  // threw ranks R±1, they might want R.
  const recentRanks = new Set<number>(recentDiscards.map((c) => c.rank as number));

  const candidates = hand.filter((c) => c.rank !== JOKER_RANK).sort((a, b) => cardValue(b.rank) - cardValue(a.rank));
  const isolated = candidates.filter(isIsolated);
  // Prefer isolated cards, then those not near recent opponent discards.
  const safe = isolated.filter((c) => !recentRanks.has(c.rank + 1) && !recentRanks.has(c.rank - 1));
  const pick = safe[0] ?? isolated[0] ?? candidates[0] ?? hand[0];
  return pick.id;
}

// ---------------- Main entry --------------------------------------------

export function pickBotMove(match: Match, seat: PlayerId): MoveMessage | null {
  if (match.phase !== 'playing') return null;
  if (match.currentTurn !== seat) return null;

  const teamId = TEAM_OF[seat];
  const team = match.teams[teamId];
  const hand = match.players[seat].hand;

  // ---- Awaiting draw --------------------------------------------------
  if (match.turnPhase === 'awaiting-draw') {
    const discardHits = discardPileValueForHand(hand, match.discard);
    // Rough rule: picking the pile is worth it if the pile has strong synergy
    // and isn't too big to inflate our hand.
    const cost = match.discard.length; // more cards = more risk of leftover deadweight
    if (discardHits >= cost + 3 && match.discard.length > 0) {
      return { type: 'move-pick-discard' };
    }
    return { type: 'move-draw-stock' };
  }

  // ---- May meld ------------------------------------------------------
  if (match.turnPhase === 'may-meld') {
    const hasPureInBox = team.sequenceBox.some(isPureSequence);
    const boxEmpty = team.sequenceBox.length === 0;

    // 1. Try to drop a pure sequence, especially if team hasn't got one.
    const pures = findPureSequences(hand).sort((a, b) => b.length - a.length);
    if (pures.length > 0 && hand.length > pures[0].length) {
      // Check the drop wouldn't leave us with 0 cards (need 1 for discard).
      return { type: 'move-drop-meld', input: { kind: 'sequence', cards: pures[0] } };
    }

    // 2. If team has a pure sequence, drop triplets.
    if (hasPureInBox) {
      const trips = findTriplets(hand).sort((a, b) => b.length - a.length);
      if (trips.length > 0 && hand.length > trips[0].length) {
        return { type: 'move-drop-meld', input: { kind: 'triplet', cards: trips[0] } };
      }
    }

    // 3. Try an impure sequence (using a joker) if we still have hand left.
    // Only if team already has a pure sequence — otherwise our first drop
    // must be pure.
    if (hasPureInBox || !boxEmpty) {
      const impure = findImpureSequence(hand);
      if (impure && hand.length > impure.length) {
        return { type: 'move-drop-meld', input: { kind: 'sequence', cards: impure } };
      }
    }

    // 4. Add cards to existing team melds.
    const addOp = findAddition(hand, team.sequenceBox);
    if (addOp && hand.length > 1) {
      if (addOp.kind === 'sequence') {
        return {
          type: 'move-add-to-sequence',
          input: { meldId: addOp.meldId, additions: [addOp.addition] },
        };
      }
      return {
        type: 'move-add-to-triplet',
        input: { meldId: addOp.meldId, additions: [addOp.addition] },
      };
    }

    // 5. Discard. Take the last few discarded cards as "recent opponents".
    const recent = match.discard.slice(-4);
    return { type: 'move-discard', cardId: pickCardToDiscard(hand, recent) };
  }

  return null;
}

