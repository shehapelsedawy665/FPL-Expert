import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  getSharedPlayerHistories,
} from "../services/fpl_service.js";
import {
  calculatePostTransferBank,
  isClubConstraintValid,
  evaluateSquadHorizonValue,
} from "../services/transfer_engine.js";
import { projectSquadMultiGameweek, PlayerMultiGwProjection } from "../services/multi_gw_projection.js";

function roundTo(val: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

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
      team_short_name: bootstrap.teams.find((t: any) => t.id === p?.team)?.short_name || "",
      now_cost: nowCost,
      selling_price: nowCost,
      purchase_price: nowCost,
      status: p?.status,
      news: p?.news,
      chance_of_playing_next_round: p?.chance_of_playing_next_round,
    };
  });

  const activePlayers = bootstrap.players.filter((p: any) => p.status !== "u");
  console.log("Precomputing Phase 6B projections for all", activePlayers.length, "active players...");
  const t0 = Date.now();
  const projs = projectSquadMultiGameweek({
    players: activePlayers,
    snapshot: bootstrap.snapshot,
    allFixtures: fixtures,
    allTeams: bootstrap.teams,
    playerHistories,
    horizon: 5,
  });
  console.log("Projections completed in", Date.now() - t0, "ms");
  const projMap = new Map<number, PlayerMultiGwProjection>(projs.map((p) => [p.player_id, p]));

  function scoreSquad(squad: any[], horizon = 5, discount = 0.95) {
    const res = evaluateSquadHorizonValue({
      squad,
      snapshot: bootstrap.snapshot,
      precomputedProjections: projMap,
      horizon,
      discountFactor: discount,
    });
    return { totalDiscounted: res.totalHorizonScore, lineups: res.lineupsByGw, gwBreakdown: res.gwBreakdown };
  }

  const holdScore = scoreSquad(squadElements);
  console.log("HOLD discounted score:", holdScore.totalDiscounted);

  // Exhaustive 1-transfer search
  const ownedIds = new Set(squadElements.map((p) => p.id));
  const bank = 0;
  const plans: Array<{
    out: any;
    in: any;
    bankAfter: number;
    score: number;
    grossGain: number;
    netGain: number;
    lineups: any[];
    gwBreakdown: any[];
  }> = [];

  let legalCount = 0;
  const tSearch = Date.now();
  for (const outP of squadElements) {
    const cands = activePlayers.filter(
      (p: any) => p.element_type === outP.element_type && !ownedIds.has(p.id)
    );
    for (const inP of cands) {
      const bankCheck = calculatePostTransferBank(bank, [outP], [inP]);
      if (!bankCheck.isAffordable) continue;

      const resultingSquad = squadElements
        .filter((p) => p.id !== outP.id)
        .concat([
          {
            id: inP.id,
            web_name: inP.web_name,
            element_type: inP.element_type,
            team: inP.team,
            team_short_name: bootstrap.teams.find((t: any) => t.id === inP.team)?.short_name || "",
            now_cost: inP.now_cost,
            selling_price: inP.now_cost,
            purchase_price: inP.now_cost,
            status: inP.status,
            news: inP.news,
            chance_of_playing_next_round: inP.chance_of_playing_next_round,
          },
        ]);
      const clubCheck = isClubConstraintValid(resultingSquad);
      if (!clubCheck.isValid) continue;

      legalCount++;
      const res = scoreSquad(resultingSquad);
      const grossGain = roundTo(res.totalDiscounted - holdScore.totalDiscounted, 2);
      const netGain = grossGain; // 1 FT used => 0 hit
      plans.push({
        out: outP,
        in: inP,
        bankAfter: bankCheck.bankAfterTenths,
        score: res.totalDiscounted,
        grossGain,
        netGain,
        lineups: res.lineups,
        gwBreakdown: res.gwBreakdown,
      });
    }
  }
  console.log(
    `Evaluated all ${legalCount} legal 1-transfers in ${Date.now() - tSearch} ms`
  );

  plans.sort((a, b) => b.netGain - a.netGain || b.grossGain - a.grossGain || b.bankAfter - a.bankAfter);

  console.log("\nTop 15 1-transfer plans from exhaustive search:");
  plans.slice(0, 15).forEach((p, idx) => {
    console.log(
      `${idx + 1}. OUT: ${p.out.web_name} (£${(p.out.now_cost/10).toFixed(1)}m), IN: ${p.in.web_name} (£${(p.in.now_cost/10).toFixed(1)}m) | Bank: £${(p.bankAfter/10).toFixed(1)}m | Gross: ${p.grossGain > 0 ? "+" : ""}${p.grossGain.toFixed(2)} | Net: ${p.netGain > 0 ? "+" : ""}${p.netGain.toFixed(2)}`
    );
  });
}

main().catch(console.error);
