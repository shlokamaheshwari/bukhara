import type {
  Game,
  Match,
  Player,
  PlayerId,
  TeamId,
  TeamMatchState,
} from './types';
import { TEAM_OF, TEAM_PLAYERS } from './types';
import { deal, makeDeck, mulberry32, shuffle } from './deck';

export const TARGET_SCORE = 2000;
export const CROSS_1000 = 1000;

export type NewGameOptions = {
  playerNames?: [string, string, string, string];
  seed?: number; // for deterministic shuffles in tests
};

// Constructs a brand new game — first match, teams at 0, no winner.
export function newGame(opts: NewGameOptions = {}): Game {
  const names = opts.playerNames ?? ['P1', 'P2', 'P3', 'P4'];
  return {
    teams: { A: { totalScore: 0 }, B: { totalScore: 0 } },
    currentMatch: newMatch({
      matchNumber: 1,
      startingPlayer: 0,
      teamScoresBeforeMatch: { A: 0, B: 0 },
      playerNames: names,
      seed: opts.seed,
    }),
    matchesPlayed: 0,
    matchHistory: [],
    winner: null,
    targetScore: TARGET_SCORE,
  };
}

export type NewMatchOptions = {
  matchNumber: number;
  startingPlayer: PlayerId;
  teamScoresBeforeMatch: Record<TeamId, number>;
  playerNames: [string, string, string, string];
  seed?: number;
};

export function newMatch(opts: NewMatchOptions): Match {
  const rng = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
  const shuffled = shuffle(makeDeck(), rng);
  const { hands, bhukara, stock } = deal(shuffled, opts.startingPlayer);

  const players: Record<PlayerId, Player> = {} as Record<PlayerId, Player>;
  ([0, 1, 2, 3] as PlayerId[]).forEach((id) => {
    players[id] = {
      id,
      name: opts.playerNames[id],
      teamId: TEAM_OF[id],
      hand: hands[id],
    };
  });

  const teams: Record<TeamId, TeamMatchState> = {
    A: makeTeamMatchState('A', opts.teamScoresBeforeMatch.A),
    B: makeTeamMatchState('B', opts.teamScoresBeforeMatch.B),
  };

  return {
    matchNumber: opts.matchNumber,
    stock,
    discard: [],
    bhukara,
    bhukaraTakenBy: null,
    startingPlayer: opts.startingPlayer,
    currentTurn: opts.startingPlayer,
    // Starting player already holds 14 cards and cannot draw or pick — they
    // may meld immediately and must discard to end the opening turn.
    turnPhase: 'may-meld',
    players,
    teams,
    phase: 'playing',
    closedBy: null,
    meldsCreatedThisTurn: [],
    preMeldSnapshot: null,
  };
}

function makeTeamMatchState(id: TeamId, scoreBefore: number): TeamMatchState {
  return {
    id,
    playerIds: TEAM_PLAYERS[id],
    sequenceBox: [],
    firstDropDone: false,
    firstDropByPlayer: null,
    mustFirstDropReach100: scoreBefore >= CROSS_1000,
    midMatchPenalty: 0,
  };
}

// Rotates the starting player one seat clockwise (to the left) for the next match.
export function nextStartingPlayer(current: PlayerId): PlayerId {
  return ((current + 1) % 4) as PlayerId;
}
