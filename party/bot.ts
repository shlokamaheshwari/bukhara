// Bukhara bot with layered strategy. Each turn the bot:
//   1. Reads the situation — team's meld progress, whether we've hit ganastha,
//      whether either team has taken bhukara, how many cards each player holds.
//   2. Checks for a closing move first — if the team has a 7+ meld and we can
//      empty our hand, we take that path.
//   3. Otherwise runs through priorities: grow existing melds toward 7 cards,
//      do the required first drop, add cards to team melds, drop new melds,
//      and finally discard.
//
// The bot works only from information visible to it: its own hand, the shared
// discard pile, and the melds already on the table.
//
// Rules from src/game/moves.ts that the bot must respect:
//   - First drop for a team must include at least one pure sequence.
//   - If the team is past 1000 pts, first drop must total >=100 pts.
//   - Triplets are only legal after the team has a pure sequence.
//   - Closing (empty hand after bhukara is taken) requires a 7+ meld.
//   - Must have at least 1 card to discard at the end of the turn.

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

// ---------------- Situation awareness -----------------------------------

type Situation = {
  hand: Card[];
  myTeamMelds: Meld[];
  oppTeamMelds: Meld[];
  hasPureInBox: boolean;
  hasFullMeld: boolean;      // team already has a 7+ meld
  mustFirstDropReach100: boolean;
  firstDropDone: boolean;
  bhukaraTaken: boolean;
  bhukaraMine: boolean;
  oppMinHand: number;         // smallest opponent hand — how close they are to closing
  stockRemaining: number;
};

function readSituation(match: Match, seat: PlayerId): Situation {
  const teamId = TEAM_OF[seat];
  const team = match.teams[teamId];
  const oppId: 'A' | 'B' = teamId === 'A' ? 'B' : 'A';
  const opp = match.teams[oppId];
  const hand = match.players[seat].hand;
  const oppMinHand = ([0, 1, 2, 3] as PlayerId[])
    .filter((p) => TEAM_OF[p] !== teamId)
    .map((p) => match.players[p].hand.length)
    .reduce((a, b) => Math.min(a, b), Infinity);
  return {
    hand,
    myTeamMelds: team.sequenceBox,
    oppTeamMelds: opp.sequenceBox,
    hasPureInBox: team.sequenceBox.some(isPureSequence),
    hasFullMeld: team.sequenceBox.some((m) => m.cards.length >= 7),
    mustFirstDropReach100: team.mustFirstDropReach100,
    firstDropDone: team.firstDropDone,
    bhukaraTaken: match.bhukaraTakenBy !== null,
    bhukaraMine: match.bhukaraTakenBy !== null && TEAM_OF[match.bhukaraTakenBy] === teamId,
    oppMinHand,
    stockRemaining: match.stock.length,
  };
}

// ---------------- Hand analysis -----------------------------------------

// A collection of playable groupings the bot could form from its current hand.
type PlayPlan = {
  // New pure sequences we could drop.
  pureSequences: SequenceMeldCard[][];
  // New triplets we could drop (natural sets of same rank).
  triplets: TripletMeldCard[][];
  // New impure sequences (using jokers). May be longer than pure runs.
  impureSequences: SequenceMeldCard[][];
  // Additions to existing team melds — grouped by meld.
  additions: {
    meldId: string;
    kind: 'sequence' | 'triplet';
    // Cards added; for sequences the joker positions are pre-computed.
    seqAdd?: SequenceMeldCard[];
    tripAdd?: TripletMeldCard[];
  }[];
};

function cardsBySuit(cards: Card[]): Record<Suit, Card[]> {
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of cards) bySuit[c.suit].push(c);
  for (const s of ['H', 'D', 'C', 'S'] as Suit[]) {
    bySuit[s].sort((a, b) => a.rank - b.rank);
  }
  return bySuit;
}

// Longest run in a same-suit sorted array (dedup by rank — either copy is fine).
function longestPureRuns(cards: Card[]): Card[][] {
  const uniq: Card[] = [];
  const seen = new Set<number>();
  for (const c of cards) {
    if (c.rank === JOKER_RANK) continue;
    if (!seen.has(c.rank)) { uniq.push(c); seen.add(c.rank); }
  }
  const runs: Card[][] = [];
  let run: Card[] = [];
  for (const c of uniq) {
    if (run.length === 0 || c.rank === run[run.length - 1].rank + 1) {
      run.push(c);
    } else {
      if (run.length >= 3) runs.push(run);
      run = [c];
    }
  }
  if (run.length >= 3) runs.push(run);
  return runs;
}

function runToPureAttempt(run: Card[]): SequenceMeldCard[] {
  return run.map((c) => ({
    card: c,
    actingAs: c.rank as SeqPos,
    isJoker: false,
  }));
}

// Build the longest impure sequence in a given suit using available jokers.
// Greedy: pick the longest same-suit natural window, then use jokers to fill
// gaps or extend either end. Uses the joker budget passed in.
function bestImpureSequenceForSuit(
  sameSuit: Card[],
  jokerBudget: Card[],
): SequenceMeldCard[] | null {
  if (sameSuit.length < 2 || jokerBudget.length === 0) return null;
  const uniq: Card[] = [];
  const seen = new Set<number>();
  for (const c of sameSuit) {
    if (c.rank === JOKER_RANK) continue;
    if (!seen.has(c.rank)) { uniq.push(c); seen.add(c.rank); }
  }
  uniq.sort((a, b) => a.rank - b.rank);

  let best: SequenceMeldCard[] | null = null;
  // Try every subset of naturals as the "spine" (window between two picked ranks).
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const low = uniq[i].rank;
      const high = uniq[j].rank;
      const span = high - low + 1;
      // Count naturals within [low..high].
      const inside = uniq.filter((c) => c.rank >= low && c.rank <= high);
      const gaps = span - inside.length;
      if (gaps > jokerBudget.length) continue;
      // Also try extending ends by remaining jokers.
      const extra = jokerBudget.length - gaps;
      const lowExt = Math.max(RANK_LOW, low - extra);
      const highExt = Math.min(14, high + (extra - (low - lowExt)));
      const finalLow = lowExt;
      const finalHigh = highExt;
      const finalSpan = finalHigh - finalLow + 1;
      if (finalSpan < 3) continue;
      // Build meld cards.
      const naturalsMap = new Map<number, Card>();
      for (const c of inside) naturalsMap.set(c.rank, c);
      const jokerQueue = [...jokerBudget];
      const meldCards: SequenceMeldCard[] = [];
      let bail = false;
      for (let pos = finalLow; pos <= finalHigh; pos++) {
        const nat = naturalsMap.get(pos);
        if (nat) {
          meldCards.push({ card: nat, actingAs: pos as SeqPos, isJoker: false });
        } else {
          const j = jokerQueue.shift();
          if (!j) { bail = true; break; }
          meldCards.push({ card: j, actingAs: pos as SeqPos, isJoker: true });
        }
      }
      if (bail || meldCards.length < 3) continue;
      if (!best || meldCards.length > best.length) best = meldCards;
    }
  }
  return best;
}

function findTriplets(hand: Card[]): TripletMeldCard[][] {
  const byRank = new Map<Rank, Card[]>();
  for (const c of hand) {
    // 2s are strictly reserved as wildcards. Dropping a triplet of 2s locks
    // three jokers into a 30-pt meld when the same 2s could power a 7-card
    // impure sequence worth several times more.
    if (c.rank === JOKER_RANK) continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank)!.push(c);
  }
  const trips: TripletMeldCard[][] = [];
  for (const cards of byRank.values()) {
    if (cards.length >= 3) trips.push(cards.map((c) => ({ card: c, isJoker: false })));
  }
  return trips;
}

// Additions to an existing team meld. Groups every extension we can make in
// one shot so the bot pumps the meld toward ganastha in a single call.
//
// This function also bridges gaps with jokers when a natural exists further
// out — e.g. meld tops at 9, hand has {2, J, Q} same suit → drop the joker
// in at slot 10, then J natural at 11, Q natural at 12. Without the bridge
// logic the bot would drop {2, J, Q} as a new tiny impure meld instead of
// extending the big existing one, which is the kind of "why would anyone
// do that" move humans notice immediately.
function findAdditionsForMeld(
  hand: Card[],
  meld: Meld,
): PlayPlan['additions'][number] | null {
  if (meld.kind === 'sequence') {
    const suit = meld.suit;
    const positions = new Set(meld.cards.map((c) => c.actingAs as number));
    const min = Math.min(...positions);
    const max = Math.max(...positions);

    // Same-suit naturals available for this meld, and separately the jokers
    // we could burn to bridge gaps.
    const same = hand
      .filter((c) => c.suit === suit && c.rank !== JOKER_RANK)
      .sort((a, b) => a.rank - b.rank);
    const naturalsBySlot = new Map<number, Card>();
    for (const c of same) naturalsBySlot.set(c.rank, c);
    // Ace can naturally sit at slot 14 (Ace-high) when the meld tops at K.
    const ace = same.find((c) => c.rank === 1);
    const jokerPool = hand.filter((c) => c.rank === JOKER_RANK);

    const usedIds = new Set<string>();
    const additions: SequenceMeldCard[] = [];

    // Adding a joker to a sequence downgrades pure → impure. If the meld is
    // already at ganastha (7+ cards), that swap COSTS 100 pts: pure 7+ earns
    // a 200 size bonus, impure 7+ earns only 100. If the meld is already
    // impure at 7+, the joker's marginal value in extending is nil (bonus
    // doesn't grow) and it's worth several times more in a new impure
    // sequence or a triplet ganastha jump. Either way, once at 7+ we let
    // this meld grow only via naturals.
    const skipJokerBridge = meld.cards.length >= 7;

    // Walk outward from each end, filling slot by slot. Prefer naturals; use
    // a joker only when a natural (or Ace) reachable further out justifies
    // the wildcard spend.
    function fillHigh() {
      let cursor = max;
      while (cursor < 14) {
        const nextSlot = cursor + 1;
        // Natural available for this slot?
        const nat = naturalsBySlot.get(nextSlot);
        if (nat && !usedIds.has(nat.id)) {
          additions.push({ card: nat, actingAs: nextSlot as SeqPos, isJoker: false });
          usedIds.add(nat.id);
          cursor = nextSlot;
          continue;
        }
        // Ace-high slot (14) is only reachable if we've climbed to slot 13.
        if (nextSlot === 14 && cursor === 13 && ace && !usedIds.has(ace.id)) {
          additions.push({ card: ace, actingAs: 14 as SeqPos, isJoker: false });
          usedIds.add(ace.id);
          cursor = 14;
          continue;
        }
        // No natural — can a joker bridge here? Only if another natural (or
        // the Ace) further out is still reachable in ≤2 slots. Otherwise the
        // joker is a wildcard set on fire.
        if (skipJokerBridge) break;
        const jokerAvailable = jokerPool.find((j) => !usedIds.has(j.id));
        if (!jokerAvailable) break;
        const bridgeUnlocks =
          (naturalsBySlot.has(nextSlot + 1) && !usedIds.has(naturalsBySlot.get(nextSlot + 1)!.id)) ||
          (naturalsBySlot.has(nextSlot + 2) && !usedIds.has(naturalsBySlot.get(nextSlot + 2)!.id)) ||
          (nextSlot + 1 === 14 && cursor + 1 === 13 && ace && !usedIds.has(ace.id));
        if (!bridgeUnlocks) break;
        additions.push({ card: jokerAvailable, actingAs: nextSlot as SeqPos, isJoker: true });
        usedIds.add(jokerAvailable.id);
        cursor = nextSlot;
      }
    }

    function fillLow() {
      let cursor = min;
      while (cursor > 1) {
        const nextSlot = cursor - 1;
        const nat = naturalsBySlot.get(nextSlot);
        if (nat && !usedIds.has(nat.id)) {
          additions.push({ card: nat, actingAs: nextSlot as SeqPos, isJoker: false });
          usedIds.add(nat.id);
          cursor = nextSlot;
          continue;
        }
        if (skipJokerBridge) break;
        const jokerAvailable = jokerPool.find((j) => !usedIds.has(j.id));
        if (!jokerAvailable) break;
        const bridgeUnlocks =
          (naturalsBySlot.has(nextSlot - 1) && !usedIds.has(naturalsBySlot.get(nextSlot - 1)!.id)) ||
          (naturalsBySlot.has(nextSlot - 2) && !usedIds.has(naturalsBySlot.get(nextSlot - 2)!.id));
        if (!bridgeUnlocks) break;
        additions.push({ card: jokerAvailable, actingAs: nextSlot as SeqPos, isJoker: true });
        usedIds.add(jokerAvailable.id);
        cursor = nextSlot;
      }
    }

    fillHigh();
    fillLow();

    if (additions.length === 0) return null;
    return { meldId: meld.id, kind: 'sequence', seqAdd: additions };
  }

  // Triplet — every natural of the meld's rank. A joker is only spent as a
  // triplet extension when it *directly* unlocks ganastha (final size 7+).
  // Growing a 3-triplet to a 4-triplet with a joker is pure waste: the joker
  // is worth several times more in a sequence, and the triplet was already
  // valid pure without it. The user complaint that surfaced this: bots
  // dropping "Trip 5 (5♣ 5♥ 5♠ 2♦)" when the 2♦ contributes nothing.
  const rank = meld.rank;
  const naturals = hand.filter((c) => c.rank === rank);
  const alreadyHasJoker = meld.cards.some((c) => c.isJoker);
  const additions: TripletMeldCard[] = naturals.map((c) => ({ card: c, isJoker: false }));
  if (!alreadyHasJoker && rank !== JOKER_RANK) {
    const joker = hand.find((c) => c.rank === JOKER_RANK);
    const finalSize = meld.cards.length + naturals.length + 1;
    if (joker && finalSize >= 7) {
      additions.push({ card: joker, isJoker: true });
    }
  }
  if (additions.length === 0) return null;
  return { meldId: meld.id, kind: 'triplet', tripAdd: additions };
}

function buildPlayPlan(situation: Situation): PlayPlan {
  const hand = situation.hand;
  const bySuit = cardsBySuit(hand);
  const jokers = hand.filter((c) => c.rank === JOKER_RANK);

  const pureSequences: SequenceMeldCard[][] = [];
  const impureSequences: SequenceMeldCard[][] = [];
  for (const suit of ['H', 'D', 'C', 'S'] as Suit[]) {
    for (const run of longestPureRuns(bySuit[suit])) {
      pureSequences.push(runToPureAttempt(run));
    }
    if (jokers.length > 0) {
      const impure = bestImpureSequenceForSuit(bySuit[suit], jokers);
      if (impure) impureSequences.push(impure);
    }
  }
  const triplets = findTriplets(hand);
  const additions: PlayPlan['additions'] = [];
  for (const meld of situation.myTeamMelds) {
    const add = findAdditionsForMeld(hand, meld);
    if (add) additions.push(add);
  }
  return { pureSequences, triplets, impureSequences, additions };
}

// ---------------- Move choosers -----------------------------------------

// Would picking the discard pile immediately grant a meld? That's an
// enormous swing, worth taking the whole pile for.
function pileWouldCompleteMeld(hand: Card[], pile: Card[]): boolean {
  if (pile.length === 0) return false;
  const merged = [...hand, ...pile];
  const bySuit = cardsBySuit(merged);
  for (const suit of ['H', 'D', 'C', 'S'] as Suit[]) {
    if (longestPureRuns(bySuit[suit]).length > 0) return true;
  }
  if (findTriplets(merged).length > 0) return true;
  return false;
}

// Heuristic score for taking the pile — accounts for both value gain and
// deadweight risk. Higher = more attractive.
function scoreDiscardPile(hand: Card[], pile: Card[]): number {
  if (pile.length === 0) return -Infinity;
  if (pileWouldCompleteMeld(hand, pile)) return 100 + pile.length; // huge
  const bySuit: Record<Suit, Set<number>> = { H: new Set(), D: new Set(), C: new Set(), S: new Set() };
  const rankCounts: Record<number, number> = {};
  for (const c of hand) {
    bySuit[c.suit].add(c.rank);
    rankCounts[c.rank] = (rankCounts[c.rank] ?? 0) + 1;
  }
  let hits = 0;
  for (const c of pile) {
    const s = bySuit[c.suit];
    if (s.has(c.rank - 1) || s.has(c.rank + 1)) hits += 2;
    if (s.has(c.rank)) hits += 1;
    if ((rankCounts[c.rank] ?? 0) >= 2) hits += 3; // triplet-completing pair
  }
  // Penalty grows with pile size (extra hand cards = extra deadweight risk).
  return hits - Math.max(0, pile.length - 4) * 2;
}

function pickDraw(situation: Situation, match: Match): MoveMessage {
  const score = scoreDiscardPile(situation.hand, match.discard);
  // Threshold — pile score of 6+ (a couple of real connections) is worth taking.
  if (score >= 6 && match.discard.length > 0) {
    return { type: 'move-pick-discard' };
  }
  return { type: 'move-draw-stock' };
}

// ---------------- Meld phase --------------------------------------------

// Decide the best meld/discard action. Returns exactly one MoveMessage.
// The server calls this repeatedly (drop → add → add → discard) so each
// invocation re-plans from current state.
function pickMeldOrDiscard(
  match: Match,
  seat: PlayerId,
  situation: Situation,
): MoveMessage {
  const plan = buildPlayPlan(situation);
  const hand = situation.hand;

  // Two situational flags shape strategy:
  //   endgame — hand is small enough that we should push toward closing rather
  //             than build slowly; also fires when an opponent is very close.
  //   racing  — either team has taken bhukara; the pace has picked up and small
  //             melds become worthwhile because closing is imminent.
  const endgame =
    hand.length <= 5 || situation.oppMinHand <= 4 || situation.stockRemaining <= 10;
  const racing = situation.bhukaraTaken;

  // Deadlock guard: for a 1000+ team that hasn't done its first drop yet, a
  // drop that doesn't push the turn total to >=100 pts will make the eventual
  // discard fail with "must total >=100", and the whole bot turn deadlocks.
  // If we can't credibly reach 100 with the cards in hand, refuse to drop
  // anything this turn — just discard and try again next turn.
  const dropsWouldDeadlock =
    !situation.firstDropDone &&
    situation.mustFirstDropReach100 &&
    !canReachHundred(plan);
  if (dropsWouldDeadlock) {
    const recent = match.discard.slice(-6);
    return { type: 'move-discard', cardId: pickCardToDiscard(hand, situation, recent) };
  }

  // ---------- Priority 0: race to close ----------------------------------
  //
  // If bhukara is already with us and we have a ganastha, aggressively try to
  // empty hand — every drop reduces the penalty pool and lets us close on
  // discard.
  if (situation.bhukaraMine && situation.hasFullMeld) {
    const drop = pickBestDrop(plan, situation, hand, /* aggressive */ true);
    if (drop) return drop;
  }

  // ---------- Priority 1: ganastha jump ---------------------------------
  //
  // Any addition that pushes a team meld across 7 cards is our best move. It
  // unlocks closing, harvests the size bonus (100 or 200), and locks value we
  // can't lose. Prefer the addition that reaches the highest final size.
  const jumpAdd = pickGanasthaJump(plan, situation, hand);
  if (jumpAdd) return jumpAdd;

  // ---------- Priority 2: satisfy first-drop rule ------------------------
  //
  // Team's first drop must include a pure sequence, and (if past 1000) total
  // ≥100 pts. Delay unless we have a decent one so we don't burn a 3-card
  // sequence prematurely.
  if (!situation.firstDropDone) {
    const firstDrop = pickFirstDrop(plan, situation, hand);
    if (firstDrop) return firstDrop;
    // No adequate first-drop candidate → skip to discarding cleverly.
  }

  // ---------- Priority 3: extend existing team melds --------------------
  //
  // Any real growth on a team meld is valuable — it locks card value and
  // steadily reduces our hand.
  if (situation.myTeamMelds.length > 0) {
    const growth = plan.additions
      .slice()
      .sort((a, b) => additionLen(b) - additionLen(a));
    for (const g of growth) {
      const addLen = additionLen(g);
      if (addLen === 0) continue;
      if (hand.length - addLen < 1) continue;
      if (g.kind === 'sequence' && g.seqAdd) {
        return {
          type: 'move-add-to-sequence',
          input: { meldId: g.meldId, additions: g.seqAdd },
        };
      }
      if (g.kind === 'triplet' && g.tripAdd) {
        return {
          type: 'move-add-to-triplet',
          input: { meldId: g.meldId, additions: g.tripAdd },
        };
      }
    }
  }

  // ---------- Priority 4: drop new melds --------------------------------
  //
  // In build mode we require size ≥ 4 for pure sequences (a 3-run tends to be
  // extendable next turn from stock or discards; keeping it in hand keeps
  // options open). In endgame or racing mode we accept 3-card drops because
  // speed matters more than sizing.
  const minPure = endgame || racing ? 3 : 4;
  const drop = pickBestDrop(plan, situation, hand, /* aggressive */ endgame, minPure);
  if (drop) return drop;

  // ---------- Priority 5: discard ---------------------------------------
  const recent = match.discard.slice(-6);
  const discardId = pickCardToDiscard(hand, situation, recent);
  return { type: 'move-discard', cardId: discardId };
}

// Total cards contributed by an addition.
function additionLen(a: PlayPlan['additions'][number]): number {
  return (a.seqAdd?.length ?? 0) + (a.tripAdd?.length ?? 0);
}

// Look for an add-to-meld that pushes an existing team meld ≥7 cards.
function pickGanasthaJump(
  plan: PlayPlan,
  situation: Situation,
  hand: Card[],
): MoveMessage | null {
  let best: { g: PlayPlan['additions'][number]; final: number } | null = null;
  for (const g of plan.additions) {
    const meld = situation.myTeamMelds.find((m) => m.id === g.meldId)!;
    const finalSize = meld.cards.length + additionLen(g);
    if (finalSize < 7) continue;
    if (hand.length - additionLen(g) < 1) continue; // must keep a discard
    if (!best || finalSize > best.final) best = { g, final: finalSize };
  }
  if (!best) return null;
  if (best.g.kind === 'sequence' && best.g.seqAdd) {
    return {
      type: 'move-add-to-sequence',
      input: { meldId: best.g.meldId, additions: best.g.seqAdd },
    };
  }
  if (best.g.kind === 'triplet' && best.g.tripAdd) {
    return {
      type: 'move-add-to-triplet',
      input: { meldId: best.g.meldId, additions: best.g.tripAdd },
    };
  }
  return null;
}

// Pick a first drop: a pure sequence that meets any first-drop constraints.
//
// For 1000+ teams the first drop must total >=100 pts, else `discard` will
// reject and the bot's turn deadlocks. Return null (defer this turn's drop)
// unless we're confident the whole plan can clear that bar.
function pickFirstDrop(
  plan: PlayPlan,
  situation: Situation,
  hand: Card[],
): MoveMessage | null {
  const candidates = plan.pureSequences
    .slice()
    .filter((s) => hand.length - s.length >= 1)
    .sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return null;
  const seq = candidates[0];
  const needs100 = situation.mustFirstDropReach100;

  if (needs100) {
    // Estimate the max total this turn: this pure seq + best triplet +
    // best impure sequence we could realistically drop after it, all
    // without over-committing a single card. Rough upper bound, since
    // additions to *existing* team melds don't count toward the 100.
    const seqPts = pointsOf(seq);
    const usedIds = new Set(seq.map((m) => m.card.id));
    const bestTrip = plan.triplets
      .filter((t) => t.every((m) => !usedIds.has(m.card.id)))
      .sort((a, b) => pointsOf(b) - pointsOf(a))[0];
    if (bestTrip) bestTrip.forEach((m) => usedIds.add(m.card.id));
    const bestImpure = plan.impureSequences
      .filter((s) => s.every((m) => !usedIds.has(m.card.id)))
      .sort((a, b) => pointsOf(b) - pointsOf(a))[0];
    const upperBound =
      seqPts +
      (bestTrip ? pointsOf(bestTrip) : 0) +
      (bestImpure ? pointsOf(bestImpure) : 0);
    // Leave one card in hand for the discard, and be a little conservative —
    // if the plan barely scrapes past 100 we're still risking a stall if any
    // meld silently drops out. Require a small buffer.
    if (upperBound < 110) return null;
  }
  return { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } };
}

function pointsOf(cards: { card: Card }[]): number {
  return cards.reduce((s, m) => s + cardValue(m.card.rank), 0);
}

// Rough upper bound on the meld pts a 1000+ team can drop this turn from the
// current plan. If it's short of 110, refuse to start the first drop — we'd
// deadlock the discard.
function canReachHundred(plan: PlayPlan): boolean {
  const bestPure = plan.pureSequences.sort((a, b) => pointsOf(b) - pointsOf(a))[0];
  if (!bestPure) return false;
  const used = new Set<string>(bestPure.map((m) => m.card.id));
  const bestTrip = plan.triplets
    .filter((t) => t.every((m) => !used.has(m.card.id)))
    .sort((a, b) => pointsOf(b) - pointsOf(a))[0];
  if (bestTrip) bestTrip.forEach((m) => used.add(m.card.id));
  const bestImpure = plan.impureSequences
    .filter((s) => s.every((m) => !used.has(m.card.id)))
    .sort((a, b) => pointsOf(b) - pointsOf(a))[0];
  const total =
    pointsOf(bestPure) +
    (bestTrip ? pointsOf(bestTrip) : 0) +
    (bestImpure ? pointsOf(bestImpure) : 0);
  return total >= 110;
}

// Pick the strongest new meld to drop. `minPure` filters pure sequences.
// Aggressive mode accepts smaller melds because closing/reducing hand matters
// more than perfect sizing.
// Gap-bridging awareness. If we drop this candidate as a NEW meld, would we
// forfeit the chance to fuse it into an existing same-suit team meld sitting
// 1-2 slots away? Example: team has 7-8-9 diamonds already, our candidate is
// J-Q-K diamonds, gap = slot 10. Dropping both separately locks in two small
// melds; holding J-Q-K until we draw a 10 grows the 7-8-9 to seven cards
// (which unlocks the +200 pure-sequence bonus).
//
// Returns the gap size (missing slot count) if a bridge candidate exists,
// else null. Only checks pure sequences — impure/joker cases are handled by
// the joker economy rules already.
function bridgesToExistingMeld(
  candidate: SequenceMeldCard[],
  teamMelds: Meld[],
): number | null {
  if (candidate.length === 0) return null;
  const suit = candidate[0].card.suit;
  const cSlots = candidate.map((m) => m.actingAs as number).sort((a, b) => a - b);
  const cMin = cSlots[0];
  const cMax = cSlots[cSlots.length - 1];

  let smallestGap: number | null = null;
  for (const meld of teamMelds) {
    if (meld.kind !== 'sequence' || meld.suit !== suit) continue;
    const mSlots = meld.cards.map((c) => c.actingAs as number).sort((a, b) => a - b);
    const mMin = mSlots[0];
    const mMax = mSlots[mSlots.length - 1];
    // Candidate sits above the meld, missing (cMin - mMax - 1) slots between.
    const gapAbove = cMin - mMax - 1;
    // Candidate sits below the meld.
    const gapBelow = mMin - cMax - 1;
    for (const g of [gapAbove, gapBelow]) {
      if (g > 0 && g <= 2) {
        if (smallestGap === null || g < smallestGap) smallestGap = g;
      }
    }
  }
  return smallestGap;
}

// Scoring penalty when the bot considers dropping a new triplet. Prior
// version only penalized mid-rank (4-10); real matches then produced 8
// triplets vs 2 sequences in a single team's play because high-rank (J,
// Q, K, A) triplets came through unpenalized and mid-rank ones were only
// nudged. Now:
//   - Every triplet gets a base penalty (variety > stacking).
//   - Ranks 4-10 get extra, because those cards are true sequence
//     connectors — locking three of them forfeits every 3-4-5, 4-5-6,
//     5-6-7 the team could grow.
//   - Below 2 team sequences in the box, apply a ×1.5 multiplier: we
//     want the bot to actively try for a second sequence before piling
//     up triplets.
//   - Racing / endgame skips the whole thing — closing beats variety.
function tripletDropPenalty(
  rank: number,
  situation: Situation,
  aggressive: boolean,
): number {
  if (aggressive || situation.bhukaraTaken || situation.oppMinHand <= 4) return 0;
  if (situation.stockRemaining <= 10) return 0;
  let penalty = 12; // base — makes every triplet a lesser move than a comparable sequence
  if (rank >= 4 && rank <= 10) penalty += 18; // connector ranks are especially costly
  const teamSeqCount = situation.myTeamMelds.filter((m) => m.kind === 'sequence').length;
  if (teamSeqCount < 2) penalty = Math.round(penalty * 1.5);
  return penalty;
}

function pickBestDrop(
  plan: PlayPlan,
  situation: Situation,
  hand: Card[],
  aggressive: boolean,
  minPure = 3,
): MoveMessage | null {
  type Candidate = { input: MoveMessage; score: number };
  const candidates: Candidate[] = [];

  // Pure sequences — prefer bigger. If the candidate bridges to an existing
  // team meld and we still have time to wait for the connector card, skip
  // it. In aggressive/endgame mode the bird-in-hand wins, so we take the
  // small meld now rather than wait.
  for (const seq of plan.pureSequences) {
    if (seq.length < minPure) continue;
    if (hand.length - seq.length < 1) continue;
    const gap = bridgesToExistingMeld(seq, situation.myTeamMelds);
    if (gap !== null && !aggressive) {
      // Hold the candidate — dropping it now locks us out of the merger.
      continue;
    }
    const pts = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
    const bonus = seq.length >= 7 ? 200 : 0;
    candidates.push({
      input: { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } },
      score: pts + bonus + seq.length * 6, // length matters
    });
  }
  // Triplets — only after team has a pure sequence in box. Mid-rank ranks
  // (4-10) are the "connector" cards for sequences; locking three of them
  // into a triplet forfeits every 3-4-5, 4-5-6, 5-6-7 you might have grown.
  // Penalize those so a bigger pure sequence or a high-rank triplet beats
  // them out, unless we're in endgame / racing (where closing beats
  // preserving flexibility).
  if (situation.hasPureInBox) {
    for (const trip of plan.triplets) {
      if (trip.length < 3) continue;
      if (hand.length - trip.length < 1) continue;
      const pts = trip.reduce((s, m) => s + cardValue(m.card.rank), 0);
      const penalty = tripletDropPenalty(trip[0].card.rank, situation, aggressive);
      candidates.push({
        input: { type: 'move-drop-meld', input: { kind: 'triplet', cards: trip } },
        score: pts + trip.length * 4 - penalty,
      });
    }
  }
  // Impure sequences — 2s go to jokers. The user complaint that surfaced
  // this tightening: bot dropped "SEQ ♣ 40PT IMPURE" as 8-9-2j-J (4 cards,
  // 1 joker). Impure < 7 earns ZERO size bonus, so the joker was spent for
  // raw card value only, when it was worth several times more saved for a
  // triplet ganastha jump (+100) or a bigger bridge later.
  //
  // Tightened bar:
  //   - Non-aggressive: 1-joker needs ≥5 cards (was 4), 2-joker needs ≥6.
  //   - Joker cost in the scorer is much higher when the meld doesn't reach
  //     ganastha (no bonus to earn).
  if (situation.hasPureInBox) {
    for (const seq of plan.impureSequences) {
      const jokerCount = seq.filter((m) => m.isJoker).length;
      const minSize = aggressive ? 3 : (jokerCount <= 1 ? 5 : 6);
      if (seq.length < minSize) continue;
      if (hand.length - seq.length < 1) continue;
      const pts = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
      const reachesGanastha = seq.length >= 7;
      // A joker in a ganastha impure earns its +100 bonus; anywhere shorter
      // it's just consuming a wildcard for card-value scraps.
      const jokerCost = reachesGanastha ? 10 : 22;
      candidates.push({
        input: { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } },
        score: pts + seq.length * 5 - jokerCount * jokerCost,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.input ?? null;
}

// Which card of the hand should we throw? Every candidate is scored on:
//   keep      — how much it contributes to potential future melds
//   feeds     — whether discarding it likely helps an opponent
//   value     — the penalty it costs if we get caught with it
// The card with the LOWEST total keep + feed penalty is thrown; ties broken by
// preferring higher-value cards (cheaper to dump).
function pickCardToDiscard(
  hand: Card[],
  situation: Situation,
  recentDiscards: Card[],
): string {
  const bySuit: Record<Suit, Card[]> = { H: [], D: [], C: [], S: [] };
  for (const c of hand) bySuit[c.suit].push(c);
  for (const arr of Object.values(bySuit)) arr.sort((a, b) => a.rank - b.rank);
  const rankCounts: Record<number, number> = {};
  for (const c of hand) rankCounts[c.rank] = (rankCounts[c.rank] ?? 0) + 1;

  // 2s are strictly reserved as jokers — never discardable unless we truly
  // hold nothing else, which never happens in practice.
  const nonJokers = hand.filter((c) => c.rank !== JOKER_RANK);

  // Same-suit neighbours within ±2 ranks: count how many. More neighbours =
  // stronger partial run and worse to break.
  function suitNeighbours(c: Card): number {
    return (bySuit[c.suit] ?? []).filter(
      (o) => o.id !== c.id && Math.abs(o.rank - c.rank) <= 2,
    ).length;
  }
  // Direct adjacencies (rank ±1 same suit) are the strongest kind of keep.
  function adjacentSameSuit(c: Card): boolean {
    return (bySuit[c.suit] ?? []).some(
      (o) => o.id !== c.id && Math.abs(o.rank - c.rank) === 1,
    );
  }
  // Partial triplet: at least one other copy of same rank in hand.
  function partialTriplet(c: Card): number {
    return (rankCounts[c.rank] ?? 0) - 1;
  }
  // Extends an existing team meld — a card at slot ±1 of a same-suit
  // sequence, or a triplet match. Direct extensions are the highest keep.
  function extendsMyMeld(c: Card): boolean {
    for (const m of situation.myTeamMelds) {
      if (m.kind === 'sequence' && m.suit === c.suit) {
        const positions = m.cards.map((cc) => cc.actingAs as number);
        const min = Math.min(...positions), max = Math.max(...positions);
        if (c.rank === min - 1 || c.rank === max + 1) return true;
        if (c.rank === 1 && max === 13) return true;
      } else if (m.kind === 'triplet' && m.rank === c.rank) {
        return true;
      }
    }
    return false;
  }
  // Connector cards — same-suit cards 2-3 slots away from a team sequence,
  // valuable because they'd bridge a small gap and let two melds fuse into
  // one big ganastha. Weaker than a direct extension but still worth keeping.
  function isBridgeConnector(c: Card): boolean {
    if (c.rank === JOKER_RANK) return false;
    for (const m of situation.myTeamMelds) {
      if (m.kind !== 'sequence' || m.suit !== c.suit) continue;
      const positions = m.cards.map((cc) => cc.actingAs as number);
      const min = Math.min(...positions), max = Math.max(...positions);
      // 2 or 3 slots beyond either endpoint — the classic bridge zone.
      if (c.rank === min - 2 || c.rank === min - 3) return true;
      if (c.rank === max + 2 || c.rank === max + 3) return true;
    }
    return false;
  }

  function keepScore(c: Card): number {
    let s = 0;
    s += suitNeighbours(c) * 2;
    if (adjacentSameSuit(c)) s += 4;
    s += partialTriplet(c) * 4;
    if (extendsMyMeld(c)) s += 10; // huge — a card that grows an existing meld
    if (isBridgeConnector(c)) s += 7; // strong — the card that fuses two
    return s;
  }

  // Feed-opponent penalty: opponents recently discarding ranks near c means
  // they're not building around c themselves, so it's slightly safer. But
  // recent discards near c also means they might now WANT c because they've
  // shed similar cards. We treat "adjacent rank in recent discards" as unsafe
  // because it suggests an opponent is building a run there.
  const recentRanks = new Set<number>(recentDiscards.map((c) => c.rank as number));
  function feedsOpponent(c: Card): number {
    let p = 0;
    if (recentRanks.has(c.rank - 1) || recentRanks.has(c.rank + 1)) p += 3;
    if (recentRanks.has(c.rank)) p += 2; // opponent may want the pair
    // High cards (Ks, Qs) are dangerous to feed — they anchor sequences AND
    // give opponents big penalty relief.
    if (c.rank >= 10 || c.rank === 1) p += 1;
    return p;
  }

  const scored = nonJokers.map((c) => ({
    c,
    keep: keepScore(c),
    val: cardValue(c.rank),
    feeds: feedsOpponent(c),
  }));

  // Sort: keep low + feeds low come first. If both tie, dump the higher-value
  // card so leftover hand carries less penalty risk.
  scored.sort((a, b) => {
    const totalA = a.keep + a.feeds;
    const totalB = b.keep + b.feeds;
    if (totalA !== totalB) return totalA - totalB;
    return b.val - a.val;
  });
  return (scored[0]?.c ?? nonJokers[0] ?? hand[0]).id;
}

// ---------------- Main entry --------------------------------------------

export function pickBotMove(match: Match, seat: PlayerId): MoveMessage | null {
  if (match.phase !== 'playing') return null;
  if (match.currentTurn !== seat) return null;

  const situation = readSituation(match, seat);

  if (match.turnPhase === 'awaiting-draw') return pickDraw(situation, match);
  if (match.turnPhase === 'may-meld') return pickMeldOrDiscard(match, seat, situation);
  return null;
}
