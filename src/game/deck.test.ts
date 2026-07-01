import { describe, it, expect } from 'vitest';
import { makeDeck, shuffle, mulberry32, deal, cardLabel } from './deck';

describe('deck', () => {
  it('makeDeck produces 104 cards, two of each (suit, rank)', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(104);
    const counts = new Map<string, number>();
    for (const c of deck) {
      const key = `${c.suit}${c.rank}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    for (const n of counts.values()) expect(n).toBe(2);
  });

  it('makeDeck gives every card a unique id', () => {
    const deck = makeDeck();
    const ids = new Set(deck.map((c) => c.id));
    expect(ids.size).toBe(104);
  });

  it('shuffle preserves cards and is deterministic with a seed', () => {
    const deck = makeDeck();
    const a = shuffle(deck, mulberry32(42));
    const b = shuffle(deck, mulberry32(42));
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id))).toEqual(new Set(deck.map((c) => c.id)));
    expect(a).toHaveLength(104);
  });

  it('deal gives starting player 14, others 13, 13 bhukara, rest stock', () => {
    const deck = shuffle(makeDeck(), mulberry32(1));
    const { hands, bhukara, stock } = deal(deck, 0);
    expect(hands[0]).toHaveLength(14);
    expect(hands[1]).toHaveLength(13);
    expect(hands[2]).toHaveLength(13);
    expect(hands[3]).toHaveLength(13);
    expect(bhukara).toHaveLength(13);
    expect(stock).toHaveLength(104 - 14 - 3 * 13 - 13);
    expect(stock).toHaveLength(38);
    const allDealt = [...hands.flat(), ...bhukara, ...stock];
    expect(new Set(allDealt.map((c) => c.id)).size).toBe(104);
  });

  it('deal respects a different starting player', () => {
    const deck = shuffle(makeDeck(), mulberry32(2));
    const { hands } = deal(deck, 2);
    expect(hands[0]).toHaveLength(13);
    expect(hands[1]).toHaveLength(13);
    expect(hands[2]).toHaveLength(14);
    expect(hands[3]).toHaveLength(13);
  });

  it('cardLabel renders human-readable labels', () => {
    expect(cardLabel({ id: 'H1a', suit: 'H', rank: 1 })).toBe('A♥');
    expect(cardLabel({ id: 'S13b', suit: 'S', rank: 13 })).toBe('K♠');
    expect(cardLabel({ id: 'D7a', suit: 'D', rank: 7 })).toBe('7♦');
  });
});
