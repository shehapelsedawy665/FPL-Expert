import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  fetchTeamEntry,
  fetchTeamPicks,
  getSharedPlayerHistories,
} from "../services/fpl_service.js";
import { projectSquadMultiGameweek } from "../services/multi_gw_projection.js";

async function main() {
  const bootstrap = await fetchBootstrapData();
  const fixtures = await fetchFixtures();
  const histories = getSharedPlayerHistories();

  console.log("Total players in bootstrap:", bootstrap.players.length);
  const activePlayers = bootstrap.players.filter((p: any) => p.status !== "u");
  console.log("Active players (status != u):", activePlayers.length);

  const t0 = Date.now();
  const projs = projectSquadMultiGameweek({
    players: activePlayers,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: histories,
    horizon: 5,
  });
  console.log("Projected", projs.length, "players in", Date.now() - t0, "ms");

  const validProjs = projs.filter(
    (p) => p.gameweeks.length === 5 && p.cumulative_expected_points >= 0
  );
  console.log("Valid projections:", validProjs.length);

  const byPos: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of validProjs) {
    byPos[p.element_type] = (byPos[p.element_type] || 0) + 1;
  }
  console.log("Valid projections by position (1=GKP, 2=DEF, 3=MID, 4=FWD):", byPos);
}

main().catch(console.error);

