import { fetchBootstrapData, fetchFixtures, fetchTeamData, getSharedPlayerHistories } from "../services/fpl_service.js";
import { GameweekBoundary, PredictionSnapshot, DataValidity } from "../services/prediction_contract.js";
import {
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  PlayerMultiGwProjection,
  MULTI_GW_PROJECTION_VERSION,
  FORWARD_ROLE_ASSUMPTION,
  FORWARD_AVAILABILITY_ASSUMPTION,
  CORRELATED_UNCERTAINTY_NOTE,
} from "../services/multi_gw_projection.js";

async function runPhase6bLiveValidation() {
  console.log("================================================================================");
  console.log("PHASE 6B: MULTI-GAMEWEEK PROJECTION LAYER VALIDATION REPORT");
  console.log("================================================================================\n");

  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const snapshot = bootstrap.snapshot;
  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const predGw = snapshot.boundary.prediction_gameweek ?? (cutoffGw !== null ? cutoffGw + 1 : 1);
  const horizon = 5;

  console.log(`Snapshot ID: ${snapshot.snapshot_id}`);
  console.log(`Historical Cutoff GW: ${cutoffGw}`);
  console.log(`Prediction Start GW: ${predGw}`);
  console.log(`Horizon: ${horizon} Gameweeks (GW${predGw} to GW${predGw + horizon - 1})`);
  console.log(`Projection Version: ${MULTI_GW_PROJECTION_VERSION}`);
  console.log(`Role State Forward Policy: ${FORWARD_ROLE_ASSUMPTION}`);
  console.log(`Availability Forward Policy: ${FORWARD_AVAILABILITY_ASSUMPTION}`);
  console.log(`Uncertainty Note: ${CORRELATED_UNCERTAINTY_NOTE}\n`);

  // Load Team 4107702
  const teamId = 4107702;
  const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
  const pickIds = new Set(teamData.picks.map((p: any) => p.element));
  const squadPlayers = teamData.picks
    .map((pick: any) => bootstrap.players.find((p: any) => p.id === pick.element))
    .filter(Boolean);

  const histories = teamData.player_histories || getSharedPlayerHistories();

  const squadProjections = projectSquadMultiGameweek({
    players: squadPlayers,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: histories,
    horizon,
    discountFactors: [1.00, 0.95, 0.90],
  });

  // ============================================================================
  // SECTION 1: 15-PLAYER MULTI-GAMEWEEK PROJECTION TABLE
  // ============================================================================
  console.log("================================================================================");
  console.log("SECTION 1: 15-PLAYER SQUAD MULTI-GAMEWEEK PROJECTION TABLE (HORIZON = 5)");
  console.log("================================================================================");
  console.log(
    "Player".padEnd(16) +
    "Pos".padEnd(5) +
    "Team".padEnd(6) +
    `GW${predGw}`.padStart(7) +
    `GW${predGw+1}`.padStart(7) +
    `GW${predGw+2}`.padStart(7) +
    `GW${predGw+3}`.padStart(7) +
    `GW${predGw+4}`.padStart(7) +
    "Cum(5)".padStart(9) +
    "Disc(0.95)".padStart(12) +
    "Disc(0.90)".padStart(12) +
    "Conf".padStart(7)
  );
  console.log("-".repeat(95));

  for (const p of squadProjections) {
    const gwPts = p.gameweeks.map((g) => g.expected_points.toFixed(2).padStart(7)).join("");
    const cum = p.cumulative_expected_points.toFixed(2).padStart(9);
    const d95 = p.discounted_expected_points["0.95"].toFixed(2).padStart(12);
    const d90 = p.discounted_expected_points["0.90"].toFixed(2).padStart(12);
    const conf = p.confidence_summary.avg_confidence.toFixed(2).padStart(7);

    console.log(
      p.web_name.padEnd(16).slice(0, 16) +
      p.position_short_name.padEnd(5) +
      p.team_short_name.padEnd(6) +
      gwPts +
      cum +
      d95 +
      d90 +
      conf
    );
  }
  console.log("\n");

  // ============================================================================
  // SECTION 2: FIXTURE-LEVEL TRACES FOR 6 DIVERSE PLAYERS
  // ============================================================================
  console.log("================================================================================");
  console.log("SECTION 2: FIXTURE-LEVEL BREAKDOWN TRACES (6 DIVERSE PLAYERS)");
  console.log("================================================================================");

  const sampleTraces = squadProjections.slice(0, 6);
  for (const p of sampleTraces) {
    console.log(`\n--- ${p.web_name} (${p.position_short_name}, ${p.team_short_name}) ---`);
    console.log(`Cumulative 5-GW xPts: ${p.cumulative_expected_points} | Discounted(0.95): ${p.discounted_expected_points["0.95"]} | Discounted(0.90): ${p.discounted_expected_points["0.90"]}`);
    console.log(
      "  GW".padEnd(6) +
      "Type".padEnd(8) +
      "Opponent".padEnd(12) +
      "Diff".padEnd(6) +
      "ExpMins".padStart(8) +
      "P(App)".padStart(8) +
      "P(Start)".padStart(9) +
      "P(60+)".padStart(8) +
      "xPts".padStart(8)
    );
    console.log("  " + "-".repeat(71));

    for (const gw of p.gameweeks) {
      if (gw.fixture_count === 0) {
        console.log(
          `  GW${gw.gameweek}`.padEnd(6) +
          "BLANK".padEnd(8) +
          "None".padEnd(12) +
          "-".padEnd(6) +
          "0.0".padStart(8) +
          "0.00".padStart(8) +
          "0.00".padStart(9) +
          "0.00".padStart(8) +
          "0.00".padStart(8)
        );
      } else {
        for (const f of gw.fixtures) {
          const loc = f.is_home ? "(H)" : "(A)";
          const oppStr = `${f.opponent_short_name} ${loc}`;
          console.log(
            `  GW${gw.gameweek}`.padEnd(6) +
            gw.gameweek_type.toUpperCase().padEnd(8) +
            oppStr.padEnd(12) +
            String(f.difficulty).padEnd(6) +
            f.expected_minutes.toFixed(1).padStart(8) +
            f.probability_appearance.toFixed(2).padStart(8) +
            f.probability_start.toFixed(2).padStart(9) +
            f.probability_60_plus_minutes.toFixed(2).padStart(8) +
            f.expected_points.toFixed(2).padStart(8)
          );
        }
      }
    }
  }
  console.log("\n");

  // ============================================================================
  // SECTION 3: HORIZON RANKING COMPARISON (GW1 vs GW3 vs GW5 vs GW5 Disc)
  // ============================================================================
  console.log("================================================================================");
  console.log("SECTION 3: HORIZON RANKINGS (GW1 vs GW3 vs GW5 vs GW5 Discounted 0.95)");
  console.log("================================================================================");

  const rankedByGw1 = [...squadProjections].sort((a, b) => b.gameweeks[0].expected_points - a.gameweeks[0].expected_points);
  const rankedByGw3 = [...squadProjections].sort((a, b) => b.cumulative_horizons.gw3 - a.cumulative_horizons.gw3);
  const rankedByGw5 = [...squadProjections].sort((a, b) => b.cumulative_expected_points - a.cumulative_expected_points);
  const rankedByDisc95 = [...squadProjections].sort((a, b) => b.discounted_expected_points["0.95"] - a.discounted_expected_points["0.95"]);

  console.log(
    "Rank".padEnd(6) +
    "GW1 Leader".padEnd(20) +
    "GW3 Cum Leader".padEnd(20) +
    "GW5 Cum Leader".padEnd(20) +
    "GW5 Disc(0.95) Leader".padEnd(22)
  );
  console.log("-".repeat(88));

  for (let i = 0; i < Math.min(10, squadProjections.length); i++) {
    const r1 = `${rankedByGw1[i].web_name} (${rankedByGw1[i].gameweeks[0].expected_points.toFixed(2)})`;
    const r3 = `${rankedByGw3[i].web_name} (${rankedByGw3[i].cumulative_horizons.gw3.toFixed(2)})`;
    const r5 = `${rankedByGw5[i].web_name} (${rankedByGw5[i].cumulative_expected_points.toFixed(2)})`;
    const rd = `${rankedByDisc95[i].web_name} (${rankedByDisc95[i].discounted_expected_points["0.95"].toFixed(2)})`;

    console.log(
      `#${i + 1}`.padEnd(6) +
      r1.padEnd(20) +
      r3.padEnd(20) +
      r5.padEnd(20) +
      rd.padEnd(22)
    );
  }
  console.log("\n");

  console.log("================================================================================");
  console.log("PHASE 6B VALIDATION RUN COMPLETED SUCCESSFULLY.");
  console.log("================================================================================");
}

runPhase6bLiveValidation().catch((err) => {
  console.error("Phase 6B validation error:", err);
  process.exit(1);
});
