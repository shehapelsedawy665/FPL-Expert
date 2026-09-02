import { fetchBootstrapData, fetchFixtures, fetchTeamData, fetchPlayerSummary, addFixtureData } from "../services/fpl_service.js";
import { addRatings } from "../services/rating_engine.js";
import { analyzeTeamSquad } from "../services/team_analyzer.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import { GameweekBoundary, PredictionSnapshot, DataValidity } from "../services/prediction_contract.js";

async function main() {
  console.log("=== RUNNING PHASE 2 SYNTHETIC DETERMINISTIC VALIDATION ===");

  const synthBoundary = new GameweekBoundary({
    last_finished_gameweek: 3,
    in_progress_gameweek: null,
    prediction_gameweek: 4,
    historical_cutoff_gameweek: 3,
  });
  const synthSnapshot = new PredictionSnapshot({
    snapshot_id: "synth_snap_gw4_cutoff3",
    boundary: synthBoundary,
  });

  // Synthetic player with DGW in history (GW2 has 2 fixtures)
  const synthPlayer = { id: 999, element_type: 4, team: 1, now_cost: 100, penalties_order: 1 };
  const synthHistoryDGW = [
    { round: 1, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 },
    { round: 2, minutes: 90, starts: 1, goals_scored: 1, total_points: 7 }, // DGW fix A
    { round: 2, minutes: 45, starts: 0, goals_scored: 0, total_points: 2 }, // DGW fix B
    { round: 3, minutes: 0, starts: 0, goals_scored: 0, total_points: 0 }, // GW3: 0 minutes
  ];

  // Case 1: NORMAL GW Fixtures for GW4
  const normalFixtures = [
    { id: 101, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
  ];
  const normalFeatures = buildPlayerPredictionFeatures({
    player: synthPlayer,
    snapshot: synthSnapshot,
    history: synthHistoryDGW,
    allFixtures: normalFixtures,
  });
  console.log("\n[SYNTHETIC CASE 1: NORMAL GW]");
  console.log(`- prediction_gw_fixture_count: ${normalFeatures.fixtures.prediction_gw_fixture_count} (type: ${normalFeatures.fixtures.gameweek_type})`);
  console.log(`- prediction_gw_opponent: ${normalFeatures.fixtures.prediction_gw_opponent.value} (${normalFeatures.fixtures.prediction_gw_opponent.validity})`);
  console.log(`- prediction_gw_is_home: ${normalFeatures.fixtures.prediction_gw_is_home.value} (${normalFeatures.fixtures.prediction_gw_is_home.validity})`);
  console.log(`- prediction_gw_difficulty: ${normalFeatures.fixtures.prediction_gw_difficulty.value} (${normalFeatures.fixtures.prediction_gw_difficulty.validity})`);
  console.log(`- last_3_gameweeks rounds_included: [${normalFeatures.windows.last_3_gameweeks.rounds_included.join(", ")}]`);
  console.log(`- last_3_gameweeks matches_evaluated_count: ${normalFeatures.windows.last_3_gameweeks.matches_evaluated_count}, fixture_rows_count: ${normalFeatures.windows.last_3_gameweeks.fixture_rows_count}`);
  console.log(`- last_3_gameweeks minutes: ${normalFeatures.windows.last_3_gameweeks.minutes.value}, points: ${normalFeatures.windows.last_3_gameweeks.points.value}`);

  // Case 2: BLANK GW (BGW) Fixtures for GW4 (No fixture in GW4, scheduled fixture in GW5)
  const bgwFixtures = [
    { id: 201, event: 5, team_h: 1, team_a: 6, team_h_difficulty: 3, team_a_difficulty: 3 },
  ];
  const bgwFeatures = buildPlayerPredictionFeatures({
    player: synthPlayer,
    snapshot: synthSnapshot,
    history: synthHistoryDGW,
    allFixtures: bgwFixtures,
  });
  console.log("\n[SYNTHETIC CASE 2: BLANK GW (BGW)]");
  console.log(`- prediction_gw_fixture_count: ${bgwFeatures.fixtures.prediction_gw_fixture_count} (type: ${bgwFeatures.fixtures.gameweek_type})`);
  console.log(`- prediction_gw_fixtures: ${JSON.stringify(bgwFeatures.fixtures.prediction_gw_fixtures)}`);
  console.log(`- prediction_gw_opponent: ${bgwFeatures.fixtures.prediction_gw_opponent.value} (${bgwFeatures.fixtures.prediction_gw_opponent.validity})`);
  console.log(`- next_scheduled_fixture_gameweek: ${bgwFeatures.fixtures.next_scheduled_fixture_gameweek.value} (${bgwFeatures.fixtures.next_scheduled_fixture_gameweek.validity})`);
  console.log(`- next_scheduled_opponent: ${bgwFeatures.fixtures.next_scheduled_opponent.value}, is_home: ${bgwFeatures.fixtures.next_scheduled_is_home.value}, difficulty: ${bgwFeatures.fixtures.next_scheduled_difficulty.value}`);

  // Case 3: DOUBLE GW (DGW) Fixtures for GW4
  const dgwFixtures = [
    { id: 301, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
    { id: 302, event: 4, team_h: 3, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
  ];
  const dgwFeatures = buildPlayerPredictionFeatures({
    player: synthPlayer,
    snapshot: synthSnapshot,
    history: synthHistoryDGW,
    allFixtures: dgwFixtures,
  });
  console.log("\n[SYNTHETIC CASE 3: DOUBLE GW (DGW)]");
  console.log(`- prediction_gw_fixture_count: ${dgwFeatures.fixtures.prediction_gw_fixture_count} (type: ${dgwFeatures.fixtures.gameweek_type})`);
  console.log(`- prediction_gw_fixtures count: ${dgwFeatures.fixtures.prediction_gw_fixtures.length}`);
  console.log(`- prediction_gw_fixtures: ${JSON.stringify(dgwFeatures.fixtures.prediction_gw_fixtures)}`);
  console.log(`- prediction_gw_opponent: ${dgwFeatures.fixtures.prediction_gw_opponent.value} (${dgwFeatures.fixtures.prediction_gw_opponent.validity})`);
  console.log(`- first_prediction_gw_fixture_opponent: ${dgwFeatures.fixtures.first_prediction_gw_fixture_opponent.value} (${dgwFeatures.fixtures.first_prediction_gw_fixture_opponent.validity})`);

  console.log("\n=======================================================");
  console.log("=== RUNNING PHASE 2 LIVE VALIDATION (TEAM ID: 4107702) ===");
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
  console.log("PHASE 2 FEATURE TRACES FOR 6 TARGET PLAYERS");
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

    console.log(`\n========================================`);
    console.log(`PLAYER: ${p.web_name} (ID: ${p.id}, Team: ${p.team_name || p.team}, Pos: ${p.position_label || p.element_type})`);
    console.log(`A. Snapshot:`);
    console.log(`   - prediction_gameweek: ${features.prediction_gameweek}`);
    console.log(`   - historical_cutoff_gameweek: ${features.historical_cutoff_gameweek}`);
    console.log(`B. Minutes Evidence:`);
    console.log(`   - season_minutes: ${features.minutes_evidence.season_minutes.value} (${features.minutes_evidence.season_minutes.validity})`);
    console.log(`   - season_appearances: ${features.minutes_evidence.season_appearances.value} (${features.minutes_evidence.season_appearances.validity})`);
    console.log(`   - season_starts: ${features.minutes_evidence.season_starts.value} (${features.minutes_evidence.season_starts.validity})`);
    console.log(`   - last_3_appearance_minutes: ${features.minutes_evidence.recent_3_appearance_minutes.value}`);
    console.log(`   - last_5_appearance_minutes: ${features.minutes_evidence.recent_5_appearance_minutes.value}`);
    console.log(`   - last_3_gw_minutes: ${features.minutes_evidence.recent_3_gw_minutes.value}`);
    console.log(`   - last_5_gw_minutes: ${features.minutes_evidence.recent_5_gw_minutes.value}`);
    console.log(`   - start_rate: ${features.minutes_evidence.start_rate.value}% (${features.minutes_evidence.start_rate.validity})`);
    console.log(`   - appearance_rate: ${features.minutes_evidence.appearance_rate.value}% (${features.minutes_evidence.appearance_rate.validity})`);
    console.log(`   - sixty_plus_minute_rate: ${features.minutes_evidence.sixty_plus_minute_rate.value}% (${features.minutes_evidence.sixty_plus_minute_rate.validity})`);
    console.log(`   - consecutive_starts: ${features.minutes_evidence.consecutive_starts.value}`);
    console.log(`C. Performance Rates (Per 90):`);
    console.log(`   - points_per90: ${features.per_90.points_per90.value} (${features.per_90.points_per90.validity})`);
    console.log(`   - goals_per90: ${features.per_90.goals_per90.value} (${features.per_90.goals_per90.validity})`);
    console.log(`   - assists_per90: ${features.per_90.assists_per90.value} (${features.per_90.assists_per90.validity})`);
    console.log(`   - xg_per90: ${features.per_90.xg_per90.value} (${features.per_90.xg_per90.validity})`);
    console.log(`   - xa_per90: ${features.per_90.xa_per90.value} (${features.per_90.xa_per90.validity})`);
    console.log(`   - xgi_per90: ${features.per_90.xgi_per90.value} (${features.per_90.xgi_per90.validity})`);
    console.log(`D. Fixture Context:`);
    console.log(`   - prediction_gw_fixtures: ${JSON.stringify(features.fixtures.prediction_gw_fixtures)}`);
    console.log(`   - fixture_count: ${features.fixtures.prediction_gw_fixture_count} (type: ${features.fixtures.gameweek_type})`);
    console.log(`   - prediction_gw_opponent: ${features.fixtures.prediction_gw_opponent.value} (is_home: ${features.fixtures.prediction_gw_is_home.value})`);
    console.log(`   - next_scheduled_opponent: ${features.fixtures.next_scheduled_opponent.value} (GW: ${features.fixtures.next_scheduled_fixture_gameweek.value})`);
    console.log(`   - difficulty: ${features.fixtures.prediction_gw_difficulty.value}`);
    console.log(`   - next_3_avg_difficulty: ${features.fixtures.next_3_avg_difficulty.value}`);
    console.log(`   - next_5_avg_difficulty: ${features.fixtures.next_5_avg_difficulty.value}`);
    console.log(`E. Set Pieces:`);
    console.log(`   - penalty_role: ${features.set_pieces.penalty_role} (raw: ${features.set_pieces.penalties_order_raw.value}, validity: ${features.set_pieces.penalties_order_raw.validity})`);
    console.log(`   - freekick_role: ${features.set_pieces.freekick_role} (raw: ${features.set_pieces.direct_freekicks_order_raw.value}, validity: ${features.set_pieces.direct_freekicks_order_raw.validity})`);
    console.log(`   - corner_role: ${features.set_pieces.corner_role} (raw: ${features.set_pieces.corners_and_indirect_freekicks_order_raw.value}, validity: ${features.set_pieces.corners_and_indirect_freekicks_order_raw.validity})`);
    console.log(`F. Availability:`);
    console.log(`   - status: ${features.availability.status.value}`);
    console.log(`   - chance_of_playing_next_round: ${features.availability.chance_of_playing_next_round.value} (${features.availability.chance_of_playing_next_round.validity})`);
    console.log(`   - news: ${features.availability.news.value}`);
    console.log(`G. Transfer / Ownership:`);
    console.log(`   - ownership: ${features.transfers.selected_by_percent.value}%`);
    console.log(`   - current_gw_net_transfers: ${features.transfers.event_net_transfers.value}`);
    console.log(`   - cumulative_net_transfers: ${features.transfers.cumulative_net_transfers.value}`);
    console.log(`H. Validity / Provenance:`);
    console.log(`   - gameweek_rounds_used: [${features.provenance.gameweek_rounds_used.join(", ")}]`);
    console.log(`   - completed_rounds_used: [${features.provenance.completed_rounds_used.join(", ")}]`);
    console.log(`   - fixture_rows_used: ${features.provenance.fixture_rows_used}`);
    console.log(`   - in_progress_rounds_excluded: [${features.provenance.in_progress_rounds_excluded.join(", ")}]`);
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
      console.log(`Player ${rated.web_name}: Expert Score = ${rated.expert_score}, Future FPL Score = ${rated.future_fpl_score}, Form = ${rated.current_form_score}`);
    }
  }
}

main().catch(console.error);
