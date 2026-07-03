import type {
  Card,
  Match,
  Meld,
  PlayerId,
  SequenceMeld,
  SequenceMeldCard,
  SeqPos,
  TripletMeld,
  TripletMeldCard,
} from './types';
import { JOKER_RANK } from './types';
import type { SequenceAttempt, TripletAttempt } from './melds';
import { validateSequence, validateTriplet } from './melds';
import { meldCardTotal, isPureSequence } from './scoring';

// Every move returns either the next Match state or a rejection reason.
export type MoveResult =
  | { ok: true; match: Match }
  | { ok: false; reason: string };

// ---- Helpers -----------------------------------------------------------

function currentPlayer(match: Match) {
  return match.players[match.currentTurn];
}

function currentTeam(match: Match) {
  return match.teams[currentPlayer(match).teamId];
}

// Removes cards from a player's hand by id. Returns updated hand or null if
// any id was not found.
function removeFromHand(hand: Card[], ids: string[]): Card[] | null {
  const set = new Set(ids);
  const kept = hand.filter((c) => !set.has(c.id));
  if (kept.length !== hand.length - ids.length) return null;
  return kept;
}

// Team box holds at least one pure sequence after all pending changes.
function boxHasPureSequence(box: Meld[]): boolean {
  return box.some((m) => isPureSequence(m));
}


// Advance to the next player and reset per-turn state. If the deck has
// run out, the match ends here — no player should sit with a phantom draw.
// Bhukara-taken teams still score normally with whatever's on the table;
// otherwise it's a void match (no score change for the round).
function advanceTurn(match: Match): Match {
  const next = ((match.currentTurn + 1) % 4) as PlayerId;
  const advanced: Match = {
    ...match,
    currentTurn: next,
    turnPhase: 'awaiting-draw',
    meldsCreatedThisTurn: [],
  };
  if (advanced.stock.length === 0) {
    return {
      ...advanced,
      phase: advanced.bhukaraTakenBy !== null ? 'ended-normal' : 'ended-void',
    };
  }
  return advanced;
}

// ---- Move: draw stock --------------------------------------------------

export function drawStock(match: Match): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'awaiting-draw') return { ok: false, reason: 'Not in draw phase' };
  if (match.stock.length === 0) return { ok: false, reason: 'Stock is empty' };
  const [top, ...rest] = match.stock;
  const player = currentPlayer(match);
  return {
    ok: true,
    match: {
      ...match,
      stock: rest,
      players: {
        ...match.players,
        [player.id]: { ...player, hand: [...player.hand, top] },
      },
      turnPhase: 'may-meld',
    },
  };
}

// ---- Move: pick up discard pile ---------------------------------------

export function pickDiscard(match: Match): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'awaiting-draw') return { ok: false, reason: 'Not in draw phase' };
  if (match.discard.length === 0) return { ok: false, reason: 'Discard pile is empty' };
  const player = currentPlayer(match);
  return {
    ok: true,
    match: {
      ...match,
      discard: [],
      players: {
        ...match.players,
        [player.id]: { ...player, hand: [...player.hand, ...match.discard] },
      },
      turnPhase: 'may-meld',
    },
  };
}

// ---- Move: drop a new meld to team's sequence box ---------------------

export type DropSequenceInput = { kind: 'sequence'; cards: SequenceAttempt };
export type DropTripletInput = { kind: 'triplet'; cards: TripletAttempt };
export type DropMeldInput = DropSequenceInput | DropTripletInput;

export function dropMeld(match: Match, input: DropMeldInput): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'may-meld') return { ok: false, reason: 'Must draw before melding' };

  const player = currentPlayer(match);
  const team = currentTeam(match);

  const cardIds = input.cards.map((c) => c.card.id);
  const newHand = removeFromHand(player.hand, cardIds);
  if (newHand === null) return { ok: false, reason: 'Meld includes cards not in your hand' };

  let meld: Meld;
  if (input.kind === 'sequence') {
    const v = validateSequence(input.cards);
    if (!v.ok) return { ok: false, reason: v.reason };
    meld = v.meld;
  } else {
    // Triplets are only allowed once team's box has at least one pure sequence.
    // This applies even if the triplet is being added same-turn as a pure sequence —
    // the pure sequence must be dropped first.
    if (!boxHasPureSequence(team.sequenceBox)) {
      return { ok: false, reason: 'Cannot drop a triplet before team has a pure sequence in the box' };
    }
    const v = validateTriplet(input.cards);
    if (!v.ok) return { ok: false, reason: v.reason };
    meld = v.meld;
  }

  // If team's very first drop, the first meld must be a pure sequence.
  const isFirstEverMeld = !team.firstDropDone && team.sequenceBox.length === 0;
  if (isFirstEverMeld && !isPureSequence(meld)) {
    return { ok: false, reason: "Team's first drop must be a pure sequence" };
  }

  // 1000+ rule: on a team's first-drop turn (post-1000), all melds must come
  // from the same player. Because we don't yet know all melds, enforce
  // "matches previous same-turn dropper" here; total-sum check happens on discard.
  if (
    !team.firstDropDone &&
    team.mustFirstDropReach100 &&
    match.meldsCreatedThisTurn.length > 0
  ) {
    // Someone already dropped this turn — must be same player (enforced by turn ownership,
    // since only current player can drop). Silent OK.
  }

  const newBox = [...team.sequenceBox, meld];
  const newTeam = {
    ...team,
    sequenceBox: newBox,
    // firstDropByPlayer is provisionally the current player; committed at discard.
    firstDropByPlayer: team.firstDropDone ? team.firstDropByPlayer : player.id,
  };

  return {
    ok: true,
    match: {
      ...match,
      players: {
        ...match.players,
        [player.id]: { ...player, hand: newHand },
      },
      teams: { ...match.teams, [team.id]: newTeam },
      meldsCreatedThisTurn: [...match.meldsCreatedThisTurn, meld.id],
    },
  };
}

// ---- Move: add cards to an existing sequence --------------------------

// Optional joker-position adjustment applied to an already-in-meld card by id.
export type JokerMove = { cardId: string; newActingAs: SeqPos };

// Reinterpret an already-committed card's role in the meld. Lets the user
// switch a natural 2 to a joker (or a joker back to natural) at the same time
// as adding cards. Only 2s can flip to isJoker=true; validation enforces that.
export type CardReassignment = { cardId: string; newActingAs: SeqPos; newIsJoker: boolean };

export type AddToSequenceInput = {
  meldId: string;
  additions: SequenceMeldCard[]; // cards leaving hand
  jokerMoves?: JokerMove[]; // repositioning already-committed joker(s)
  cardReassignments?: CardReassignment[]; // reinterpret existing cards' roles
};

export function addToSequence(match: Match, input: AddToSequenceInput): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'may-meld') return { ok: false, reason: 'Must draw before melding' };

  const player = currentPlayer(match);
  // A player may add to their own team's melds only.
  const teamId = player.teamId;
  const team = match.teams[teamId];
  const meld = team.sequenceBox.find((m) => m.id === input.meldId);
  if (!meld) return { ok: false, reason: 'Meld not found in your team box' };
  if (meld.kind !== 'sequence') return { ok: false, reason: 'Target is not a sequence' };

  // Remove additions from hand.
  const cardIds = input.additions.map((a) => a.card.id);
  const newHand = removeFromHand(player.hand, cardIds);
  if (newHand === null) return { ok: false, reason: 'Additions include cards not in your hand' };

  // Build the updated sequence: existing cards (with joker repositioning and
  // role reassignments) + additions.
  const jokerMap = new Map<string, SeqPos>();
  (input.jokerMoves ?? []).forEach((jm) => jokerMap.set(jm.cardId, jm.newActingAs));

  const reassignMap = new Map<string, CardReassignment>();
  (input.cardReassignments ?? []).forEach((r) => reassignMap.set(r.cardId, r));

  // Sanity-check reassignments before applying.
  for (const r of input.cardReassignments ?? []) {
    const original = meld.cards.find((c) => c.card.id === r.cardId);
    if (!original) return { ok: false, reason: 'reassignment targets a card not in this meld' };
    if (r.newIsJoker && original.card.rank !== JOKER_RANK) {
      return { ok: false, reason: 'only 2s can act as jokers' };
    }
  }

  const existingUpdated: SequenceMeldCard[] = meld.cards.map((c) => {
    // Reassignment wins over a plain joker move — it can flip roles too.
    const reassign = reassignMap.get(c.card.id);
    if (reassign) {
      return { card: c.card, actingAs: reassign.newActingAs, isJoker: reassign.newIsJoker };
    }
    const move = jokerMap.get(c.card.id);
    if (move !== undefined) {
      return { ...c, actingAs: move };
    }
    return c;
  });

  // Ensure jokerMoves only referenced joker cards (unless the same card is
  // being reassigned — then the reassignment covers it).
  for (const jm of input.jokerMoves ?? []) {
    if (reassignMap.has(jm.cardId)) continue;
    const original = meld.cards.find((c) => c.card.id === jm.cardId);
    if (!original) return { ok: false, reason: 'jokerMove targets a card not in this meld' };
    if (!original.isJoker) return { ok: false, reason: 'jokerMove targets a non-joker card' };
  }

  const combined = [...existingUpdated, ...input.additions];
  const v = validateSequence(combined);
  if (!v.ok) return { ok: false, reason: v.reason };

  // Invariant: team box must still have at least one pure sequence.
  const updatedMeld: SequenceMeld = { ...v.meld, id: meld.id }; // preserve id
  const newBox = team.sequenceBox.map((m) => (m.id === meld.id ? updatedMeld : m));
  if (!boxHasPureSequence(newBox)) {
    return { ok: false, reason: 'Team must always keep at least one pure sequence in the box' };
  }

  return {
    ok: true,
    match: {
      ...match,
      players: {
        ...match.players,
        [player.id]: { ...player, hand: newHand },
      },
      teams: { ...match.teams, [teamId]: { ...team, sequenceBox: newBox } },
    },
  };
}

// ---- Move: add cards to an existing triplet ---------------------------

export type AddToTripletInput = {
  meldId: string;
  additions: TripletMeldCard[];
};

export function addToTriplet(match: Match, input: AddToTripletInput): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'may-meld') return { ok: false, reason: 'Must draw before melding' };

  const player = currentPlayer(match);
  const team = match.teams[player.teamId];
  const meld = team.sequenceBox.find((m) => m.id === input.meldId);
  if (!meld) return { ok: false, reason: 'Meld not found in your team box' };
  if (meld.kind !== 'triplet') return { ok: false, reason: 'Target is not a triplet' };

  const cardIds = input.additions.map((a) => a.card.id);
  const newHand = removeFromHand(player.hand, cardIds);
  if (newHand === null) return { ok: false, reason: 'Additions include cards not in your hand' };

  const combined = [...meld.cards, ...input.additions];
  const v = validateTriplet(combined);
  if (!v.ok) return { ok: false, reason: v.reason };

  const updatedMeld: TripletMeld = { ...v.meld, id: meld.id };
  const newBox = team.sequenceBox.map((m) => (m.id === meld.id ? updatedMeld : m));
  if (!boxHasPureSequence(newBox)) {
    return { ok: false, reason: 'Team must always keep at least one pure sequence in the box' };
  }

  return {
    ok: true,
    match: {
      ...match,
      players: {
        ...match.players,
        [player.id]: { ...player, hand: newHand },
      },
      teams: { ...match.teams, [player.teamId]: { ...team, sequenceBox: newBox } },
    },
  };
}

// ---- Move: move a joker within its current sequence -------------------

export function moveJoker(
  match: Match,
  meldId: string,
  jokerCardId: string,
  newActingAs: SeqPos,
): MoveResult {
  // A joker-only movement is a special case of addToSequence with no additions.
  return addToSequence(match, {
    meldId,
    additions: [],
    jokerMoves: [{ cardId: jokerCardId, newActingAs }],
  });
}

// ---- Move: discard to end turn ----------------------------------------

// After discard we may need to handle:
//   • hand hits 0 with bhukara not yet taken → award +50, hand becomes bhukara,
//     same player continues (turnPhase reset to may-meld — they must eventually discard again)
//   • hand hits 0 with bhukara already taken → close the match, +50, phase='ended-normal'
//   • otherwise → advance turn to next player
//
// Also enforces the team's first-drop rules that we couldn't verify at drop time
// (single-player rule, 100+ sum for 1000+ teams).

export function discard(match: Match, cardId: string): MoveResult {
  if (match.phase !== 'playing') return { ok: false, reason: 'Match is over' };
  if (match.turnPhase !== 'may-meld') return { ok: false, reason: 'Not ready to discard' };

  const player = currentPlayer(match);
  const team = currentTeam(match);
  const card = player.hand.find((c) => c.id === cardId);
  if (!card) return { ok: false, reason: 'That card is not in your hand' };

  // First-drop-this-turn validation.
  //
  // Two constraints apply on the turn a team's first drop happens:
  //   (a) the melds dropped this turn must include at least one pure sequence
  //   (b) if the team is past 1000, the total value must be >=100
  //
  // If either constraint fails, the discard doesn't reject (deadlock). Instead
  // we RESCUE the turn: every meld created this turn is undone (cards go back
  // to the player's hand) and the team takes a -200 penalty added to the
  // match score. The player still discards, the turn still ends. The mistake
  // has a cost but the game keeps moving.
  const firstDropThisTurn =
    !team.firstDropDone && match.meldsCreatedThisTurn.length > 0;
  let rescueApplied = false;
  let rescuedCards: Card[] = [];
  let workingTeam = team;
  let workingHand = player.hand;
  if (firstDropThisTurn) {
    const meldsThisTurn = team.sequenceBox.filter((m) =>
      match.meldsCreatedThisTurn.includes(m.id),
    );
    const hasPure = meldsThisTurn.some((m) => isPureSequence(m));
    const totalThisTurn = meldsThisTurn.reduce((s, m) => s + meldCardTotal(m), 0);
    const under100 = team.mustFirstDropReach100 && totalThisTurn < 100;
    if (!hasPure || under100) {
      rescueApplied = true;
      // Pull every card out of every meld dropped this turn, back into the
      // player's hand. Remove those melds from the sequenceBox.
      for (const m of meldsThisTurn) {
        for (const mc of m.cards) rescuedCards.push(mc.card);
      }
      workingHand = [...player.hand, ...rescuedCards];
      const rescuedBox = team.sequenceBox.filter(
        (m) => !match.meldsCreatedThisTurn.includes(m.id),
      );
      workingTeam = {
        ...team,
        sequenceBox: rescuedBox,
        midMatchPenalty: team.midMatchPenalty + 200,
      };
      // Verify the discard card is still available after the rescue.
      if (!workingHand.some((c) => c.id === cardId)) {
        return { ok: false, reason: 'That card is not in your hand' };
      }
    }
  }

  // Perform the discard.
  const newHand = workingHand.filter((c) => c.id !== cardId);
  const newDiscard = [...match.discard, card];

  // Commit team first-drop if we validated one this turn (no rescue path).
  const teamAfterCommit = rescueApplied
    ? workingTeam
    : firstDropThisTurn
    ? { ...workingTeam, firstDropDone: true, firstDropByPlayer: player.id }
    : workingTeam;

  let next: Match = {
    ...match,
    discard: newDiscard,
    players: {
      ...match.players,
      [player.id]: { ...player, hand: newHand },
    },
    teams: { ...match.teams, [team.id]: teamAfterCommit },
    meldsCreatedThisTurn: [],
  };

  // Hand hits 0 — check bhukara / closing.
  if (newHand.length === 0) {
    if (next.bhukaraTakenBy === null) {
      // Award bhukara: current player takes the 13-card pile.
      next = {
        ...next,
        bhukara: [],
        bhukaraTakenBy: player.id,
        players: {
          ...next.players,
          [player.id]: { ...next.players[player.id], hand: next.bhukara },
        },
        turnPhase: 'may-meld', // same player continues; must discard again eventually
      };
      return { ok: true, match: next };
    } else {
      // Match closes — but only if the team has completed at least one 7+ card
      // meld (a "ganastha"). Sequence or triplet, pure or impure, either counts.
      const teamBox = next.teams[team.id].sequenceBox;
      const hasFullMeld = teamBox.some((m) => m.cards.length >= 7);
      if (!hasFullMeld) {
        return {
          ok: false,
          reason: 'Cannot close: your team needs at least one 7-card meld first',
        };
      }
      next = {
        ...next,
        phase: 'ended-normal',
        closedBy: player.id,
      };
      return { ok: true, match: next };
    }
  }

  // Stock/pile bookkeeping — if stock exhausts and nobody has picked bhukara,
  // we DO NOT void here (spec says match ends only when the next player CAN'T
  // draw). Check at the next player's draw phase. For simplicity, if stock is
  // empty AND bhukara has not been taken, next player will hit the void path.
  return { ok: true, match: advanceTurn(next) };
}

// Called by the UI at the start of a player's turn (or before drawStock) to
// detect a forced end. If the deck is empty, the match is over: score if
// bhukara had been claimed, void otherwise.
export function checkVoidCondition(match: Match): Match {
  if (match.phase !== 'playing') return match;
  if (match.turnPhase !== 'awaiting-draw') return match;
  if (match.stock.length === 0) {
    return {
      ...match,
      phase: match.bhukaraTakenBy !== null ? 'ended-normal' : 'ended-void',
    };
  }
  return match;
}
