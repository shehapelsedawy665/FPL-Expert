import { createHash } from "crypto";
import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  getSharedPlayerHistories,
} from "../services/fpl_service.js";
import {
  runTransferEngine,
  TRANSFER_ENGINE_VERSION,
  FPL_TRANSFER_RULES_VERSION,
  TeamFinancialState,
} from "../services/transfer_engine.js";

const EXPECTED_SQUAD_HASH = "43604e9c500ebc57ded54db144185f036a467100704f033d61f652c43cda15f7";
const EXPECTED_SQUAD_NAMES = [
  "Raya", "Virgil", "Shaw", "Calafiori", "Slater",
  "B.Fernandes", "Rogers", "Wirtz", "Gonzalo", "Haaland",
  "João Pedro", "Dubravka", "Konsa", "Hughes", "Diop",
];

export async function runPhase6cLiveValidation() {
  console.log("================================================================================");
  console.log("PHASE 6C — TRANSFER DECISION ENGINE LIVE VALIDATION REPORT");
  console.log("================================================================================");

  const teamId = 4107702;
  const bootstrap = await fetchBootstrapData();
  const fixtures = await fetchFixtures();
  const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
  const playerHistories = teamData.player_histories || getSharedPlayerHistories();

  // 1. Squad Identity & Hash Verification
  const squadElements = teamData.picks.map((pick: any) => {
    const p = bootstrap.players.find((pl: any) => pl.id === pick.element);
    const nowCost = p?.now_cost ?? 50;
    return {
      id: pick.element,
      web_name: p?.web_name || `Player ${pick.element}`,
      element_type: p?.element_type || pick.element_type || 1,
      team: p?.team || 1,
      now_cost: nowCost,
      selling_price: typeof pick.selling_price === "number" ? pick.selling_price : nowCost,
      purchase_price: typeof pick.purchase_price === "number" ? pick.purchase_price : nowCost,
      status: p?.status,
      news: p?.news,
      chance_of_playing_next_round: p?.chance_of_playing_next_round,
    };
  });

  const squadIds = squadElements.map((p: any) => p.id).sort((a: number, b: number) => a - b);
  const squadNames = squadElements.map((p: any) => p.web_name);
  const computedHash = createHash("sha256")
    .update(`${bootstrap.snapshot.snapshot_id}:${squadIds.join(",")}`)
    .digest("hex");

  console.log(`Team ID:                       ${teamId} (${teamData.entry.name})`);
  console.log(`Snapshot ID:                   ${bootstrap.snapshot.snapshot_id}`);
  console.log(`Historical Cutoff GW:          ${bootstrap.snapshot.boundary.historical_cutoff_gameweek}`);
  console.log(`Prediction Gameweek:           ${bootstrap.snapshot.boundary.prediction_gameweek}`);
  console.log(`Transfer Engine Version:       ${TRANSFER_ENGINE_VERSION}`);
  console.log(`FPL Transfer Rules Contract:   ${FPL_TRANSFER_RULES_VERSION}`);
  console.log(`Squad Hash (SHA-256):          ${computedHash}`);
  console.log(`Expected Squad Hash:           ${EXPECTED_SQUAD_HASH}`);
  console.log(`Squad Identity Match:          ${computedHash === EXPECTED_SQUAD_HASH ? "VERIFIED (100% Match)" : "MISMATCH"}`);

  if (computedHash !== EXPECTED_SQUAD_HASH) {
    throw new Error(`CRITICAL SQUAD HASH MISMATCH: ${computedHash} !== ${EXPECTED_SQUAD_HASH}`);
  }

  // 2. Financial State Reporting
  const bank = typeof teamData.entry_history?.bank === "number" ? teamData.entry_history.bank : 0;
  const eventTransfers = typeof teamData.entry_history?.event_transfers === "number" ? teamData.entry_history.event_transfers : 1;
  const availableFt = eventTransfers > 0 ? 1 : 2;

  const squadSellingTotal = squadElements.reduce((sum: number, p: any) => sum + p.selling_price, 0);
  const totalTeamValue = squadSellingTotal + bank;

  console.log("\n--------------------------------------------------------------------------------");
  console.log("1. SQUAD FINANCIAL STATE AT CUTOFF (INTEGER TENTHS & £m)");
  console.log("--------------------------------------------------------------------------------");
  console.log(`Bank:                          ${bank} tenths (£${(bank / 10).toFixed(1)}m)`);
  console.log(`Available Free Transfers:      ${availableFt}`);
  console.log(`Squad Selling Value:           ${squadSellingTotal} tenths (£${(squadSellingTotal / 10).toFixed(1)}m)`);
  console.log(`Total Team Value:              ${totalTeamValue} tenths (£${(totalTeamValue / 10).toFixed(1)}m)`);
  console.log("\nOwned Squad Financials Table:");
  console.log("ID    | Name             | Pos | Club | Buy Price | Sell Value | Market Cost");
  console.log("------+------------------+-----+------+-----------+------------+------------");
  for (const p of squadElements) {
    const pos = p.element_type === 1 ? "GKP" : p.element_type === 2 ? "DEF" : p.element_type === 3 ? "MID" : "FWD";
    const club = bootstrap.teams.find((t: any) => t.id === p.team)?.short_name || String(p.team);
    console.log(
      `${String(p.id).padEnd(5)} | ${p.web_name.padEnd(16)} | ${pos.padEnd(3)} | ${club.padEnd(4)} | ` +
      `£${(p.purchase_price / 10).toFixed(1)}m`.padEnd(9) + ` | £${(p.selling_price / 10).toFixed(1)}m`.padEnd(10) + ` | £${(p.now_cost / 10).toFixed(1)}m`
    );
  }

  // 3. Run Transfer Decision Engine
  const financialState: TeamFinancialState = {
    team_id: teamId,
    snapshot_id: bootstrap.snapshot.snapshot_id,
    bank,
    available_free_transfers: availableFt,
    owned_players: squadElements,
    as_of_gameweek: bootstrap.reference_gameweek,
  };

  const horizon = 5;
  const discountFactor = 0.95;
  const maxTransfers = 2;

  const result = runTransferEngine({
    financialState,
    snapshot: bootstrap.snapshot,
    allPlayers: bootstrap.players,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories,
    horizon,
    discountFactor,
    maxTransfers,
  });

  // 4. Candidate Search Audit
  console.log("\n--------------------------------------------------------------------------------");
  console.log("2. SEARCH SPACE & COMBINATORIAL AUDIT");
  console.log("--------------------------------------------------------------------------------");
  console.log(`Candidate Pool Size:           ${result.audit.candidate_incoming_pool_size} ranked candidates`);
  console.log(`Legal 1-Transfer Combos:       ${result.audit.legal_1_transfer_count}`);
  console.log(`Legal 2-Transfer Combos:       ${result.audit.legal_2_transfer_count}`);
  console.log(`Total Evaluated Plans:         ${result.audit.evaluated_plans_count}`);
  console.log(`Optimizer Runtime:             ${result.audit.runtime_ms} ms`);

  // 5. HOLD Baseline Evaluation
  const hold = result.hold_plan;
  console.log("\n--------------------------------------------------------------------------------");
  console.log("3. HOLD BASELINE EVALUATION (0 TRANSFERS)");
  console.log("--------------------------------------------------------------------------------");
  console.log(`HOLD Horizon Discounted Total: ${hold.team_horizon_expected_points.toFixed(2)} pts`);
  console.log(`FT Rolled Status:              ${hold.ft_usage_status}`);
  console.log("\nHOLD GW-by-GW Lineup & Projections:");
  console.log("GW   | Starters (11)                                          | Form   | Captain (Bonus)       | Vice-Captain    | XI xPts | Tot xPts | Disc xPts");
  console.log("-----+--------------------------------------------------------+--------+-----------------------+-----------------+---------+----------+----------");
  for (const gw of hold.lineups_by_gw) {
    const breakdown = hold.gw_breakdown.find((b) => b.gameweek === gw.gameweek)!;
    const startersStr = gw.starting_xi_names.slice(0, 5).join(", ") + "...";
    console.log(
      `${String(gw.gameweek).padEnd(4)} | ${gw.starting_xi_names.join(", ").slice(0, 54).padEnd(54)} | ` +
      `${gw.formation_label.padEnd(6)} | ${(gw.captain_name + " (+" + gw.captaincy_bonus.toFixed(2) + ")").padEnd(21)} | ` +
      `${gw.vice_captain_name.padEnd(15)} | ${gw.starting_xi_xpts.toFixed(1).padEnd(7)} | ${gw.total_team_xpts.toFixed(2).padEnd(8)} | ${breakdown.discounted_team_points.toFixed(2)}`
    );
  }

  // 6. Recommended Transfer Plan
  const rec = result.recommended_plan;
  console.log("\n--------------------------------------------------------------------------------");
  console.log("4. RECOMMENDED ACTION & OPTIMAL TRANSFER PLAN");
  console.log("--------------------------------------------------------------------------------");
  console.log(`Decision Recommendation:       ${result.recommendation_action}`);
  console.log(`Plan ID:                       ${rec.plan_id}`);
  console.log(`Transfers Out:                 ${rec.transfers_out.map((p) => p.web_name).join(", ") || "None"}`);
  console.log(`Transfers In:                  ${rec.transfers_in.map((p) => p.web_name).join(", ") || "None"}`);
  console.log(`Transfers Count:               ${rec.transfer_count}`);
  console.log(`Free Transfers Used:           ${rec.free_transfers_used}`);
  console.log(`Paid Transfers (Hits):         ${rec.paid_transfers}`);
  console.log(`Hit Cost:                      -${rec.hit_cost} pts`);
  console.log(`Post-Transfer Bank:            £${(rec.bank_after / 10).toFixed(1)}m`);
  console.log(`Gross Projected Gain:          +${rec.gross_projected_gain.toFixed(2)} pts`);
  console.log(`Net Projected Gain:            +${rec.net_projected_gain.toFixed(2)} pts`);
  console.log(`FT Usage Status:               ${result.ft_usage_status}`);

  console.log("\nRecommended Plan GW-by-GW Decomposition:");
  console.log("GW   | Post Team Pts | HOLD Baseline | Gross GW Gain | Discount Factor | Disc Net Gain");
  console.log("-----+---------------+---------------+---------------+-----------------+--------------");
  for (const b of rec.gw_breakdown) {
    console.log(
      `${String(b.gameweek).padEnd(4)} | ${b.team_points.toFixed(2).padEnd(13)} | ` +
      `${b.hold_team_points.toFixed(2).padEnd(13)} | ` +
      `${(b.gross_gain >= 0 ? "+" : "") + b.gross_gain.toFixed(2)}`.padEnd(13) + ` | ` +
      `${b.discount_factor.toFixed(4).padEnd(15)} | ` +
      `${(b.discounted_gain >= 0 ? "+" : "") + b.discounted_gain.toFixed(2)}`
    );
  }

  // Qualitative Starting XI & Captaincy Impact
  console.log("\nQualitative Lineup & Squad Impact:");
  console.log(`- GW1 Starting XI:             Incoming player starts: ${rec.starting_xi_impact.starting_in_first_gw ? "YES" : "NO"}`);
  console.log(`- Starters Displaced:          ${rec.starting_xi_impact.replaced_starter_names.join(", ") || "None"}`);
  console.log(`- Formation Change:            ${rec.starting_xi_impact.formation_before_gw1} -> ${rec.starting_xi_impact.formation_after_gw1}`);
  console.log(`- GW1 Captain Change:          ${rec.captaincy_impact.gw1_captain_changed ? `${rec.captaincy_impact.old_captain_name} -> ${rec.captaincy_impact.new_captain_name}` : `Unchanged (${rec.captaincy_impact.new_captain_name})`}`);
  console.log(`- Captain Bonus Delta:         ${rec.captaincy_impact.captain_bonus_delta >= 0 ? "+" : ""}${rec.captaincy_impact.captain_bonus_delta.toFixed(3)} pts`);
  console.log(`- Bench Goalkeeper:            ${rec.bench_impact.bench_gk_after}`);
  console.log(`- Outfield Bench Order:        ${rec.bench_impact.outfield_bench_after.join(", ")}`);

  // 7. Top Alternative Plans
  console.log("\n--------------------------------------------------------------------------------");
  console.log("5. TOP 5 RANKED 1-TRANSFER ALTERNATIVES");
  console.log("--------------------------------------------------------------------------------");
  console.log("Rank | Plan                               | Hits | Bank Left | Gross Gain | Net Gain | Action");
  console.log("-----+------------------------------------+------+-----------+------------+----------+--------");
  result.top_1_transfer_plans.slice(0, 5).forEach((p, idx) => {
    const label = `${p.transfers_out[0].web_name} -> ${p.transfers_in[0].web_name}`;
    console.log(
      `${String(idx + 1).padEnd(4)} | ${label.padEnd(34)} | ${String(p.hit_cost).padEnd(4)} | ` +
      `£${(p.bank_after / 10).toFixed(1)}m`.padEnd(9) + ` | +${p.gross_projected_gain.toFixed(2).padEnd(9)} | +${p.net_projected_gain.toFixed(2).padEnd(7)} | ${p.ft_usage_status}`
    );
  });

  if (result.top_2_transfer_plans.length > 0) {
    console.log("\n--------------------------------------------------------------------------------");
    console.log("6. TOP 5 RANKED 2-TRANSFER ALTERNATIVES");
    console.log("--------------------------------------------------------------------------------");
    console.log("Rank | Plan                                                | Hits | Bank Left | Gross Gain | Net Gain | Action");
    console.log("-----+-----------------------------------------------------+------+-----------+------------+----------+--------");
    result.top_2_transfer_plans.slice(0, 5).forEach((p, idx) => {
      const outLabel = p.transfers_out.map((x) => x.web_name).join("+");
      const inLabel = p.transfers_in.map((x) => x.web_name).join("+");
      const label = `${outLabel} -> ${inLabel}`;
      console.log(
        `${String(idx + 1).padEnd(4)} | ${label.slice(0, 51).padEnd(51)} | ` +
        `-${String(p.hit_cost).padEnd(3)} | £${(p.bank_after / 10).toFixed(1)}m`.padEnd(9) + ` | +${p.gross_projected_gain.toFixed(2).padEnd(9)} | +${p.net_projected_gain.toFixed(2).padEnd(7)} | ${p.ft_usage_status}`
      );
    });
  }

  // 8. Horizon & Sensitivity Matrix
  console.log("\n--------------------------------------------------------------------------------");
  console.log("7. HORIZON & DISCOUNT SENSITIVITY MATRIX");
  console.log("--------------------------------------------------------------------------------");
  console.log("Horizon | Discount | Recommended Transfer Plan                    | Gross Gain | Net Gain | Action");
  console.log("--------+----------+----------------------------------------------+------------+----------+--------");
  for (const s of result.horizon_sensitivity) {
    console.log(
      `${String(s.horizon).padEnd(7)} | ${s.discount_factor.toFixed(2).padEnd(8)} | ` +
      `${s.recommended_transfers_label.slice(0, 44).padEnd(44)} | ` +
      `+${s.gross_gain.toFixed(2).padEnd(9)} | +${s.net_gain.toFixed(2).padEnd(7)} | ${s.rank_1_plan.ft_usage_status}`
    );
  }

  console.log("\n================================================================================");
  console.log("PHASE 6C LIVE VALIDATION SUCCESSFUL & READY FOR REVIEW");
  console.log("================================================================================");
}

runPhase6cLiveValidation().catch((err) => {
  console.error("FATAL ERROR in Phase 6C Live Validation:", err);
  process.exit(1);
});
