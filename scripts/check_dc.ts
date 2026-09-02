import { fetchBootstrapData, fetchPlayerSummary } from "../services/fpl_service.js";

async function checkDC() {
  const b = await fetchBootstrapData();
  console.log("Checking sample defensive contribution data...");
  const sampleIds = [8, 31, 212, 411, 426, 1]; // Calafiori, Konsa, Hughes, Haaland, Bruno, Raya
  for (const id of sampleIds) {
    const p = b.players.find(pl => pl.id === id);
    const s = await fetchPlayerSummary(id);
    console.log(`\nPlayer: ${p.web_name} (Pos: ${p.element_type})`);
    console.log(`Bootstrap totals: def_contrib: ${p.defensive_contribution}, CBI: ${p.clearances_blocks_interceptions}, tackles: ${p.tackles}, rec: ${p.recoveries}`);
    if (s.history) {
      for (const h of s.history) {
        console.log(`  GW${h.round}: mins: ${h.minutes}, pts: ${h.total_points}, def_contrib: ${h.defensive_contribution}, cbi: ${h.clearances_blocks_interceptions}, tackles: ${h.tackles}, rec: ${h.recoveries}, bps: ${h.bps}, bonus: ${h.bonus}`);
      }
    }
  }
}

checkDC();
