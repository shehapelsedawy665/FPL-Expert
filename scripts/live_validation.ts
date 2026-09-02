import { fetchBootstrapData, fetchFixtures, fetchTeamData, fetchPlayerSummary, addFixtureData } from "../services/fpl_service";
import { addRatings, numberValue } from "../services/rating_engine";
import { analyzeTeamSquad } from "../services/team_analyzer";

async function main() {
  console.log("=== RUNNING LIVE VALIDATION SCRIPT ===");
  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  console.log(`Snapshot ID: ${bootstrap.snapshot.snapshot_id}`);
  console.log(`Snapshot Created At: ${bootstrap.snapshot.snapshot_created_at}`);
  console.log(`Reference GW: ${bootstrap.reference_gameweek}`);
  console.log(`Gameweek Boundary:`, JSON.stringify(bootstrap.gameweek_boundary.toDict()));

  const playersWithFixtures = addFixtureData(
    bootstrap.players,
    fixtures,
    bootstrap.teams,
    bootstrap.gameweek_boundary
  );

  const ratedPlayers = addRatings(playersWithFixtures, {
    referenceGameweek: bootstrap.reference_gameweek,
    boundary: bootstrap.gameweek_boundary,
    snapshot: bootstrap.snapshot,
  });

  const teamId = 4107702;
  console.log(`\nFetching Team ID ${teamId}...`);
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

  const targetNames = ["Calafiori", "Hughes", "Konsa", "Haaland", "B.Fernandes", "Fernandes", "Raya"];
  
  console.log("\n--- SQUAD PLAYERS MATCHING TARGETS ---");
  const startingPlayers = squadAnalysis.analysis.starting_xi.players || [];
  const benchGk = squadAnalysis.analysis.bench.goalkeeper ? [squadAnalysis.analysis.bench.goalkeeper] : [];
  const benchSubs = squadAnalysis.analysis.bench.substitutes || [];
  const squadPlayers = [...startingPlayers, ...benchGk, ...benchSubs];
  
  console.log(`Squad total players: ${squadPlayers.length}`);
  console.log(`Starting XI Formation: ${squadAnalysis.analysis.starting_xi.formation_display || "Unknown"}`);
  console.log(`Captain: ${squadAnalysis.analysis.captaincy.captain?.web_name}, VC: ${squadAnalysis.analysis.captaincy.vice_captain?.web_name}`);
  
  for (const player of squadPlayers) {
    const isTarget = targetNames.some(t => player.web_name.toLowerCase().includes(t.toLowerCase()) || (player.name && player.name.toLowerCase().includes(t.toLowerCase())));
    if (isTarget) {
      console.log(`\n========================================`);
      console.log(`Player: ${player.web_name} (${player.first_name || ""} ${player.second_name || player.name || ""}) - ID: ${player.id}, Pos: ${player.position_label}, Team: ${player.team_name}`);
      console.log(`Expert Score: ${player.expert_score}, Future FPL Score: ${player.future_fpl_score}, Current Form Score: ${player.current_form_score}`);
      console.log(`Expected Minutes Proxy: ${player.expected_minutes_proxy}, Minutes Security: ${player.minutes_security}`);
      console.log(`Appearances: value=${player.appearances_value}, validity=${player.appearances_validity}, source=${player.appearances_source}`);
      console.log(`Minutes Profile Diagnostics:`, JSON.stringify(player.diagnostics?.minutes_profile, null, 2));
      console.log(`Transfer Signal (GW): ${player.transfer_signal} (horizon: ${player.transfer_signal_horizon})`);
      console.log(`Cumulative Transfer Signal: ${player.cumulative_transfer_signal} (horizon: ${player.cumulative_transfer_horizon})`);
      console.log(`Team Strength Validity: ${player.team_strength_validity}`);
      console.log(`Breakdown:`, JSON.stringify(player.rating_breakdown, null, 2));
    }
  }

  // Also check if any target players are in ratedPlayers but not in squad
  for (const target of targetNames) {
    const inSquad = squadPlayers.some(p => p.web_name.toLowerCase().includes(target.toLowerCase()));
    if (!inSquad) {
      const found = ratedPlayers.find(p => p.web_name.toLowerCase() === target.toLowerCase() || p.web_name.toLowerCase().includes(target.toLowerCase()));
      if (found) {
        console.log(`\n========================================`);
        console.log(`[Out of Squad Target] Player: ${found.web_name} (${found.name}) - ID: ${found.id}, Pos: ${found.position_label}`);
        console.log(`Expert Score: ${found.expert_score}, Future FPL Score: ${found.future_fpl_score}`);
        console.log(`Expected Minutes Proxy: ${found.expected_minutes_proxy}, Minutes Security: ${found.minutes_security}`);
        console.log(`Appearances: value=${found.appearances_value}, validity=${found.appearances_validity}, source=${found.appearances_source}`);
        console.log(`Transfer Signal: ${found.transfer_signal} (${found.transfer_signal_horizon})`);
        console.log(`Cumulative Transfer Signal: ${found.cumulative_transfer_signal} (${found.cumulative_transfer_horizon})`);
        console.log(`Breakdown:`, JSON.stringify(found.rating_breakdown, null, 2));
        console.log(`Minutes Profile Diagnostics:`, JSON.stringify(found.diagnostics?.minutes_profile, null, 2));
      }
    }
  }

  // Route Parity Verification: Single Player API vs Bulk
  console.log("\n--- ROUTE PARITY VERIFICATION ---");
  const testIds = [squadPlayers[0].id, squadPlayers[1].id];
  for (const pid of testIds) {
    const bulkPlayer = ratedPlayers.find(p => p.id === pid);
    const summary = await fetchPlayerSummary(pid);
    const singleRated = addRatings(playersWithFixtures, {
      referenceGameweek: bootstrap.reference_gameweek,
      boundary: bootstrap.gameweek_boundary,
      snapshot: bootstrap.snapshot,
    }).find(p => p.id === pid);

    const isIdentical = 
      bulkPlayer.expert_score === singleRated.expert_score &&
      bulkPlayer.future_fpl_score === singleRated.future_fpl_score &&
      bulkPlayer.expected_minutes_proxy === singleRated.expected_minutes_proxy &&
      bulkPlayer.minutes_security === singleRated.minutes_security &&
      JSON.stringify(bulkPlayer.rating_breakdown) === JSON.stringify(singleRated.rating_breakdown);

    console.log(`Player ${bulkPlayer.web_name} (ID: ${pid}) Route Parity: ${isIdentical ? "PERFECT MATCH" : "DIVERGENCE DETECTED"}`);
  }
}

main().catch(console.error);
