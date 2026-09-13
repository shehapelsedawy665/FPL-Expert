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

async function auditAndValidate() {
  console.log("================================================================================");
  console.log("AUDITING SQUAD IDENTITY & VALIDATING PHASE 6B FOR TEAM 4107702");
  console.log("================================================================================\n");

  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const snapshot = bootstrap.snapshot;
  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const startGw = snapshot.boundary.prediction_gameweek ?? 3;

  console.log(`Snapshot ID: ${snapshot.snapshot_id}`);
  console.log(`Cutoff GW: ${cutoffGw}`);
  console.log(`Prediction Start GW: ${startGw}`);

  // Fetch Team 4107702
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

  console.log(`\nTeam 4107702 Squad Count: ${squadPlayers.length}`);

  // Phase 6A Squad Hash
  const phase6aPlayerIds = squadPlayers.map((p) => p.id).sort((a, b) => a - b);
  const phase6aHash = crypto
    .createHash("sha256")
    .update(`${snapshot.snapshot_id}:${phase6aPlayerIds.join(",")}`)
    .digest("hex");

  console.log(`Phase 6A Squad IDs: [${phase6aPlayerIds.join(", ")}]`);
  console.log(`Phase 6A Squad Hash: ${phase6aHash}`);

  // Decision Engine run for Phase 6A regression check
  const decisionSquad = buildDecisionSquadFromPlayers({
    players: squadPlayers,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: teamData.player_histories,
  });

  const decisionResult = runFplDecisionEngine({
    squad: decisionSquad,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
  });

  console.log(`\nPhase 6A Regression Check:`);
  console.log(`  Formation: ${decisionResult.recommended_formation_label}`);
  console.log(`  Starting XI: ${decisionResult.starting_xi.map((p) => p.web_name).join(", ")}`);
  console.log(`  Bench GK: ${decisionResult.bench_goalkeeper?.web_name}`);
  console.log(`  Bench Outfield: ${decisionResult.ordered_outfield_bench.map((p) => p.web_name).join(", ")}`);
  console.log(`  Captain: ${decisionResult.captain.web_name}`);
  console.log(`  Vice: ${decisionResult.vice_captain.web_name}`);
  console.log(`  Starting XI xPts: ${decisionResult.starting_xi_total_xpts.toFixed(2)}`);

  // Run Phase 6B Multi-GW Projections on the exact 15 squad players
  const multiGwProjections = projectSquadMultiGameweek({
    players: squadPlayers,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories: teamData.player_histories,
    horizon: 5,
    discountFactors: [1.00, 0.95, 0.90],
  });

  const phase6bPlayerIds = multiGwProjections.map((p) => p.player_id).sort((a, b) => a - b);
  const phase6bHash = crypto
    .createHash("sha256")
    .update(`${snapshot.snapshot_id}:${phase6bPlayerIds.join(",")}`)
    .digest("hex");

  console.log(`\nPhase 6B Squad IDs: [${phase6bPlayerIds.join(", ")}]`);
  console.log(`Phase 6B Squad Hash: ${phase6bHash}`);
  console.log(`Squad Hash Match: ${phase6aHash === phase6bHash ? "YES (EXACT MATCH)" : "NO"}`);

  // Table output for Section 4
  console.log("\n================================================================================");
  console.log("SECTION 4: 15-PLAYER MULTI-GW TABLE (TEAM 4107702, GW3 to GW7)");
  console.log("================================================================================");
  console.log(
    "Player".padEnd(14) +
    "Pos".padEnd(5) +
    "GW3".padStart(6) +
    "GW4".padStart(6) +
    "GW5".padStart(6) +
    "GW6".padStart(6) +
    "GW7".padStart(6) +
    "Cum3".padStart(7) +
    "Cum5".padStart(7) +
    "D(1.00)".padStart(9) +
    "D(0.95)".padStart(9) +
    "D(0.90)".padStart(9) +
    "Fix".padStart(5) +
    "BGW".padStart(5) +
    "DGW".padStart(5)
  );
  console.log("-".repeat(95));

  for (const p of multiGwProjections) {
    const gw3 = p.gameweeks[0].expected_points.toFixed(2).padStart(6);
    const gw4 = p.gameweeks[1].expected_points.toFixed(2).padStart(6);
    const gw5 = p.gameweeks[2].expected_points.toFixed(2).padStart(6);
    const gw6 = p.gameweeks[3].expected_points.toFixed(2).padStart(6);
    const gw7 = p.gameweeks[4].expected_points.toFixed(2).padStart(6);
    const cum3 = p.cumulative_horizons.gw3.toFixed(2).padStart(7);
    const cum5 = p.cumulative_expected_points.toFixed(2).padStart(7);
    const d100 = p.discounted_expected_points["1.00"].toFixed(2).padStart(9);
    const d95 = p.discounted_expected_points["0.95"].toFixed(2).padStart(9);
    const d90 = p.discounted_expected_points["0.90"].toFixed(2).padStart(9);
    const fix = String(p.total_fixtures_count).padStart(5);
    const bgw = String(p.bgw_count).padStart(5);
    const dgw = String(p.dgw_count).padStart(5);

    console.log(
      p.web_name.padEnd(14).slice(0, 14) +
      p.position_short_name.padEnd(5) +
      gw3 + gw4 + gw5 + gw6 + gw7 +
      cum3 + cum5 + d100 + d95 + d90 +
      fix + bgw + dgw
    );
  }

  // Section 5: 6 Regression Players fixture trace
  console.log("\n================================================================================");
  console.log("SECTION 5: SIX-PLAYER FIXTURE TRACE (Raya, Calafiori, Konsa, Hughes, Haaland, B.Fernandes)");
  console.log("================================================================================");

  const regNames = ["Raya", "Calafiori", "Konsa", "Hughes", "Haaland", "Fernandes"];
  const regPlayers = multiGwProjections.filter((p) => regNames.some((n) => p.web_name.includes(n)));

  for (const p of regPlayers) {
    console.log(`\n--- ${p.web_name} (ID: ${p.player_id}, Pos: ${p.position_short_name}, Team: ${p.team_short_name}) ---`);
    console.log(
      "GW".padEnd(5) +
      "FixID".padEnd(7) +
      "Opponent".padEnd(12) +
      "H/A".padEnd(5) +
      "ExpMins".padStart(8) +
      "P(App)".padStart(8) +
      "P(Start)".padStart(9) +
      "P(60+)".padStart(8) +
      "Raw xPts".padStart(10) +
      "GW Total".padStart(10)
    );
    console.log("-".repeat(82));

    for (const gw of p.gameweeks) {
      if (gw.fixture_count === 0) {
        console.log(
          `GW${gw.gameweek}`.padEnd(5) +
          "-".padEnd(7) +
          "BLANK".padEnd(12) +
          "-".padEnd(5) +
          "0.0".padStart(8) +
          "0.00".padStart(8) +
          "0.00".padStart(9) +
          "0.00".padStart(8) +
          "0.00".padStart(10) +
          "0.00".padStart(10)
        );
      } else {
        for (const f of gw.fixtures) {
          console.log(
            `GW${gw.gameweek}`.padEnd(5) +
            String(f.fixture_id).padEnd(7) +
            f.opponent_short_name.padEnd(12) +
            (f.is_home ? "Home" : "Away").padEnd(5) +
            f.expected_minutes.toFixed(1).padStart(8) +
            f.probability_appearance.toFixed(2).padStart(8) +
            f.probability_start.toFixed(2).padStart(9) +
            f.probability_60_plus_minutes.toFixed(2).padStart(8) +
            f.expected_points.toFixed(2).padStart(10) +
            gw.expected_points.toFixed(2).padStart(10)
          );
        }
      }
    }
  }

  // Section 10: Phase 3.1 & Phase 4 Invariance Check: Phase 6A vs Phase 6B GW3
  console.log("\n================================================================================");
  console.log("SECTION 10: PHASE 3.1 / PHASE 4 INVARIANCE CHECK (Phase 6A vs Phase 6B GW3)");
  console.log("================================================================================");
  console.log(
    "Player".padEnd(14) +
    "Metric".padEnd(12) +
    "Phase 6A (GW3)".padStart(16) +
    "Phase 6B (GW3)".padStart(16) +
    "Delta".padStart(10)
  );
  console.log("-".repeat(68));

  for (const regP of regPlayers) {
    const dsPlayer = decisionSquad.find((p) => p.id === regP.player_id)!;
    const bGw3 = regP.gameweeks[0];

    const checks = [
      { name: "Exp Mins", p6a: dsPlayer.expected_minutes, p6b: bGw3.expected_minutes },
      { name: "P(App)", p6a: dsPlayer.probability_appearance, p6b: bGw3.probability_appearance },
      { name: "P(Start)", p6a: dsPlayer.probability_start, p6b: bGw3.probability_start },
      { name: "P(60+)", p6a: dsPlayer.probability_60_plus_minutes, p6b: bGw3.probability_60_plus_minutes },
      { name: "Raw xPts", p6a: dsPlayer.raw_expected_points, p6b: bGw3.raw_expected_points },
    ];

    for (const c of checks) {
      const delta = Math.abs(c.p6a - c.p6b);
      console.log(
        regP.web_name.padEnd(14).slice(0, 14) +
        c.name.padEnd(12) +
        c.p6a.toFixed(3).padStart(16) +
        c.p6b.toFixed(3).padStart(16) +
        delta.toFixed(6).padStart(10)
      );
    }
  }

  // Section 11: Horizon Rankings
  console.log("\n================================================================================");
  console.log("SECTION 11: 15-PLAYER HORIZON RANKINGS & SHIFTS (GW1 vs GW3 vs GW5)");
  console.log("================================================================================");
  const r1 = [...multiGwProjections].sort((a, b) => b.gameweeks[0].expected_points - a.gameweeks[0].expected_points);
  const r3 = [...multiGwProjections].sort((a, b) => b.cumulative_horizons.gw3 - a.cumulative_horizons.gw3);
  const r5 = [...multiGwProjections].sort((a, b) => b.cumulative_expected_points - a.cumulative_expected_points);

  console.log(
    "Rank".padEnd(6) +
    "1-GW Rank (GW3 xPts)".padEnd(28) +
    "3-GW Rank (Cum xPts)".padEnd(28) +
    "5-GW Rank (Cum xPts)".padEnd(28)
  );
  console.log("-".repeat(90));

  for (let i = 0; i < multiGwProjections.length; i++) {
    const s1 = `${r1[i].web_name} (${r1[i].gameweeks[0].expected_points.toFixed(2)})`;
    const s3 = `${r3[i].web_name} (${r3[i].cumulative_horizons.gw3.toFixed(2)})`;
    const s5 = `${r5[i].web_name} (${r5[i].cumulative_expected_points.toFixed(2)})`;
    console.log(
      `#${i + 1}`.padEnd(6) +
      s1.padEnd(28) +
      s3.padEnd(28) +
      s5.padEnd(28)
    );
  }
}

auditAndValidate().catch((err) => {
  console.error(err);
  process.exit(1);
});
