import type { Game, Match, PlayerId, TeamId } from './types';
import { TEAM_OF, TEAM_PLAYERS } from './types';
import { cardValue, scoreMatchForTeam } from './scoring';
import { nextStartingPlayer, newMatch } from './newGame';

export type MatchScoring = {
  perTeam: Record<TeamId, number>;
  void: boolean;
};

// Compute the score change for each team from a finished match.
export function scoreFinishedMatch(match: Match): MatchScoring {
  if (match.phase === 'ended-void') {
    return { perTeam: { A: 0, B: 0 }, void: true };
  }

  const bhukaraTeam: TeamId | null =
    match.bhukaraTakenBy !== null ? TEAM_OF[match.bhukaraTakenBy] : null;
  const closerTeam: TeamId | null =
    match.closedBy !== null ? TEAM_OF[match.closedBy] : null;

  const heldByTeam: Record<TeamId, number> = { A: 0, B: 0 };
  for (const pid of [0, 1, 2, 3] as PlayerId[]) {
    const t = TEAM_OF[pid];
    heldByTeam[t] += match.players[pid].hand.reduce((s, c) => s + cardValue(c.rank), 0);
  }

  const perTeam: Record<TeamId, number> = { A: 0, B: 0 };
  for (const t of ['A', 'B'] as TeamId[]) {
    const opp = t === 'A' ? 'B' : 'A';
    // Suppress unused-var lint from the loop; opp is still useful conceptually.
    void opp;
    perTeam[t] = scoreMatchForTeam({
      melds: match.teams[t].sequenceBox,
      bhukaraPicked: bhukaraTeam === t,
      closedMatch: closerTeam === t,
      ownHeldCardValues: heldByTeam[t],
      midMatchPenalty: match.teams[t].midMatchPenalty,
    });
  }

  return { perTeam, void: false };
}

// Applies match scoring to the game total and either starts the next match
// or crowns a winner.
export function endMatchAndAdvance(game: Game, opts?: { seed?: number; playerNames?: [string, string, string, string] }): Game {
  const scoring = scoreFinishedMatch(game.currentMatch);

  const newTotals: Record<TeamId, number> = {
    A: game.teams.A.totalScore + (scoring.void ? 0 : scoring.perTeam.A),
    B: game.teams.B.totalScore + (scoring.void ? 0 : scoring.perTeam.B),
  };

  // Winner if any team is at/above target — tie broken by higher score.
  let winner: TeamId | null = null;
  if (newTotals.A >= game.targetScore || newTotals.B >= game.targetScore) {
    winner = newTotals.A >= newTotals.B ? 'A' : 'B';
  }

  const nextStarter: PlayerId = nextStartingPlayer(game.currentMatch.startingPlayer);

  // Void matches replay with same starter (like it never happened). Actual matches
  // rotate the starter one seat clockwise.
  const starterForNext = scoring.void ? game.currentMatch.startingPlayer : nextStarter;

  const nextMatch = winner
    ? game.currentMatch
    : newMatch({
        matchNumber: game.currentMatch.matchNumber + 1,
        startingPlayer: starterForNext,
        teamScoresBeforeMatch: newTotals,
        playerNames: opts?.playerNames ?? [
          game.currentMatch.players[0].name,
          game.currentMatch.players[1].name,
          game.currentMatch.players[2].name,
          game.currentMatch.players[3].name,
        ],
        seed: opts?.seed,
      });

  return {
    ...game,
    teams: { A: { totalScore: newTotals.A }, B: { totalScore: newTotals.B } },
    currentMatch: nextMatch,
    matchesPlayed: game.matchesPlayed + (scoring.void ? 0 : 1),
    winner,
  };
}

// Small utility unused by tests but useful for the UI later.
export { TEAM_PLAYERS };
