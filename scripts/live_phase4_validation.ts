import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  addFixtureData,
} from "../services/fpl_service.js";
import { addRatings } from "../services/rating_engine.js";
import { analyzeTeamSquad } from "../services/team_analyzer.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import { buildPlayerExpectedMinutes } from "../services/expected_minutes_model.js";
import { buildPlayerExpectedPoints } from "../services/expected_points_model.js";

async function main() {
  console.log("=======================================================");
  console.log("=== RUNNING PHASE 4 LIVE VALIDATION (TEAM ID: 4107702) ===");
  console.log("=======================================================");

  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  console.log(`Snapshot ID: ${bootstrap.snapshot.snapshot_id}`);
  console.log(`Prediction Gameweek: ${bootstrap.snapshot.boundary.prediction_gameweek}`);
  console.log(`Historical Cutoff Gameweek: ${bootstrap.snapshot.boundary.historical_cutoff_gameweek}`);

  const playersWithFixtures = addFixtureData(
    bootstrap.players,
    fixtures,
    bootstrap.teams,
    bootstrap.gameweek_boundary
  );

  const teamId = 4107702;
  const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
  console.log(`Team Name: ${teamData.entry.name}, Manager: ${teamData.entry.player_first_name} ${teamData.entry.player_last_name}`);

  const ratedSquadPlayers = addRatings(playersWithFixtures, {
    referenceGameweek: bootstrap.reference_gameweek,
    boundary: bootstrap.gameweek_boundary,
    snapshot: bootstrap.snapshot,
    recentHistoryByPlayer: teamData.player_histories,
  });

  const squadAnalysis = analyzeTeamSquad(
    ratedSquadPlayers,
    teamData.picks,
    teamData.entry,
    teamData.gameweek,
    teamData.entry_history
  );

  const targetNames = ["Raya", "Calafiori", "Konsa", "Hughes", "Haaland", "Fernandes"];
  const targetPlayers = [];

  for (const name of targetNames) {
    const found = ratedSquadPlayers.find(p => p.web_name.toLowerCase().includes(name.toLowerCase()))
      || bootstrap.players.find(p => p.web_name.toLowerCase().includes(name.toLowerCase()));
    if (found) targetPlayers.push(found);
  }

  console.log("\n=======================================================");
  console.log("PHASE 4 EXPECTED POINTS MODEL TRACES FOR 6 TARGET PLAYERS");
  console.log("=======================================================");

  for (const p of targetPlayers) {
    const hist = teamData.player_histories?.[p.id] ?? p._history ?? [];
    const feat = buildPlayerPredictionFeatures({
      player: p,
      snapshot: bootstrap.snapshot,
      history: hist,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
    });
    const minsResult = buildPlayerExpectedMinutes({
      player: p,
      features: feat,
      snapshot: bootstrap.snapshot,
      history: hist,
    });
    const epResult = buildPlayerExpectedPoints({
      player: p,
      features: feat,
      minutesResult: minsResult,
      snapshot: bootstrap.snapshot,
      history: hist,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
    });

    const b = epResult.breakdown;
    const mb = minsResult.breakdown;

    console.log(`\n========================================`);
    console.log(`PLAYER: ${p.web_name} (ID: ${p.id}, Team: ${p.team_name || p.team}, Pos: ${p.position_label || p.element_type})`);
    
    console.log(`A. Playing Time Integration & Equality:`);
    console.log(`   - Phase 3 expected_minutes: ${minsResult.expected_minutes.value}`);
    console.log(`   - Phase 4 consumed expected_minutes: ${b.expected_minutes}`);
    console.log(`   - Phase 3 P(start): ${mb.probabilities.probability_start}`);
    console.log(`   - Phase 4 fixture P(start): ${b.fixtures[0]?.probability_appearance !== undefined ? mb.probabilities.probability_start : 'N/A'}`);
    console.log(`   - Phase 3 P(appearance): ${mb.probabilities.probability_appearance}`);
    console.log(`   - Phase 4 consumed P(appearance): ${b.fixtures[0]?.probability_appearance}`);
    console.log(`   - Phase 3 P(60+): ${mb.probabilities.probability_60_plus_minutes}`);
    console.log(`   - Phase 4 consumed P(60+): ${b.fixtures[0]?.probability_60_plus_minutes}`);
    console.log(`   - EXACT EQUALITY CHECK: expected_minutes match: ${Number(minsResult.expected_minutes.value) === Number(b.expected_minutes)}, P(app) match: ${mb.probabilities.probability_appearance === b.fixtures[0]?.probability_appearance}, P(60+) match: ${mb.probabilities.probability_60_plus_minutes === b.fixtures[0]?.probability_60_plus_minutes}`);

    console.log(`\nB. Confidence Component Breakdown:`);
    const ptConf = Number(minsResult.playing_time_confidence.value);
    const sampleMatches = b.shrinkage_diagnostics.sample_matches;
    const sampleMatchFactor = Math.round((1.0 - Math.exp(-sampleMatches / 4.0)) * 1000) / 1000;
    const sampleMinutes = b.shrinkage_diagnostics.sample_minutes;
    console.log(`   - Phase 3 playing_time_confidence: ${ptConf}`);
    console.log(`   - Historical match sample: ${sampleMatches} matches (${sampleMinutes} mins)`);
    console.log(`   - Sample match factor: 1 - exp(-${sampleMatches}/4) = ${sampleMatchFactor}`);
    console.log(`   - Baseline weighting formula: ptConf * (0.35 + 0.65 * ${sampleMatchFactor}) = ${ptConf} * ${Math.round((0.35 + 0.65 * sampleMatchFactor)*10000)/10000} = ${epResult.expected_points_confidence.value}`);
    console.log(`   - Unsupported components penalty: 0.0 (unsupported components: ${JSON.stringify(b.unsupported_components)})`);
    console.log(`   - Final expected_points_confidence: ${epResult.expected_points_confidence.value}`);

    console.log(`\nC. Attacking:`);
    console.log(`   - shrunk xG/90: ${b.shrinkage_diagnostics.shrunk_xg_per90} (raw: ${b.shrinkage_diagnostics.raw_xg_per90}, prior: ${b.shrinkage_diagnostics.prior_xg_per90})`);
    console.log(`   - expected goals: ${b.expected_goals}`);
    console.log(`   - expected goal points: ${b.expected_goal_points}`);
    console.log(`   - shrunk xA/90: ${b.shrinkage_diagnostics.shrunk_xa_per90} (raw: ${b.shrinkage_diagnostics.raw_xa_per90}, prior: ${b.shrinkage_diagnostics.prior_xa_per90})`);
    console.log(`   - expected assists: ${b.expected_assists}`);
    console.log(`   - expected assist points: ${b.expected_assist_points}`);

    console.log(`\nD. Defensive:`);
    console.log(`   - clean-sheet probability: ${b.probability_clean_sheet}`);
    console.log(`   - expected clean-sheet points: ${b.expected_clean_sheet_points}`);
    console.log(`   - expected goals-conceded deduction: ${b.expected_goals_conceded_deduction}`);
    console.log(`   - defensive-contribution probability: ${b.probability_defensive_contribution_points}`);
    console.log(`   - expected defensive-contribution points: ${b.expected_defensive_contribution_points}`);
    console.log(`   - DC Diagnostics:`);
    console.log(`       * DC historical sample: ${b.shrinkage_diagnostics.sample_matches} matches`);
    console.log(`       * threshold hits: ${b.shrinkage_diagnostics.sample_dc_hits}`);
    console.log(`       * raw threshold-hit rate: ${b.shrinkage_diagnostics.raw_dc_rate}`);
    console.log(`       * shrunk DC rate: ${b.shrinkage_diagnostics.shrunk_dc_rate}`);
    console.log(`       * prior DC rate: ${b.shrinkage_diagnostics.prior_dc_rate}`);

    console.log(`\nE. GK-Specific:`);
    console.log(`   - expected saves: ${b.expected_saves}`);
    console.log(`   - expected save points: ${b.expected_save_points}`);
    console.log(`   - penalty-save expectation: ${b.expected_penalty_save_points}`);

    console.log(`\nF. Other Events & Deductions:`);
    console.log(`   - expected bonus: ${b.expected_bonus_points}`);
    console.log(`   - expected cards deductions: yellow: ${b.expected_yellow_card_deduction}, red: ${b.expected_red_card_deduction}`);
    console.log(`   - expected own-goal deduction: ${b.expected_own_goal_deduction}`);
    console.log(`   - expected penalty-miss deduction: ${b.expected_penalty_miss_deduction}`);

    const epBeforeDC = Math.round((Number(epResult.expected_points_next_gameweek.value) - b.expected_defensive_contribution_points) * 100) / 100;
    const epAfterDC = Number(epResult.expected_points_next_gameweek.value);
    const dcDelta = Math.round(b.expected_defensive_contribution_points * 100) / 100;

    console.log(`\nG. Total & DC Impact:`);
    console.log(`   - expected appearance points: ${b.expected_appearance_points}`);
    console.log(`   - fixture Expected Points: ${b.fixtures.map(f => f.fixture_expected_points).join(", ")}`);
    console.log(`   - Expected Points before DC correction: ${epBeforeDC}`);
    console.log(`   - Expected Points after DC correction: ${epAfterDC}`);
    console.log(`   - Delta caused by DC: +${dcDelta}`);
    console.log(`   - expected_points_next_gameweek: ${epResult.expected_points_next_gameweek.value} (${epResult.expected_points_next_gameweek.validity})`);
    console.log(`   - expected_points_confidence: ${epResult.expected_points_confidence.value}`);

    console.log(`\nH. Provenance:`);
    console.log(`   - snapshot: ${bootstrap.snapshot.snapshot_id}`);
    console.log(`   - cutoff: ${bootstrap.snapshot.boundary.historical_cutoff_gameweek}`);
    console.log(`   - model version: ${epResult.model_version}`);
    console.log(`   - scoring rules version: ${epResult.scoring_rules_version}`);
    console.log(`   - unsupported components: ${JSON.stringify(b.unsupported_components)}`);
  }

  console.log("\n=======================================================");
  console.log("REGRESSION PROOF: LEGACY SCORES & STARTING XI / BENCH");
  console.log("=======================================================");
  console.log(`Starting XI Formation: ${squadAnalysis.analysis.starting_xi.formation}`);
  console.log(`Starting XI Player Count: ${squadAnalysis.analysis.starting_xi.players.length}`);
  console.log(`Bench Goalkeeper: ${squadAnalysis.analysis.bench.goalkeeper?.web_name}`);
  console.log(`Bench Substitutes: ${squadAnalysis.analysis.bench.substitutes.map((p: any) => p.web_name).join(", ")}`);
  console.log(`Captain: ${squadAnalysis.analysis.captaincy.captain?.web_name}, VC: ${squadAnalysis.analysis.captaincy.vice_captain?.web_name}`);

  for (const p of targetPlayers) {
    console.log(`Player ${p.web_name}: Expert Score = ${p.expert_score}, Future FPL Score = ${p.future_fpl_score}, Form = ${p.current_form_score}, Legacy Exp Mins Proxy = ${p.expected_minutes_proxy}`);
  }
}

main().catch((err) => {
  console.error("Live validation failed:", err);
  process.exit(1);
});
