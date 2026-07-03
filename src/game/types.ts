// Core data model for Bhukara. Everything else builds on these types.
// Rules reference: 2 decks (104 cards, no printed jokers), 4 players in
// teams of 2, every 2 is a wildcard, first sequence per team must be pure.

export type Suit = 'H' | 'D' | 'C' | 'S';

// 1 = Ace, 11 = Jack, 12 = Queen, 13 = King.
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

// In Bhukara every 2 is a wildcard.
export const JOKER_RANK: Rank = 2;

// A physical card in the game. Two decks are shuffled together, so each
// (suit, rank) pair has two instances distinguished by id.
export type Card = {
  id: string; // e.g. "H5a", "H5b"
  suit: Suit;
  rank: Rank;
};

// Position within a sequence. Ace can play low (1) or high (14) but sequences
// never wrap across the K-A boundary.
export type SeqPos = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

// A card as it sits inside a sequence meld.
export type SequenceMeldCard = {
  card: Card;
  actingAs: SeqPos; // 1..14 — natural rank for non-jokers, or the slot a joker is filling
  isJoker: boolean; // true iff card is a 2 substituting for a different rank
};

// A card as it sits inside a triplet meld. Position doesn't matter — the rank
// of the whole triplet is fixed.
export type TripletMeldCard = {
  card: Card;
  isJoker: boolean;
};

export type SequenceMeld = {
  id: string;
  kind: 'sequence';
  suit: Suit;
  cards: SequenceMeldCard[]; // ordered by actingAs ascending
};

export type TripletMeld = {
  id: string;
  kind: 'triplet';
  rank: Rank;
  cards: TripletMeldCard[]; // order irrelevant
};

export type Meld = SequenceMeld | TripletMeld;

export type PlayerId = 0 | 1 | 2 | 3;
export type TeamId = 'A' | 'B';

export type Player = {
  id: PlayerId;
  name: string;
  teamId: TeamId;
  hand: Card[];
};

// Team state that is specific to the current match.
export type TeamMatchState = {
  id: TeamId;
  playerIds: [PlayerId, PlayerId];
  sequenceBox: Meld[];
  firstDropDone: boolean;
  firstDropByPlayer: PlayerId | null; // for 1000+ rule enforcement
  mustFirstDropReach100: boolean; // set true when team started match past 1000
  // -200 penalties incurred this match when a player tried to close their
  // turn after a failed first drop (dropped melds < 100 pts, or no pure
  // sequence). The dropped cards are returned to the player's hand.
  midMatchPenalty: number;
};

export type TurnPhase =
  | 'awaiting-draw'
  | 'may-meld'
  | 'awaiting-discard'
  | 'awaiting-post-bhukara-discard';

export type MatchPhase = 'playing' | 'ended-normal' | 'ended-void';

// A single deal — points don't leave the match until it ends.
export type Match = {
  matchNumber: number;
  stock: Card[];
  discard: Card[];
  bhukara: Card[];
  bhukaraTakenBy: PlayerId | null;
  startingPlayer: PlayerId;
  currentTurn: PlayerId;
  turnPhase: TurnPhase;
  players: Record<PlayerId, Player>;
  teams: Record<TeamId, TeamMatchState>;
  phase: MatchPhase;
  closedBy: PlayerId | null;
  // Meld IDs that were newly created (not just added-to) during the currently
  // active turn. Used to validate the team's first-drop rules on discard.
  meldsCreatedThisTurn: string[];
};

// Whole-game state, persists across matches until someone hits target.
export type Game = {
  teams: Record<TeamId, { totalScore: number }>;
  currentMatch: Match;
  matchesPlayed: number;
  winner: TeamId | null;
  targetScore: number; // 2000
};

// Player-team seating: 0 and 2 are team A (opposite), 1 and 3 are team B.
export const TEAM_OF: Record<PlayerId, TeamId> = { 0: 'A', 1: 'B', 2: 'A', 3: 'B' };
export const TEAM_PLAYERS: Record<TeamId, [PlayerId, PlayerId]> = {
  A: [0, 2],
  B: [1, 3],
};
