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

  // Triplet — every natural of the meld's rank, plus at most one joker if
  // the triplet doesn't already contain one.
  const rank = meld.rank;
  const naturals = hand.filter((c) => c.rank === rank);
  const alreadyHasJoker = meld.cards.some((c) => c.isJoker);
  const additions: TripletMeldCard[] = naturals.map((c) => ({ card: c, isJoker: false }));
  if (!alreadyHasJoker && rank !== JOKER_RANK) {
    const joker = hand.find((c) => c.rank === JOKER_RANK);
    // Only spend a joker on a triplet if the meld isn't already at ganastha
    // (7+ cards) — extending an already-huge triplet with a joker is fine,
    // but past that the joker is worth more in a sequence.
    if (joker && meld.cards.length < 7) {
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
  const total = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
  const needs100 = situation.mustFirstDropReach100;
  // 3-card first drop is fine when the size or value is compelling — we've
  // been sitting on cards long enough. Only skip if it's a bare 3-card seq
  // AND we're not past 1000 AND we have a longer alternative held back.
  if (seq.length === 3 && !needs100 && candidates.length === 0) return null;
  // If we need ≥100 but this single sequence isn't enough, we still drop it;
  // add-to-meld actions on later calls can bring the turn total up before the
  // discard commits.
  if (needs100 && total < 100 && seq.length < 5) {
    // Very small seq is too weak on its own — but if it's all we have, drop
    // it and hope subsequent actions get us over 100.
  }
  return { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } };
}

// Pick the strongest new meld to drop. `minPure` filters pure sequences.
// Aggressive mode accepts smaller melds because closing/reducing hand matters
// more than perfect sizing.
function pickBestDrop(
  plan: PlayPlan,
  situation: Situation,
  hand: Card[],
  aggressive: boolean,
  minPure = 3,
): MoveMessage | null {
  type Candidate = { input: MoveMessage; score: number };
  const candidates: Candidate[] = [];

  // Pure sequences — prefer bigger.
  for (const seq of plan.pureSequences) {
    if (seq.length < minPure) continue;
    if (hand.length - seq.length < 1) continue;
    const pts = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
    const bonus = seq.length >= 7 ? 200 : 0;
    candidates.push({
      input: { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } },
      score: pts + bonus + seq.length * 6, // length matters
    });
  }
  // Triplets — only after team has a pure sequence in box.
  if (situation.hasPureInBox) {
    for (const trip of plan.triplets) {
      if (trip.length < 3) continue;
      if (hand.length - trip.length < 1) continue;
      const pts = trip.reduce((s, m) => s + cardValue(m.card.rank), 0);
      candidates.push({
        input: { type: 'move-drop-meld', input: { kind: 'triplet', cards: trip } },
        score: pts + trip.length * 4,
      });
    }
  }
  // Impure sequences — 2s go to jokers. Require size ≥ 5 (or 4 with only one
  // joker) unless we're aggressive. A 3-card impure is essentially a joker
  // set on fire.
  if (situation.hasPureInBox) {
    for (const seq of plan.impureSequences) {
      const jokerCount = seq.filter((m) => m.isJoker).length;
      const minSize = aggressive ? 3 : (jokerCount <= 1 ? 4 : 5);
      if (seq.length < minSize) continue;
      if (hand.length - seq.length < 1) continue;
      const pts = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
      // Penalize joker usage — the pts already count the joker's 10, but a
      // joker used here is a joker unavailable elsewhere.
      candidates.push({
        input: { type: 'move-drop-meld', input: { kind: 'sequence', cards: seq } },
        score: pts + seq.length * 5 - jokerCount * 12,
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
  // Extends an existing team meld.
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

  function keepScore(c: Card): number {
    let s = 0;
    s += suitNeighbours(c) * 2;
    if (adjacentSameSuit(c)) s += 4;
    s += partialTriplet(c) * 4;
    if (extendsMyMeld(c)) s += 10; // huge — a card that grows an existing meld
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
