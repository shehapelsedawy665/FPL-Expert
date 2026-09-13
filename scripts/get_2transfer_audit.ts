import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  getSharedPlayerHistories,
} from "../services/fpl_service.js";
import { runTransferEngine, createCurrentLiveTransferSnapshot } from "../services/transfer_engine.js";

async function main() {
  const bootstrap = await fetchBootstrapData();
  const fixtures = await fetchFixtures();
  const teamId = 4107702;
  const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
  const playerHistories = teamData.player_histories || getSharedPlayerHistories();

  const snapshot = createCurrentLiveTransferSnapshot(bootstrap.events);

  const owned_players = teamData.picks.map((pick: any) => {
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
      status: p?.status,
      news: p?.news,
      chance_of_playing_next_round: p?.chance_of_playing_next_round,
    };
  });

  const financialState = {
    team_id: teamId,
    snapshot_id: snapshot.snapshot_id,
    bank: teamData.transfers?.bank ?? 0,
    available_free_transfers: 1,
    owned_players,
    is_historical: false,
  };

  const results = runTransferEngine({
    financialState,
    snapshot,
    allPlayers: bootstrap.players,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories,
    horizon: 5,
    discountFactor: 0.95,
    maxTransfers: 2,
    minTransferGainThreshold: 0.25,
  });

  console.log("=== AUDIT SUMMARY ===");
  console.log("Audit:", JSON.stringify(results.audit, null, 2));
  console.log("Margin vs best alternative:", JSON.stringify(results.margin_vs_best_alternative, null, 2));

  console.log("\n=== TOP 10 1-TRANSFER PLANS ===");
  results.top_1_transfer_plans.slice(0, 10).forEach((p, idx) => {
    console.log(
      `${idx + 1}. [${p.plan_id}] ${p.transfers_out[0].web_name} (£${(p.transfers_out[0].selling_price / 10).toFixed(1)}m) -> ${p.transfers_in[0].web_name} (£${(p.transfers_in[0].now_cost / 10).toFixed(1)}m) | bank: £${(p.bank_after / 10).toFixed(1)}m | gross: ${p.gross_projected_gain.toFixed(2)} | hit: ${p.hit_cost} | net: ${p.net_projected_gain.toFixed(2)}`
    );
  });

  console.log("\n=== TOP 10 2-TRANSFER PLANS ===");
  results.top_2_transfer_plans.slice(0, 10).forEach((p, idx) => {
    const outNames = p.transfers_out.map((o) => `${o.web_name} (£${(o.selling_price / 10).toFixed(1)}m)`).join(" + ");
    const inNames = p.transfers_in.map((i) => `${i.web_name} (£${(i.now_cost / 10).toFixed(1)}m)`).join(" + ");
    console.log(
      `${idx + 1}. [${p.plan_id}] ${outNames} -> ${inNames} | bank: £${(p.bank_after / 10).toFixed(1)}m | gross: ${p.gross_projected_gain.toFixed(2)} | hit: ${p.hit_cost} | net: ${p.net_projected_gain.toFixed(2)}`
    );
  });
}

main().catch(console.error);
