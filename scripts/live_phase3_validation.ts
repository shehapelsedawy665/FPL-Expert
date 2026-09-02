import { fetchBootstrapData, fetchFixtures, fetchTeamData, fetchPlayerSummary, addFixtureData } from "../services/fpl_service.js";
import { addRatings } from "../services/rating_engine.js";
import { analyzeTeamSquad } from "../services/team_analyzer.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import { buildPlayerExpectedMinutes } from "../services/expected_minutes_model.js";

async function main() {
  console.log("=======================================================");
  console.log("=== RUNNING PHASE 3 LIVE VALIDATION (TEAM ID: 4107702) ===");
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
  console.log("PHASE 3 PLAYING-TIME MODEL TRACES FOR 6 TARGET PLAYERS");
  console.log("=======================================================");

  for (const p of targetPlayers) {
    const summary = await fetchPlayerSummary(p.id);
    const history = summary.history || [];

    const features = buildPlayerPredictionFeatures({
      player: p,
      snapshot: bootstrap.snapshot,
      history,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
    });

    const minModel = buildPlayerExpectedMinutes({
      player: p,
      features,
      snapshot: bootstrap.snapshot,
      history,
    });

    const b = minModel.breakdown;

    console.log(`\n========================================`);
    console.log(`PLAYER: ${p.web_name} (ID: ${p.id}, Team: ${p.team_name || p.team}, Pos: ${p.position_label || p.element_type})`);
    console.log(`A. Availability:`);
    console.log(`   - status: ${b.availability.status}`);
    console.log(`   - official chance: ${b.availability.official_chance_next !== null ? b.availability.official_chance_next + "%" : "null"}`);
    console.log(`   - fallback used: ${b.availability.fallback_used} (reason: ${b.availability.fallback_reason || "N/A"})`);
    console.log(`   - probability_available: ${b.availability.probability_available}`);
    console.log(`B. Historical Evidence:`);
    console.log(`   - completed GWs: ${b.historical_evidence.completed_gameweeks_count}`);
    console.log(`   - appearances: ${b.historical_evidence.season_appearances}`);
    console.log(`   - starts: ${b.historical_evidence.season_starts}`);
    console.log(`   - 60+ appearances: ${b.historical_evidence.season_sixty_plus_appearances}`);
    console.log(`   - average minutes when started: ${b.historical_evidence.average_minutes_when_started} (fallback: ${b.historical_evidence.starts_fallback_used})`);
    console.log(`   - average minutes as substitute: ${b.historical_evidence.average_minutes_as_substitute} (fallback: ${b.historical_evidence.sub_fallback_used})`);
    console.log(`C. Model Probabilities:`);
    console.log(`   - probability_available: ${minModel.probability_available.value} (${minModel.probability_available.validity})`);
    console.log(`   - probability_appearance: ${minModel.probability_appearance.value} (${minModel.probability_appearance.validity})`);
    console.log(`   - probability_start: ${minModel.probability_start.value} (${minModel.probability_start.validity})`);
    console.log(`   - probability_60_plus_minutes: ${minModel.probability_60_plus_minutes.value} (${minModel.probability_60_plus_minutes.validity})`);
    console.log(`D. Expected Minutes:`);
    console.log(`   - start contribution: ${b.minutes_decomposition.start_contribution}`);
    console.log(`   - substitute contribution: ${b.minutes_decomposition.substitute_contribution}`);
    console.log(`   - expected_minutes: ${minModel.expected_minutes.value} (${minModel.expected_minutes.validity})`);
    console.log(`E. Samples / Shrinkage:`);
    console.log(`   - raw appearance rate: ${b.shrinkage.raw_appearance_rate} -> shrunk: ${b.shrinkage.shrunk_appearance_rate} (prior: ${b.shrinkage.prior_appearance_rate})`);
    console.log(`   - raw start rate: ${b.shrinkage.raw_start_rate} -> shrunk: ${b.shrinkage.shrunk_start_rate} (prior: ${b.shrinkage.prior_start_rate})`);
    console.log(`   - raw 60+ rate: ${b.shrinkage.raw_60plus_rate} -> shrunk: ${b.shrinkage.shrunk_60plus_rate} (prior: ${b.shrinkage.prior_60plus_rate})`);
    console.log(`   - prior weight: ${b.shrinkage.prior_sample_weight}, sample size: ${b.shrinkage.sample_size}`);
    console.log(`F. Validity / Provenance:`);
    console.log(`   - historical cutoff: ${b.historical_cutoff_gameweek}`);
    console.log(`   - prediction GW: ${b.prediction_gameweek}`);
    console.log(`   - fixture count: ${b.fixture_count} (${b.gameweek_type})`);
    console.log(`   - source: ${minModel.expected_minutes.source}`);
    console.log(`   - model version: ${minModel.model_version}`);
  }

  console.log("\n=======================================================");
  console.log("REGRESSION PROOF: LEGACY SCORES & STARTING XI / BENCH");
  console.log("=======================================================");
  console.log(`Starting XI Formation: ${squadAnalysis.analysis.starting_xi.formation_display}`);
  console.log(`Starting XI Player Count: ${squadAnalysis.analysis.starting_xi.players.length}`);
  console.log(`Bench Goalkeeper: ${squadAnalysis.analysis.bench.goalkeeper?.web_name}`);
  console.log(`Bench Substitutes: ${squadAnalysis.analysis.bench.substitutes.map(s => s.web_name).join(", ")}`);
  console.log(`Captain: ${squadAnalysis.analysis.captaincy.captain?.web_name}, VC: ${squadAnalysis.analysis.captaincy.vice_captain?.web_name}`);

  for (const p of targetPlayers) {
    const rated = ratedSquadPlayers.find(rp => rp.id === p.id);
    if (rated) {
      console.log(`Player ${rated.web_name}: Expert Score = ${rated.expert_score}, Future FPL Score = ${rated.future_fpl_score}, Form = ${rated.current_form_score}, Legacy Exp Mins Proxy = ${rated.expected_minutes_proxy}`);
    }
  }
}

main().catch(console.error);
