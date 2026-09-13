import { fetchBootstrapData, fetchFixtures, fetchPlayerSummary } from "../services/fpl_service.js";
import { GameweekBoundary, PredictionSnapshot } from "../services/prediction_contract.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import { buildPlayerExpectedMinutes } from "../services/expected_minutes_model.js";
import { buildPlayerExpectedPoints } from "../services/expected_points_model.js";

async function runAudit() {
  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);
  const boundary = new GameweekBoundary({
    last_finished_gameweek: 2,
    in_progress_gameweek: null,
    prediction_gameweek: 3,
    historical_cutoff_gameweek: 2,
  });
  const snapshot = new PredictionSnapshot({
    snapshot_id: "snap_gw3_cutoff2",
    boundary,
  });

  const targetNames = ["Raya", "Calafiori", "Konsa", "Hughes", "Haaland", "Fernandes"];

  for (const name of targetNames) {
    const p = bootstrap.players.find((pl: any) => pl.web_name.toLowerCase().includes(name.toLowerCase()));
    if (!p) continue;
    const summary = await fetchPlayerSummary(p.id);
    const features = buildPlayerPredictionFeatures({
      player: p,
      snapshot,
      history: summary.history,
      allFixtures: fixtures,
    });
    const minsResult = buildPlayerExpectedMinutes({
      player: p,
      features,
      snapshot,
      history: summary.history,
    });
    const epResult = buildPlayerExpectedPoints({
      player: p,
      features,
      minutesResult: minsResult,
      snapshot,
      history: summary.history,
      allFixtures: fixtures,
    });

    console.log(`\n=================== PLAYER: ${p.web_name} (ID: ${p.id}, Pos: ${p.element_type}) ===================`);
    console.log(`Phase 3 outputs:`);
    console.log(`  - expected_minutes: ${minsResult.expected_minutes.value}`);
    console.log(`  - probability_start: ${minsResult.probability_start.value}`);
    console.log(`  - probability_appearance: ${minsResult.probability_appearance.value}`);
    console.log(`  - probability_60_plus_minutes: ${minsResult.probability_60_plus_minutes.value}`);
    console.log(`  - playing_time_confidence: ${minsResult.playing_time_confidence.value}`);

    console.log(`Phase 4 consumed (gw & fixture level):`);
    console.log(`  - consumed expected_minutes: ${epResult.breakdown.expected_minutes} (fix: ${epResult.breakdown.fixtures[0]?.expected_minutes})`);
    console.log(`  - consumed probability_appearance: ${epResult.breakdown.fixtures[0]?.probability_appearance}`);
    console.log(`  - consumed probability_60_plus_minutes: ${epResult.breakdown.fixtures[0]?.probability_60_plus_minutes}`);
    console.log(`  - expected_points_confidence: ${epResult.expected_points_confidence.value}`);
    console.log(`  - EXACT EQUALITY CHECK: expected_minutes match: ${Number(minsResult.expected_minutes.value) === Number(epResult.breakdown.expected_minutes)}, P(app) match: ${minsResult.probability_appearance.value === epResult.breakdown.fixtures[0]?.probability_appearance}, P(60+) match: ${minsResult.probability_60_plus_minutes.value === epResult.breakdown.fixtures[0]?.probability_60_plus_minutes}`);
    console.log(`  - shrinkage diagnostics:`, epResult.breakdown.shrinkage_diagnostics);
  }
}

runAudit();
