import { describe, it, expect, beforeEach } from 'vitest';
import type { Card, SeqPos } from './types';
import {
  validateSequence,
  validateTriplet,
  asNatural,
  asJoker,
  isPure,
  _resetMeldIdsForTests,
} from './melds';

// Terse card constructors so the tests read like the rules.
const H = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `H${r}${copy}`, suit: 'H', rank: r as Card['rank'] });
const D = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `D${r}${copy}`, suit: 'D', rank: r as Card['rank'] });
const C = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `C${r}${copy}`, suit: 'C', rank: r as Card['rank'] });
const S = (r: number, copy: 'a' | 'b' = 'a'): Card => ({ id: `S${r}${copy}`, suit: 'S', rank: r as Card['rank'] });

beforeEach(() => _resetMeldIdsForTests());

describe('sequence validation', () => {
  it('pure sequence: A,2,3 of hearts — 2 is natural in-order', () => {
    const r = validateSequence([
      asNatural(H(1), 1),
      asNatural(H(2), 2),
      asNatural(H(3), 3),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pure).toBe(true);
      expect(r.meld.suit).toBe('H');
      expect(r.meld.cards).toHaveLength(3);
    }
  });

  it('pure sequence with Ace high: Q,K,A of hearts', () => {
    const r = validateSequence([
      asNatural(H(12), 12),
      asNatural(H(13), 13),
      asNatural(H(1), 14),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pure).toBe(true);
  });

  it('impure sequence with joker at start: 2♣ (as 3♥),4♥,5♥', () => {
    const r = validateSequence([
      asJoker(C(2), 3),
      asNatural(H(4), 4),
      asNatural(H(5), 5),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pure).toBe(false);
      expect(r.meld.suit).toBe('H');
    }
  });

  it('impure sequence with joker in middle: 4♥,2♣(as 5♥),6♥', () => {
    const r = validateSequence([
      asNatural(H(4), 4),
      asJoker(C(2), 5),
      asNatural(H(6), 6),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pure).toBe(false);
  });

  it('impure sequence with 2♥ acting as joker at position 6 (not natural in-order)', () => {
    // 4♥,5♥,2♥(as 6♥) — the 2♥ is playing rank 6, so it's a joker even though same suit
    const r = validateSequence([
      asNatural(H(4), 4),
      asNatural(H(5), 5),
      asJoker(H(2), 6),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pure).toBe(false);
  });

  it('7-card sequence is valid (canasta bonus later)', () => {
    const attempt = [3, 4, 5, 6, 7, 8, 9].map((r) => asNatural(H(r), r as SeqPos));
    const res = validateSequence(attempt);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pure).toBe(true);
  });

  it('rejects mixed suits among naturals', () => {
    const r = validateSequence([
      asNatural(H(3), 3),
      asNatural(D(4), 4),
      asNatural(H(5), 5),
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a gap in the sequence', () => {
    const r = validateSequence([
      asNatural(H(3), 3),
      asNatural(H(5), 5),
      asNatural(H(6), 6),
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects K-A-2 wrap', () => {
    const r = validateSequence([
      asNatural(H(13), 13),
      asNatural(H(1), 14),
      asNatural(H(2), 2), // low 2 after high A — not consecutive
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects fewer than 3 cards', () => {
    const r = validateSequence([asNatural(H(3), 3), asNatural(H(4), 4)]);
    expect(r.ok).toBe(false);
  });

  it('rejects more than one joker', () => {
    const r = validateSequence([
      asJoker(C(2), 3),
      asNatural(H(4), 4),
      asJoker(D(2), 5),
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-2 marked as joker', () => {
    const r = validateSequence([
      asNatural(H(3), 3),
      { card: H(4), actingAs: 4, isJoker: true },
      asNatural(H(5), 5),
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects a natural placed off its rank (e.g., 3♥ as slot 5)', () => {
    const r = validateSequence([
      { card: H(3), actingAs: 5, isJoker: false },
      asNatural(H(6), 6),
      asNatural(H(7), 7),
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('triplet validation', () => {
  it('pure triplet of 5s across three suits', () => {
    const r = validateTriplet([
      { card: H(5), isJoker: false },
      { card: D(5), isJoker: false },
      { card: C(5), isJoker: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pure).toBe(true);
      expect(r.meld.rank).toBe(5);
    }
  });

  it('impure triplet: two natural Kings + 2♣ acting as King', () => {
    const r = validateTriplet([
      { card: S(13), isJoker: false },
      { card: D(13), isJoker: false },
      { card: C(2), isJoker: true },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pure).toBe(false);
      expect(r.meld.rank).toBe(13);
    }
  });

  it('pure triplet of 2s (three natural 2s)', () => {
    const r = validateTriplet([
      { card: H(2), isJoker: false },
      { card: D(2), isJoker: false },
      { card: C(2), isJoker: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pure).toBe(true);
  });

  it('rejects a triplet of 2s that tries to use another 2 as joker', () => {
    const r = validateTriplet([
      { card: H(2), isJoker: false },
      { card: D(2), isJoker: false },
      { card: C(2), isJoker: true },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects more than one joker in a triplet', () => {
    const r = validateTriplet([
      { card: H(7), isJoker: false },
      { card: C(2), isJoker: true },
      { card: D(2), isJoker: true },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects mixed ranks among naturals', () => {
    const r = validateTriplet([
      { card: H(7), isJoker: false },
      { card: D(8), isJoker: false },
      { card: C(7), isJoker: false },
    ]);
    expect(r.ok).toBe(false);
  });

  it('allows duplicate cards from the two decks (e.g., 5♥a, 5♥b, 5♦)', () => {
    const r = validateTriplet([
      { card: H(5, 'a'), isJoker: false },
      { card: H(5, 'b'), isJoker: false },
      { card: D(5), isJoker: false },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe('isPure helper', () => {
  it('pure sequence has isPure=true', () => {
    const r = validateSequence([
      asNatural(H(3), 3),
      asNatural(H(4), 4),
      asNatural(H(5), 5),
    ]);
    if (r.ok) expect(isPure(r.meld)).toBe(true);
  });

  it('impure sequence has isPure=false', () => {
    const r = validateSequence([
      asJoker(C(2), 3),
      asNatural(H(4), 4),
      asNatural(H(5), 5),
    ]);
    if (r.ok) expect(isPure(r.meld)).toBe(false);
  });
});
