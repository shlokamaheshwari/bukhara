import type { Card, Rank, Suit } from './types';

const SUITS: Suit[] = ['H', 'D', 'C', 'S'];
const RANKS: Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

// Human-readable card label — used for logging and the plain UI.
export function cardLabel(card: Card): string {
  const rankChar =
    card.rank === 1 ? 'A' :
    card.rank === 11 ? 'J' :
    card.rank === 12 ? 'Q' :
    card.rank === 13 ? 'K' :
    String(card.rank);
  const suitChar = { H: '♥', D: '♦', C: '♣', S: '♠' }[card.suit];
  return `${rankChar}${suitChar}`;
}

// Two full 52-card decks shuffled together. No printed jokers — every 2 acts
// as a wildcard when needed.
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const copy of ['a', 'b'] as const) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `${suit}${rank}${copy}`, suit, rank });
      }
    }
  }
  return deck;
}

// Deterministic PRNG for reproducible shuffles in tests. Not for security.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type Deal = {
  hands: [Card[], Card[], Card[], Card[]];
  bhukara: Card[];
  stock: Card[];
};

// The starting player of a match receives one extra card (14 instead of 13)
// so their opening turn is discard-only — they cannot draw or pick, only
// meld from hand and throw. Others get 13, bhukara gets 13, rest is stock.
export function deal(deck: Card[], startingPlayer: 0 | 1 | 2 | 3 = 0): Deal {
  if (deck.length !== 104) {
    throw new Error(`deal expects 104 cards, got ${deck.length}`);
  }
  const hands: [Card[], Card[], Card[], Card[]] = [[], [], [], []];
  let i = 0;
  for (let p = 0; p < 4; p++) {
    const size = p === startingPlayer ? 14 : 13;
    hands[p] = deck.slice(i, i + size);
    i += size;
  }
  const bhukara = deck.slice(i, i + 13);
  i += 13;
  const stock = deck.slice(i);
  return { hands, bhukara, stock };
}
