import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  addFixtureData,
} from "../services/fpl_service.js";
import { addRatings } from "../services/rating_engine.js";
import {
  buildDecisionSquadFromPlayers,
  runFplDecisionEngine,
} from "../services/decision_engine.js";
import {
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  MULTI_GW_PROJECTION_VERSION,
  FORWARD_ROLE_ASSUMPTION,
  FORWARD_AVAILABILITY_ASSUMPTION,
} from "../services/multi_gw_projection.js";
import crypto from "crypto";

async function runDetailedAudit() {
  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const snapshot = bootstrap.snapshot;
  const teamData = await fetchTeamData(4107702, bootstrap.reference_gameweek);

  const rated = addRatings(
    addFixtureData(bootstrap.players, fixtures, bootstrap.teams, bootstrap.gameweek_boundary),
    {
      referenceGameweek: bootstrap.reference_gameweek,
      boundary: bootstrap.gameweek_boundary,
      snapshot: bootstrap.snapshot,
      recentHistoryByPlayer: teamData.player_histories,
    }
  );

  const squadPlayers = teamData.picks
    .map((pick: any) => rated.find((p: any) => p.id === pick.element))
    .filter(Boolean);

  console.log("=== SQUAD AUDIT ===");
  console.log("Team ID:", 4107702);
  console.log("Snapshot ID:", snapshot.snapshot_id);
  console.log("Cutoff GW:", snapshot.boundary.historical_cutoff_gameweek);
  console.log("Prediction Start GW:", snapshot.boundary.prediction_gameweek);

  console.log("\n15 Squad Players:");
  for (const p of squadPlayers) {
    const posName = p.element_type === 1 ? "GKP" : p.element_type === 2 ? "DEF" : p.element_type === 3 ? "MID" : "FWD";
    console.log(`ID: ${String(p.id).padEnd(4)} | Name: ${p.web_name.padEnd(14)} | Pos: ${posName.padEnd(4)} | Team: ${p.team}`);
  }

  // Multi-GW projections
  const t0 = performance.now();
  const projections = projectSquadMultiGameweek({
    players: squadPlayers,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: teamData.player_histories,
    horizon: 5,
    discountFactors: [1.00, 0.95, 0.90],
  });
  const t1 = performance.now();

  console.log(`\n15-player 5-GW projection runtime: ${(t1 - t0).toFixed(2)} ms`);

  // Print exact table
  console.log("\n=== 15-PLAYER MULTI-GW TABLE ===");
  for (const p of projections) {
    const gwPts = p.gameweeks.map((g) => g.expected_points.toFixed(2));
    console.log(
      `${p.web_name.padEnd(14)} | ${p.position_short_name.padEnd(3)} | GW3: ${gwPts[0]} | GW4: ${gwPts[1]} | GW5: ${gwPts[2]} | GW6: ${gwPts[3]} | GW7: ${gwPts[4]} | Cum3: ${p.cumulative_horizons.gw3.toFixed(2)} | Cum5: ${p.cumulative_expected_points.toFixed(2)} | D1.00: ${p.discounted_expected_points["1.00"].toFixed(2)} | D0.95: ${p.discounted_expected_points["0.95"].toFixed(2)} | D0.90: ${p.discounted_expected_points["0.90"].toFixed(2)} | Fix: ${p.total_fixtures_count} | BGW: ${p.bgw_count} | DGW: ${p.dgw_count}`
    );
  }

  // Decision squad & engine
  const decisionSquad = buildDecisionSquadFromPlayers({
    players: squadPlayers,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: teamData.player_histories,
  });

  const decisionResult = runFplDecisionEngine({
    squad: decisionSquad,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
  });

  console.log("\n=== PHASE 6A REGRESSION VERIFICATION ===");
  console.log("Formation:", decisionResult.recommended_formation_label);
  console.log("Starting XI Total xPts:", decisionResult.starting_xi_total_xpts.toFixed(2));
  console.log("Starters:", decisionResult.starting_xi.map((p) => p.web_name).join(", "));
  console.log("Bench GK:", decisionResult.bench_goalkeeper?.web_name);
  console.log("Bench Outfield:", decisionResult.ordered_outfield_bench.map((p) => p.web_name).join(", "));
  console.log("Captain:", decisionResult.captain.web_name);
  console.log("Vice Captain:", decisionResult.vice_captain.web_name);

  // Legacy scores regression for the 6 regression players
  console.log("\n=== LEGACY METRICS FOR 6 REGRESSION PLAYERS ===");
  const regNames = ["Raya", "Calafiori", "Konsa", "Hughes", "Haaland", "Fernandes"];
  const regSquad = squadPlayers.filter((p) => regNames.some((n) => p.web_name.includes(n)));
  for (const p of regSquad) {
    console.log(
      `${p.web_name.padEnd(14)} | ExpScore: ${p.expert_score?.toFixed(1)} | FutFPL: ${p.future_fpl_score?.toFixed(1)} | Form: ${p.current_form_score?.toFixed(1)} | ExpMinsProxy: ${p.expected_minutes_proxy?.toFixed(1)}`
    );
  }
}

runDetailedAudit().catch(console.error);
