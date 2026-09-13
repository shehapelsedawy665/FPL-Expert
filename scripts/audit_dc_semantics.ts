import { fetchBootstrapData, fetchPlayerSummary } from "../services/fpl_service.js";

async function verifyDCFields() {
  const b = await fetchBootstrapData();
  let defMatch = 0;
  let midFwdMatch = 0;
  let gkpMatch = 0;

  for (let i = 0; i < 30; i++) {
    const p = b.players[i];
    const s = await fetchPlayerSummary(p.id);
    if (!s.history || s.history.length === 0) continue;

    for (const h of s.history) {
      const cbi = Number(h.clearances_blocks_interceptions) || 0;
      const tackles = Number(h.tackles) || 0;
      const rec = Number(h.recoveries) || 0;
      const dc = Number(h.defensive_contribution) || 0;

      if (p.element_type === 2) { // DEF
        const cbit = cbi + tackles;
        if (dc === cbit) defMatch++;
        else console.log(`DEF mismatch: p=${p.web_name}, dc=${dc}, cbit=${cbit}, rec=${rec}`);
      } else if (p.element_type === 3 || p.element_type === 4) { // MID / FWD
        const cbirt = cbi + tackles + rec;
        if (dc === cbirt) midFwdMatch++;
        else console.log(`MID/FWD mismatch: p=${p.web_name}, dc=${dc}, cbirt=${cbirt}`);
      } else if (p.element_type === 1) { // GKP
        if (dc === 0) gkpMatch++;
      }
    }
  }

  console.log(`Verified matches: DEF cbit == dc: ${defMatch}, MID/FWD cbirt == dc: ${midFwdMatch}, GKP dc == 0: ${gkpMatch}`);
}

verifyDCFields();
