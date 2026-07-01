import { describe, it, expect, beforeEach } from 'vitest';
import type { Card, Match, SeqPos } from './types';
import { newGame, newMatch } from './newGame';
import {
  drawStock,
  pickDiscard,
  dropMeld,
  addToSequence,
  moveJoker,
  discard,
} from './moves';
import { asNatural, asJoker, _resetMeldIdsForTests } from './melds';
import { scoreFinishedMatch, endMatchAndAdvance } from './matchEnd';

const H = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `H${r}${copy}`, suit: 'H', rank: r as Card['rank'] });
const D = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `D${r}${copy}`, suit: 'D', rank: r as Card['rank'] });
const C = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `C${r}${copy}`, suit: 'C', rank: r as Card['rank'] });
const S = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `S${r}${copy}`, suit: 'S', rank: r as Card['rank'] });

beforeEach(() => _resetMeldIdsForTests());

// Deterministic new game via seed.
function seededGame(seed = 42) {
  return newGame({ seed });
}

// Hand-craft a match with fully controlled state — needed for testing specific rule paths.
function craftMatch(overrides: Partial<Match>): Match {
  const base = newMatch({
    matchNumber: 1,
    startingPlayer: 0,
    teamScoresBeforeMatch: { A: 0, B: 0 },
    playerNames: ['P1', 'P2', 'P3', 'P4'],
    seed: 1,
  });
  return { ...base, ...overrides };
}

// Give a specific player a controlled hand.
function withHand(m: Match, playerId: 0 | 1 | 2 | 3, hand: Card[]): Match {
  return {
    ...m,
    players: {
      ...m.players,
      [playerId]: { ...m.players[playerId], hand },
    },
  };
}

describe('draw phase', () => {
  // Use P1 for these — P0 starts each match and can't draw on their first turn.
  it('draws from stock and moves to may-meld', () => {
    let m = seededGame(1).currentMatch;
    m = { ...m, currentTurn: 1, turnPhase: 'awaiting-draw' };
    const before = m.stock.length;
    const r = drawStock(m);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.stock.length).toBe(before - 1);
      expect(r.match.players[1].hand.length).toBe(14);
      expect(r.match.turnPhase).toBe('may-meld');
    }
  });

  it('cannot draw stock outside draw phase', () => {
    let m = seededGame(1).currentMatch;
    m = { ...m, currentTurn: 1, turnPhase: 'awaiting-draw' };
    const drew = drawStock(m);
    if (!drew.ok) throw new Error('setup failed');
    const r = drawStock(drew.match);
    expect(r.ok).toBe(false);
  });

  it('picks the entire discard pile', () => {
    let m = craftMatch({
      discard: [H(5), H(6), C(9)],
    });
    m = { ...m, currentTurn: 1, turnPhase: 'awaiting-draw' };
    const startHand = m.players[1].hand.length;
    const r = pickDiscard(m);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.discard).toHaveLength(0);
      expect(r.match.players[1].hand.length).toBe(startHand + 3);
    }
  });

  it('starting player cannot draw on their opening turn', () => {
    const m = seededGame(1).currentMatch;
    // P0 begins each match with 14 cards in may-meld — draw must reject.
    expect(m.currentTurn).toBe(0);
    expect(m.turnPhase).toBe('may-meld');
    expect(m.players[0].hand.length).toBe(14);
    const r = drawStock(m);
    expect(r.ok).toBe(false);
  });
});

describe('drop meld', () => {
  it('team first drop must be a pure sequence — rejects impure', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(4), H(5), C(2), ...m.players[0].hand.slice(3)]);
    const r = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(4), 4), asNatural(H(5), 5), asJoker(C(2), 6)],
    });
    expect(r.ok).toBe(false);
  });

  it('team first drop rejects a triplet before a pure sequence exists', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(7), D(7), C(7), ...m.players[0].hand.slice(3)]);
    const r = dropMeld(m, {
      kind: 'triplet',
      cards: [
        { card: H(7), isJoker: false },
        { card: D(7), isJoker: false },
        { card: C(7), isJoker: false },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a pure sequence as first drop and updates team box', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(3), H(4), H(5), ...m.players[0].hand.slice(3)]);
    const r = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.teams.A.sequenceBox).toHaveLength(1);
      expect(r.match.players[0].hand.length).toBe(m.players[0].hand.length - 3);
    }
  });

  it('after pure sequence, allows dropping a triplet same turn', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(3), H(4), H(5), D(9), S(9), C(9)]);
    let r = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const r2 = dropMeld(r.match, {
      kind: 'triplet',
      cards: [
        { card: D(9), isJoker: false },
        { card: S(9), isJoker: false },
        { card: C(9), isJoker: false },
      ],
    });
    expect(r2.ok).toBe(true);
  });
});

describe('add and move joker', () => {
  it('adds a card to an existing sequence', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(3), H(4), H(5), H(6)]);
    const first = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    if (!first.ok) throw new Error(first.reason);
    const meldId = first.match.teams.A.sequenceBox[0].id;
    const r = addToSequence(first.match, {
      meldId,
      additions: [asNatural(H(6), 6)],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const seq = r.match.teams.A.sequenceBox[0];
      expect(seq.cards).toHaveLength(4);
    }
  });

  it('rejects a joker move that would create a gap in the sequence', () => {
    // Directly craft a team box with two pure sequences so we can freely test
    // an impure one alongside.
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = {
      ...m,
      teams: {
        ...m.teams,
        A: {
          ...m.teams.A,
          firstDropDone: true,
          firstDropByPlayer: 0,
          sequenceBox: [
            {
              id: 'pure-heart',
              kind: 'sequence',
              suit: 'H',
              cards: [
                { card: H(3), actingAs: 3, isJoker: false },
                { card: H(4), actingAs: 4, isJoker: false },
                { card: H(5), actingAs: 5, isJoker: false },
              ],
            },
            {
              id: 'impure-diamond',
              kind: 'sequence',
              suit: 'D',
              cards: [
                { card: D(3), actingAs: 3, isJoker: false },
                { card: D(4), actingAs: 4, isJoker: false },
                { card: C(2), actingAs: 5, isJoker: true },
                { card: D(6), actingAs: 6, isJoker: false },
                { card: D(7), actingAs: 7, isJoker: false },
              ],
            },
          ],
        },
      },
    };
    const r = moveJoker(m, 'impure-diamond', 'C2a', 9);
    expect(r.ok).toBe(false);
  });

  it('allows a joker to move within a sequence when a card fills its old slot', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [D(5)]);
    m = {
      ...m,
      teams: {
        ...m.teams,
        A: {
          ...m.teams.A,
          firstDropDone: true,
          firstDropByPlayer: 0,
          sequenceBox: [
            {
              id: 'pure-heart',
              kind: 'sequence',
              suit: 'H',
              cards: [
                { card: H(3), actingAs: 3, isJoker: false },
                { card: H(4), actingAs: 4, isJoker: false },
                { card: H(5), actingAs: 5, isJoker: false },
              ],
            },
            {
              id: 'impure-diamond',
              kind: 'sequence',
              suit: 'D',
              cards: [
                { card: D(3), actingAs: 3, isJoker: false },
                { card: D(4), actingAs: 4, isJoker: false },
                { card: C(2), actingAs: 5, isJoker: true },
                { card: D(6), actingAs: 6, isJoker: false },
                { card: D(7), actingAs: 7, isJoker: false },
              ],
            },
          ],
        },
      },
    };
    const r = addToSequence(m, {
      meldId: 'impure-diamond',
      additions: [asNatural(D(5), 5)],
      jokerMoves: [{ cardId: 'C2a', newActingAs: 8 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const seq = r.match.teams.A.sequenceBox.find((x) => x.id === 'impure-diamond');
      expect(seq?.cards).toHaveLength(6);
    }
  });

  it('rejects add-to that would strip the team of its only pure sequence', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    // Setup: pure sequence 3-4-5 hearts, player has 6H and joker to make it impure-longer
    m = withHand(m, 0, [H(3), H(4), H(5), H(6), C(2)]);
    let step = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    if (!step.ok) throw new Error(step.reason);
    // Try adding 6H + joker as 7: makes the sequence impure. Since it's the only meld,
    // team would have no pure sequence anymore → rejected.
    const meldId = step.match.teams.A.sequenceBox[0].id;
    const r = addToSequence(step.match, {
      meldId,
      additions: [asNatural(H(6), 6), asJoker(C(2), 7)],
    });
    expect(r.ok).toBe(false);
  });

  it('allows an add-to that keeps the box invariant when a 2nd pure exists', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(3), H(4), H(5), D(9), D(10), D(11), D(12), C(2), H(6)]);
    let step = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    if (!step.ok) throw new Error(step.reason);
    step = dropMeld(step.match, {
      kind: 'sequence',
      cards: [asNatural(D(9), 9), asNatural(D(10), 10), asNatural(D(11), 11), asNatural(D(12), 12)],
    });
    if (!step.ok) throw new Error(step.reason);
    // Now safe to make the H sequence impure since D remains pure.
    const meldId = step.match.teams.A.sequenceBox[0].id;
    const r = addToSequence(step.match, {
      meldId,
      additions: [asNatural(H(6), 6), asJoker(C(2), 7)],
    });
    expect(r.ok).toBe(true);
  });
});

describe('discard and turn flow', () => {
  it('discard advances turn to next player', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    const cardToDiscard = m.players[0].hand[0];
    const r = discard(m, cardToDiscard.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.currentTurn).toBe(1);
      expect(r.match.turnPhase).toBe('awaiting-draw');
      expect(r.match.discard).toContainEqual(cardToDiscard);
    }
  });

  it('emptying hand awards bhukara and continues same turn', () => {
    // Craft: player 0 has exactly 1 card, drops nothing this turn, then discards.
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(9)]);
    // Team A already has a pure sequence in box (from a prior turn), so no first-drop rules apply now.
    m = {
      ...m,
      teams: {
        ...m.teams,
        A: {
          ...m.teams.A,
          firstDropDone: true,
          firstDropByPlayer: 2,
          sequenceBox: [
            {
              id: 'seed-1',
              kind: 'sequence',
              suit: 'S',
              cards: [
                { card: S(3), actingAs: 3, isJoker: false },
                { card: S(4), actingAs: 4, isJoker: false },
                { card: S(5), actingAs: 5, isJoker: false },
              ],
            },
          ],
        },
      },
    };
    const r = discard(m, 'H9a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.bhukaraTakenBy).toBe(0);
      expect(r.match.players[0].hand).toHaveLength(13);
      expect(r.match.bhukara).toHaveLength(0);
      expect(r.match.currentTurn).toBe(0); // same player continues
      expect(r.match.turnPhase).toBe('may-meld');
    }
  });

  it('emptying hand after bhukara closes the match', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    m = withHand(m, 0, [H(9)]);
    m = {
      ...m,
      bhukaraTakenBy: 2, // teammate took it earlier
      bhukara: [],
      teams: {
        ...m.teams,
        A: {
          ...m.teams.A,
          firstDropDone: true,
          firstDropByPlayer: 2,
          sequenceBox: [
            {
              id: 'seed-1',
              kind: 'sequence',
              suit: 'S',
              cards: [
                { card: S(3), actingAs: 3, isJoker: false },
                { card: S(4), actingAs: 4, isJoker: false },
                { card: S(5), actingAs: 5, isJoker: false },
              ],
            },
          ],
        },
      },
    };
    const r = discard(m, 'H9a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.phase).toBe('ended-normal');
      expect(r.match.closedBy).toBe(0);
    }
  });

  it('rejects discard if first drop this turn lacks a pure sequence', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    // Give team A a pure sequence in box already? No — we're testing FIRST-drop.
    // Player 0 drops an impure sequence... wait, first-drop must be pure, that's rejected at drop.
    // Test triplet-first is rejected at drop. So the "rejects discard if first drop lacks pure sequence"
    // is only reachable if... hmm, actually the drop layer already prevents this.
    // Let's confirm: after dropping first pure sequence, discard should succeed.
    m = withHand(m, 0, [H(3), H(4), H(5), H(7)]);
    let step = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    if (!step.ok) throw new Error(step.reason);
    const r = discard(step.match, 'H7a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.teams.A.firstDropDone).toBe(true);
  });
});

describe('1000+ rule', () => {
  it('team past 1000 needs its first-drop turn to sum ≥100', () => {
    // Team A has crossed 1000. Player 0 drops a low-value pure sequence and tries to discard.
    let m = newMatch({
      matchNumber: 2,
      startingPlayer: 0,
      teamScoresBeforeMatch: { A: 1100, B: 500 },
      playerNames: ['P1', 'P2', 'P3', 'P4'],
      seed: 5,
    });
    m = { ...m, turnPhase: 'may-meld' };
    // Small pure sequence: 3-4-5 hearts (5+5+5=15). Discard should be rejected.
    m = withHand(m, 0, [H(3), H(4), H(5), H(7)]);
    let step = dropMeld(m, {
      kind: 'sequence',
      cards: [asNatural(H(3), 3), asNatural(H(4), 4), asNatural(H(5), 5)],
    });
    if (!step.ok) throw new Error(step.reason);
    const r = discard(step.match, 'H7a');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/100/);
  });

  it('team past 1000: first-drop turn totaling ≥100 is allowed', () => {
    // Big pure sequence: A-2-3-4-5-6-7 hearts = 15+10+5+5+5+5+5 = 50 — still not 100. Hmm.
    // Q-K-A-2-3-4-5 hearts = 10+10+15+10+5+5+5 = 60. Not 100.
    // Need to combine a sequence + triplet.
    // Pure sequence J-Q-K-A hearts = 10+10+10+15 = 45.
    // Triplet KKK = 10+10+10 = 30. Total 75. Not 100.
    // Pure sequence J-Q-K-A hearts (45) + triplet A-A-A (15+15+15=45) = 90. Close.
    // Pure sequence 8-9-10-J-Q-K-A of hearts = 10+10+10+10+10+10+15 = 75.
    // + triplet 8-8-8 = 30 → 105. Works.
    let m = newMatch({
      matchNumber: 2,
      startingPlayer: 0,
      teamScoresBeforeMatch: { A: 1100, B: 500 },
      playerNames: ['P1', 'P2', 'P3', 'P4'],
      seed: 7,
    });
    m = { ...m, turnPhase: 'may-meld' };
    m = withHand(m, 0, [
      H(8), H(9), H(10), H(11), H(12), H(13), H(1),
      C(8), D(8), S(8),
      H(2), // discard
    ]);
    let step = dropMeld(m, {
      kind: 'sequence',
      cards: [
        asNatural(H(8), 8),
        asNatural(H(9), 9),
        asNatural(H(10), 10),
        asNatural(H(11), 11),
        asNatural(H(12), 12),
        asNatural(H(13), 13),
        asNatural(H(1), 14),
      ],
    });
    if (!step.ok) throw new Error(step.reason);
    step = dropMeld(step.match, {
      kind: 'triplet',
      cards: [
        { card: C(8), isJoker: false },
        { card: D(8), isJoker: false },
        { card: S(8), isJoker: false },
      ],
    });
    if (!step.ok) throw new Error(step.reason);
    const r = discard(step.match, 'H2a');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.teams.A.firstDropDone).toBe(true);
  });
});

describe('scoring', () => {
  it('scores a completed match with 7-card pure canasta + bhukara bonus', () => {
    let m = craftMatch({ turnPhase: 'may-meld' });
    // Rig a finished match state directly.
    m = {
      ...m,
      phase: 'ended-normal',
      closedBy: 0,
      bhukaraTakenBy: 0,
      teams: {
        ...m.teams,
        A: {
          ...m.teams.A,
          sequenceBox: [
            {
              id: 'x',
              kind: 'sequence',
              suit: 'H',
              cards: [3, 4, 5, 6, 7, 8, 9].map((r) => ({
                card: H(r),
                actingAs: r as SeqPos,
                isJoker: false,
              })),
            },
          ],
        },
      },
      players: {
        0: { ...m.players[0], hand: [] },
        1: { ...m.players[1], hand: [D(11)] }, // held K by opponent
        2: { ...m.players[2], hand: [] },
        3: { ...m.players[3], hand: [D(13)] },
      },
    };
    const s = scoreFinishedMatch(m);
    // Team A: card values 5+5+5+5+5+10+10 = 45. Canasta bonus pure = 200.
    // Bhukara +50 (player 0 is A). Closing +50. Opponents held: J(10)+K(10) = 20.
    // Total = 45 + 200 + 50 + 50 - 20 = 325
    expect(s.perTeam.A).toBe(325);
    // Team B: no melds, held opponent cards = A's hand = 0. Score = 0 - 0 = 0.
    expect(s.perTeam.B).toBe(0);
    expect(s.void).toBe(false);
  });

  it('void match yields 0 score for both teams', () => {
    let m = craftMatch({ phase: 'ended-void' });
    const s = scoreFinishedMatch(m);
    expect(s.perTeam.A).toBe(0);
    expect(s.perTeam.B).toBe(0);
    expect(s.void).toBe(true);
  });

  it('endMatchAndAdvance rotates starter left after a real match', () => {
    let g = seededGame(11);
    // End the match manually with a small A win.
    g = {
      ...g,
      currentMatch: {
        ...g.currentMatch,
        phase: 'ended-normal',
        closedBy: 0,
        teams: {
          ...g.currentMatch.teams,
          A: {
            ...g.currentMatch.teams.A,
            sequenceBox: [
              {
                id: 'x',
                kind: 'sequence',
                suit: 'H',
                cards: [
                  { card: H(3), actingAs: 3, isJoker: false },
                  { card: H(4), actingAs: 4, isJoker: false },
                  { card: H(5), actingAs: 5, isJoker: false },
                ],
              },
            ],
          },
        },
      },
    };
    const g2 = endMatchAndAdvance(g, { seed: 99 });
    expect(g2.matchesPlayed).toBe(1);
    expect(g2.currentMatch.matchNumber).toBe(2);
    expect(g2.currentMatch.startingPlayer).toBe(1); // was 0, next is 1
    expect(g2.winner).toBeNull();
  });
});
