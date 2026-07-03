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

// Additions to an existing team meld. Groups all natural extensions we can
// make in one shot so the bot pumps the meld toward 7+ in one call.
function findAdditionsForMeld(
  hand: Card[],
  meld: Meld,
): PlayPlan['additions'][number] | null {
  if (meld.kind === 'sequence') {
    const suit = meld.suit;
    const positions = new Set(meld.cards.map((c) => c.actingAs as number));
    const min = Math.min(...positions);
    const max = Math.max(...positions);
    const additions: SequenceMeldCard[] = [];
    // Consume same-suit naturals that extend either end contiguously.
    const same = hand
      .filter((c) => c.suit === suit && c.rank !== JOKER_RANK)
      .sort((a, b) => a.rank - b.rank);
    // Grow high end.
    let highCursor = max;
    for (const c of same) {
      if (c.rank === highCursor + 1 && highCursor + 1 <= 13) {
        additions.push({ card: c, actingAs: (highCursor + 1) as SeqPos, isJoker: false });
        highCursor++;
      }
    }
    // Grow low end.
    let lowCursor = min;
    // Include Ace-high (13→14) only via the high grow above.
    // Iterate largest-to-smallest for low extension.
    const usedIds = new Set(additions.map((a) => a.card.id));
    for (const c of [...same].reverse()) {
      if (usedIds.has(c.id)) continue;
      if (c.rank === lowCursor - 1 && lowCursor - 1 >= 1) {
        additions.push({ card: c, actingAs: (lowCursor - 1) as SeqPos, isJoker: false });
        lowCursor--;
      }
    }
    // Ace-high extension when meld tops out at K (13).
    if (max === 13) {
      const ace = hand.find((c) => c.suit === suit && c.rank === 1 && !usedIds.has(c.id));
      if (ace) {
        additions.push({ card: ace, actingAs: 14 as SeqPos, isJoker: false });
      }
    }
    if (additions.length === 0) return null;
    return { meldId: meld.id, kind: 'sequence', seqAdd: additions };
  }
  // Triplet — add every natural card of the meld's rank.
  const rank = meld.rank;
  const naturals = hand.filter((c) => c.rank === rank);
  if (naturals.length === 0) return null;
  return {
    meldId: meld.id,
    kind: 'triplet',
    tripAdd: naturals.map((c) => ({ card: c, isJoker: false })),
  };
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
function pickMeldOrDiscard(
  match: Match,
  seat: PlayerId,
  situation: Situation,
): MoveMessage {
  const plan = buildPlayPlan(situation);
  const hand = situation.hand;

  // ---------- Priority 1: grow an existing meld toward 7 -----------------
  //
  // If there's a team meld < 7 that we can extend, prefer that over dropping
  // new stuff — a bigger meld earns bigger bonuses and unlocks closing.
  const growth = plan.additions
    .filter((a) => {
      const meld = situation.myTeamMelds.find((m) => m.id === a.meldId)!;
      const currentLen = meld.cards.length;
      const addLen = (a.seqAdd?.length ?? 0) + (a.tripAdd?.length ?? 0);
      return currentLen + addLen >= currentLen + 1 && currentLen < 13; // any real growth
    })
    .sort((a, b) => {
      const aLen = (a.seqAdd?.length ?? 0) + (a.tripAdd?.length ?? 0);
      const bLen = (b.seqAdd?.length ?? 0) + (b.tripAdd?.length ?? 0);
      return bLen - aLen;
    });

  // We may only extend melds after the team's first drop (server enforces the
  // first-drop-includes-a-pure-sequence rule anyway; be conservative).
  const canAddToMelds = situation.myTeamMelds.length > 0;
  if (canAddToMelds && growth.length > 0 && hand.length > 1) {
    const first = growth[0];
    const addLen = (first.seqAdd?.length ?? 0) + (first.tripAdd?.length ?? 0);
    if (hand.length - addLen >= 1) {
      if (first.kind === 'sequence' && first.seqAdd) {
        return {
          type: 'move-add-to-sequence',
          input: { meldId: first.meldId, additions: first.seqAdd },
        };
      }
      if (first.kind === 'triplet' && first.tripAdd) {
        return {
          type: 'move-add-to-triplet',
          input: { meldId: first.meldId, additions: first.tripAdd },
        };
      }
    }
  }

  // ---------- Priority 2: first drop if we haven't done one --------------
  //
  // Must include a pure sequence. If team is past 1000, total ≥ 100.
  if (!situation.firstDropDone) {
    const pures = plan.pureSequences
      .slice()
      .sort((a, b) => b.length - a.length);
    if (pures.length > 0) {
      const seq = pures[0];
      const total = seq.reduce((s, m) => s + cardValue(m.card.rank), 0);
      const needs100 = situation.mustFirstDropReach100;
      const meetsThreshold = !needs100 || total >= 100;
      if (meetsThreshold && hand.length - seq.length >= 1) {
        return {
          type: 'move-drop-meld',
          input: { kind: 'sequence', cards: seq },
        };
      }
      // If we need ≥100 but a single seq isn't enough, drop it anyway —
      // the server will validate on discard; the bot will then add more before
      // discarding. But to keep it simple here, we still try.
      if (hand.length - seq.length >= 1) {
        return {
          type: 'move-drop-meld',
          input: { kind: 'sequence', cards: seq },
        };
      }
    }
  }

  // ---------- Priority 3: drop new pure sequences ------------------------
  const pures = plan.pureSequences
    .slice()
    .sort((a, b) => b.length - a.length);
  if (pures.length > 0 && hand.length - pures[0].length >= 1) {
    return { type: 'move-drop-meld', input: { kind: 'sequence', cards: pures[0] } };
  }

  // ---------- Priority 4: drop triplets (needs pure in box) --------------
  if (situation.hasPureInBox) {
    const trips = plan.triplets.slice().sort((a, b) => b.length - a.length);
    if (trips.length > 0 && hand.length - trips[0].length >= 1) {
      return { type: 'move-drop-meld', input: { kind: 'triplet', cards: trips[0] } };
    }
  }

  // ---------- Priority 5: impure sequences -------------------------------
  //
  // Only after the team has committed a pure sequence (impure can't satisfy
  // the pure-sequence-first-drop rule).
  if (situation.hasPureInBox) {
    const impures = plan.impureSequences.slice().sort((a, b) => b.length - a.length);
    if (impures.length > 0 && hand.length - impures[0].length >= 1) {
      return { type: 'move-drop-meld', input: { kind: 'sequence', cards: impures[0] } };
    }
  }

  // ---------- Priority 6: discard ---------------------------------------
  const recent = match.discard.slice(-4);
  const discardId = pickCardToDiscard(hand, situation, recent);
  return { type: 'move-discard', cardId: discardId };
}

// Which card of the hand should we throw? A card is a good discard when it
// contributes nothing to any partial meld and doesn't feed an opponent.
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

  // 2s are basically never discarded — they're precious jokers.
  const nonJokers = hand.filter((c) => c.rank !== JOKER_RANK);

  // Card fits a partial run if there's another same-suit card within ±2 ranks.
  function isConnected(c: Card): boolean {
    return (bySuit[c.suit] ?? []).some(
      (o) => o.id !== c.id && Math.abs(o.rank - c.rank) <= 2,
    );
  }
  // Card fits a partial triplet if we hold another copy of the same rank.
  function pairsToTriplet(c: Card): boolean {
    return (rankCounts[c.rank] ?? 0) >= 2;
  }
  // Card extends an existing team sequence (same suit, adjacent rank).
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

  // Score = higher means worse to discard (more useful to us).
  function keepScore(c: Card): number {
    let s = 0;
    if (isConnected(c)) s += 3;
    if (pairsToTriplet(c)) s += 4;
    if (extendsMyMeld(c)) s += 6;
    return s;
  }

  // Feeding opponents — if opponents just discarded ranks adjacent to c, they
  // may want it. Subtract a bit for "safe" cards.
  const recentRanks = new Set<number>(recentDiscards.map((c) => c.rank as number));
  function feedsOpponent(c: Card): boolean {
    return recentRanks.has(c.rank + 1) || recentRanks.has(c.rank - 1) || recentRanks.has(c.rank);
  }

  const scored = nonJokers.map((c) => ({
    c,
    keep: keepScore(c),
    val: cardValue(c.rank),
    feeds: feedsOpponent(c),
  }));

  // Sort: lowest keep first, then not-feeding-opponent, then highest value
  // (dumping face cards helps the opponent-penalty when they hold them, and
  // reduces our own hand risk if we get caught with them).
  scored.sort((a, b) => {
    if (a.keep !== b.keep) return a.keep - b.keep;
    if (a.feeds !== b.feeds) return a.feeds ? 1 : -1;
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
