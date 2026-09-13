import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
} from "../services/fpl_service.js";
import {
  projectPlayerMultiGameweek,
} from "../services/multi_gw_projection.js";

async function runStaticRoleProof() {
  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const teamData = await fetchTeamData(4107702, bootstrap.reference_gameweek);
  const snapshot = bootstrap.snapshot;

  const haaland = bootstrap.players.find((p) => p.web_name === "Haaland");
  const konsa = bootstrap.players.find((p) => p.web_name === "Konsa");

  const hProj = projectPlayerMultiGameweek({
    player: haaland,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    history: teamData.player_histories[haaland.id],
    horizon: 5,
  });

  const kProj = projectPlayerMultiGameweek({
    player: konsa,
    snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    history: teamData.player_histories[konsa.id],
    horizon: 5,
  });

  console.log("=== STARTER STATIC ROLE INPUTS: HAALAND ===");
  for (const gw of hProj.gameweeks) {
    console.log(`GW${gw.gameweek}: ExpMins=${gw.expected_minutes}, P(App)=${gw.probability_appearance}, P(Start)=${gw.probability_start}, P(60+)=${gw.probability_60_plus_minutes}`);
  }

  console.log("\n=== BENCH/ROTATION STATIC ROLE INPUTS: KONSA ===");
  for (const gw of kProj.gameweeks) {
    console.log(`GW${gw.gameweek}: ExpMins=${gw.expected_minutes}, P(App)=${gw.probability_appearance}, P(Start)=${gw.probability_start}, P(60+)=${gw.probability_60_plus_minutes}`);
  }
}

runStaticRoleProof().catch(console.error);
