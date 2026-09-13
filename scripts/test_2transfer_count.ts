import { fetchBootstrapData, fetchTeamData } from "../services/fpl_service.js";
import { calculatePostTransferBank } from "../services/transfer_engine.js";

async function check() {
  const bootstrap = await fetchBootstrapData();
  const teamData = await fetchTeamData(4107702, bootstrap.reference_gameweek);
  const squadElements = teamData.picks.map((pick: any) => {
    const p = bootstrap.players.find((pl: any) => pl.id === pick.element);
    const nowCost = p?.now_cost ?? 50;
    return {
      id: pick.element,
      web_name: p?.web_name || `Player ${pick.element}`,
      element_type: p?.element_type || pick.element_type || 1,
      team: p?.team || 1,
      now_cost: nowCost,
      selling_price: pick.selling_price ?? nowCost,
      purchase_price: pick.purchase_price ?? nowCost,
    };
  });
  const activePlayers = bootstrap.players.filter((p: any) => p.status !== "u");
  const ownedIds = new Set(squadElements.map((p: any) => p.id));
  const bank = teamData.transfers?.bank ?? 0;

  let affordableCount = 0;
  let rawCount = 0;
  for (let i = 0; i < squadElements.length; i++) {
    for (let j = i + 1; j < squadElements.length; j++) {
      const out1 = squadElements[i];
      const out2 = squadElements[j];
      const cands1 = activePlayers.filter((p: any) => p.element_type === out1.element_type && !ownedIds.has(p.id));
      const cands2 = activePlayers.filter((p: any) => p.element_type === out2.element_type && !ownedIds.has(p.id));
      for (const in1 of cands1) {
        for (const in2 of cands2) {
          rawCount++;
          if (in1.id === in2.id) continue;
          if (out1.element_type === out2.element_type && in1.id > in2.id) continue;
          const bankCheck = calculatePostTransferBank(bank, [out1, out2], [in1, in2]);
          if (!bankCheck.isAffordable) continue;
          affordableCount++;
        }
      }
    }
  }
  console.log("Raw 2-transfer combinations:", rawCount);
  console.log("Total legal budget affordable 2-transfer combinations:", affordableCount);
}
check().catch(console.error);
