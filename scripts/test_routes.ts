import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
} from "../services/fpl_service.js";
import {
  projectSquadMultiGameweek,
  projectPlayerMultiGameweek,
  MULTI_GW_PROJECTION_VERSION,
} from "../services/multi_gw_projection.js";

async function checkRouteParity() {
  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const teamData = await fetchTeamData(4107702, bootstrap.reference_gameweek);
  const snapshot = bootstrap.snapshot;

  const regNames = ["Raya", "Calafiori", "Konsa", "Hughes", "Haaland", "Fernandes"];
  const regPlayers = bootstrap.players.filter((p) => regNames.some((n) => p.web_name.includes(n)));

  console.log("=== ROUTE PARITY AUDIT ===");
  for (const player of regPlayers) {
    const singleCall = projectPlayerMultiGameweek({
      player,
      snapshot,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      history: teamData.player_histories[player.id],
      horizon: 5,
    });

    const squadCall = projectSquadMultiGameweek({
      players: [player],
      snapshot,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories: teamData.player_histories,
      horizon: 5,
    })[0];

    const maxDelta = Math.max(
      ...singleCall.gameweeks.map((g, idx) =>
        Math.abs(g.expected_points - squadCall.gameweeks[idx].expected_points)
      )
    );

    console.log(
      `Player: ${player.web_name.padEnd(14)} | Contract: ${singleCall.provenance.models.multi_gw_version} | Snap: ${singleCall.snapshot_id} | Max Delta: ${maxDelta.toFixed(6)}`
    );
  }
}

checkRouteParity().catch(console.error);
