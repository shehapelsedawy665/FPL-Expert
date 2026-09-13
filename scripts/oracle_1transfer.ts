import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  getSharedPlayerHistories,
} from "../services/fpl_service.js";
import {
  runTransferEngine,
  calculatePostTransferBank,
  isClubConstraintValid,
  TeamFinancialState,
} from "../services/transfer_engine.js";
import { projectSquadMultiGameweek } from "../services/multi_gw_projection.js";

async function main() {
  const bootstrap = await fetchBootstrapData();
  const fixtures = await fetchFixtures();
  const teamId = 4107702;
  const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
  const playerHistories = teamData.player_histories || getSharedPlayerHistories();

  const squadElements = teamData.picks.map((pick: any) => {
    const p = bootstrap.players.find((pl: any) => pl.id === pick.element);
    const nowCost = p?.now_cost ?? 50;
    return {
      id: pick.element,
      web_name: p?.web_name || `Player ${pick.element}`,
      element_type: p?.element_type || pick.element_type || 1,
      team: p?.team || 1,
      now_cost: nowCost,
      selling_price: nowCost,
      purchase_price: nowCost,
      status: p?.status,
      news: p?.news,
      chance_of_playing_next_round: p?.chance_of_playing_next_round,
    };
  });

  const activePlayers = bootstrap.players.filter((p: any) => p.status !== "u");
  const projs = projectSquadMultiGameweek({
    players: activePlayers,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories,
    horizon: 5,
  });
  const projMap = new Map(projs.map((p) => [p.player_id, p]));

  // Owned IDs
  const ownedIds = new Set(squadElements.map((p) => p.id));
  const bank = 0;

  // Let us count ALL legal 1-transfers across the ENTIRE active player pool
  let totalCandidatesConsidered = 0;
  let totalLegal1Transfers = 0;
  const legal1Transfers: Array<{ out: any; in: any; bankAfter: number }> = [];

  for (const outP of squadElements) {
    const candidates = activePlayers.filter(
      (p: any) => p.element_type === outP.element_type && !ownedIds.has(p.id)
    );
    for (const inP of candidates) {
      totalCandidatesConsidered++;
      // Check budget
      const bankCheck = calculatePostTransferBank(bank, [outP], [inP]);
      if (!bankCheck.isAffordable) continue;

      // Check club limit
      const resultingSquad = squadElements
        .filter((p) => p.id !== outP.id)
        .concat([
          {
            ...outP,
            id: inP.id,
            team: inP.team,
            web_name: inP.web_name,
            now_cost: inP.now_cost,
          },
        ]);
      const clubCheck = isClubConstraintValid(resultingSquad);
      if (!clubCheck.isValid) continue;

      totalLegal1Transfers++;
      legal1Transfers.push({ out: outP, in: inP, bankAfter: bankCheck.bankAfterTenths });
    }
  }

  console.log("Total 1-transfer combinations considered:", totalCandidatesConsidered);
  console.log("Total legal affordable 1-transfer combinations:", totalLegal1Transfers);

  // Now evaluate every legal 1-transfer plan using evaluateTransferPlan logic
  console.log("Evaluating all", legal1Transfers.length, "legal 1-transfers...");
  const tStart = Date.now();

  const results = runTransferEngine({
    squad: squadElements,
    snapshot: bootstrap.snapshot,
    allPlayers: bootstrap.players,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories,
    financialState: {
      team_id: teamId,
      snapshot_id: bootstrap.snapshot.snapshot_id,
      bank: 0,
      available_free_transfers: 1,
      owned_players: squadElements.map((p) => ({
        id: p.id,
        web_name: p.web_name,
        element_type: p.element_type,
        team: p.team,
        now_cost: p.now_cost,
        selling_price: p.selling_price,
        purchase_price: p.purchase_price,
      })),
      is_historical: false,
    },
    horizon: 5,
    discountFactor: 0.95,
    maxTransfers: 1,
    minTransferGainThreshold: -100, // evaluate all
  });

  console.log("Transfer engine evaluated in", Date.now() - tStart, "ms");
  console.log("Evaluated plans:", results.audit.evaluated_plans_count);
  console.log("Legal 1-transfers in audit:", results.audit.legal_1_transfer_count);
  console.log("Hold discounted total:", results.hold_plan.team_horizon_expected_points);
  console.log("Recommended action:", results.recommendation_action);
  console.log(
    "Best plan:",
    results.recommended_plan.transfers_out.map((p) => p.web_name).join("+") || "HOLD",
    "->",
    results.recommended_plan.transfers_in.map((p) => p.web_name).join("+") || "HOLD"
  );
  console.log("Gross gain:", results.recommended_plan.gross_projected_gain);
  console.log("Net gain:", results.recommended_plan.net_projected_gain);
  console.log("Margin vs best alternative:", results.margin_vs_best_alternative);

  console.log("\nTop 10 1-transfer alternatives in production transfer engine:");
  for (const p of results.top_1_transfer_plans.slice(0, 10)) {
    console.log(
      `${p.transfers_out[0].web_name} (£${(p.transfers_out[0].selling_price / 10).toFixed(1)}m) -> ${p.transfers_in[0].web_name} (£${(p.transfers_in[0].now_cost / 10).toFixed(1)}m) | bankAfter: £${(p.bank_after / 10).toFixed(1)}m | gross: ${p.gross_projected_gain.toFixed(2)} | net: ${p.net_projected_gain.toFixed(2)}`
    );
  }
}

main().catch(console.error);

