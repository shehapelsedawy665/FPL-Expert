import { fetchBootstrapData, fetchPlayerSummary } from "../services/fpl_service.js";

async function audit() {
  const b = await fetchBootstrapData();
  console.log("Positions / element_types:", JSON.stringify(b.positions, null, 2));
  const p = b.players.find(pl => pl.web_name === "Haaland") || b.players[0];
  console.log("Player bootstrap sample keys:", Object.keys(p));
  const s = await fetchPlayerSummary(p.id);
  if (s.history && s.history.length > 0) {
    console.log("History match sample keys:", Object.keys(s.history[0]));
    console.log("History row 0 sample:", s.history[0]);
  }
}

audit();

