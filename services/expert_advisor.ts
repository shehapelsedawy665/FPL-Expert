/**
 * Phase 9 — Expert Hub, Top Targets & Differential Radar Engine
 * Contract Version: expert-advisor.v1
 *
 * Curates actionable recommendations by aggregating:
 * - Multi-gameweek projections (Phase 6B)
 * - Transfer price momentum (Phase 7)
 * - Live press conference availability intelligence (Phase 8)
 */

import {
  applyActiveGlobalOverrides,
  OverriddenPlayerFields,
} from "./availability_intelligence.js";
import {
  projectPlayerMultiGameweek,
  DEFAULT_PROJECTION_HORIZON,
} from "./multi_gw_projection.js";
import {
  predictPlayerPriceChange,
  PriceMomentumState,
  EstimatedPriceChangeDirection,
} from "./price_predictor.js";
import {
  fetchBootstrapData,
  fetchFixtures,
} from "./fpl_service.js";
import { PredictionSnapshot } from "./prediction_contract.js";

export const EXPERT_ADVISOR_VERSION = "expert-advisor.v1";

// ============================================================================
// Types & Contracts
// ============================================================================

export interface ExpertTargetPick {
  player_id: number;
  web_name: string;
  team_id: number;
  team_short_name: string;
  element_type: number;
  position: string;
  now_cost: number;
  cost_in_millions: number;
  selected_by_percent: number;
  projected_xpts: number;
  avg_xpts_per_gw: number;
  availability_status: string;
  availability_probability: number;
  price_momentum: PriceMomentumState;
  estimated_change_direction: EstimatedPriceChangeDirection;
  is_price_rising: boolean;
  price_change_probability: number;
  net_event_transfers: number;
  recommendation_reason: string;
}

export interface DifferentialPick {
  player_id: number;
  web_name: string;
  team_id: number;
  team_short_name: string;
  element_type: number;
  position: string;
  now_cost: number;
  cost_in_millions: number;
  selected_by_percent: number;
  projected_xpts: number;
  avg_xpts_per_gw: number;
  differential_score: number;
  value_ratio: number;
  upside_summary: string;
}

export interface ValuePick {
  player_id: number;
  web_name: string;
  team_id: number;
  team_short_name: string;
  element_type: number;
  position: string;
  now_cost: number;
  cost_in_millions: number;
  selected_by_percent: number;
  projected_xpts: number;
  avg_xpts_per_gw: number;
  value_ratio: number;
  analysis: string;
}

export interface CaptainCandidate {
  rank: number;
  player_id: number;
  web_name: string;
  team_short_name: string;
  position: string;
  cost_in_millions: number;
  base_xpts: number;
  probability_appearance: number;
  fixture_difficulty: number;
  opponent_short_name: string;
  is_home: boolean;
  clean_sheet_potential: number;
  scoring_potential: number;
  captaincy_score: number;
  rationale: string;
}

export interface CaptainMatrix {
  target_gameweek: number;
  candidates: CaptainCandidate[];
  verdict: string;
}

export interface ExpertRecommendationsResult {
  version: typeof EXPERT_ADVISOR_VERSION;
  generated_at: string;
  filters: {
    element_type: number | null;
    max_cost: number | null;
    horizon: number;
  };
  top_targets: ExpertTargetPick[];
  differentials: DifferentialPick[];
  value_picks: ValuePick[];
  captain_matrix: CaptainMatrix;
}

export interface GetExpertOptions {
  bootstrap?: any;
  allFixtures?: any[];
  playerHistories?: Record<number, any[]>;
  snapshot?: PredictionSnapshot;
  elementType?: number | null;
  maxCost?: number | null; // e.g. 8.5 for £8.5m or 85
  horizon?: number;
  totalManagers?: number;
}

// ============================================================================
// Helpers
// ============================================================================

export function getPositionShortName(elementType: number): string {
  switch (elementType) {
    case 1:
      return "GKP";
    case 2:
      return "DEF";
    case 3:
      return "MID";
    case 4:
      return "FWD";
    default:
      return "MID";
  }
}

export function roundTo(val: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Check if a player is ruled out, injured, suspended, or flagged by live press conference overrides.
 */
export function isPlayerRuledOut(player: any): boolean {
  if (
    player.adjusted_availability_prob !== undefined &&
    player.adjusted_availability_prob === 0.0
  ) {
    return true;
  }
  if (player.injury_status === "RULED_OUT") {
    return true;
  }
  const status = String(player.status || "").toLowerCase();
  if (status === "i" || status === "s" || status === "u") {
    return true;
  }
  if (
    player.chance_of_playing_next_round !== null &&
    player.chance_of_playing_next_round !== undefined &&
    Number(player.chance_of_playing_next_round) === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Normalize cost limit to £m decimal (e.g. 85 -> 8.5, 8.5 -> 8.5).
 */
export function normalizeCostToMillions(cost: number): number {
  return cost > 20 ? cost / 10.0 : cost;
}

// ============================================================================
// Internal Player Evaluator
// ============================================================================

export interface EnrichedPlayerEvaluation {
  rawPlayer: any & OverriddenPlayerFields;
  costInM: number;
  ownershipPercent: number;
  availabilityProb: number;
  projectedXpts: number;
  avgXptsPerGw: number;
  gw1Xpts: number;
  gw1Fixture?: any;
  gw1PApp: number;
  gw1Minutes: number;
  scoringPotential: number;
  cleanSheetPotential: number;
  pricePrediction: any;
}

export function evaluatePlayersForExpert(
  players: any[],
  fixtures: any[],
  teams: any[],
  snapshot: PredictionSnapshot,
  horizon: number,
  playerHistories?: Record<number, any[]>,
  totalManagers = 10_000_000
): EnrichedPlayerEvaluation[] {
  // Step 1: Inject live availability intelligence overrides
  const overriddenPlayers = applyActiveGlobalOverrides(players);

  const teamMap = new Map<number, any>();
  for (const t of teams) {
    teamMap.set(t.id, t);
  }

  const evaluations: EnrichedPlayerEvaluation[] = [];

  for (const p of overriddenPlayers) {
    const costInM = roundTo(Number(p.now_cost ?? 50) / 10.0, 1);
    const ownershipPercent = roundTo(parseFloat(String(p.selected_by_percent || "0")), 1);
    const availProb =
      p.adjusted_availability_prob !== undefined
        ? Number(p.adjusted_availability_prob)
        : p.chance_of_playing_next_round !== null && p.chance_of_playing_next_round !== undefined
        ? Number(p.chance_of_playing_next_round) / 100.0
        : 1.0;

    const history = playerHistories?.[p.id] || null;

    // Run multi-gameweek projection
    const multiGw = projectPlayerMultiGameweek({
      player: p,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history,
      horizon,
    });

    const gw1 = multiGw.gameweeks[0];
    const gw1Fixture = gw1?.fixtures[0];
    const projectedXpts = multiGw.cumulative_expected_points ?? multiGw.cumulative_raw_xPts ?? 0.0;
    const avgXpts = roundTo(projectedXpts / Math.max(1, horizon), 2);

    // Estimate clean sheet / scoring breakdown
    const isAttacker = p.element_type === 3 || p.element_type === 4;
    const isDefenderOrGk = p.element_type === 1 || p.element_type === 2;

    const gw1Breakdown = gw1Fixture?.breakdown;
    const cleanSheetPotential = gw1Breakdown
      ? roundTo(gw1Breakdown.clean_sheet_points, 2)
      : isDefenderOrGk
      ? roundTo(gw1?.expected_points * 0.35, 2)
      : 0.0;

    const scoringPotential = gw1Breakdown
      ? roundTo((gw1Breakdown.goals_points || 0) + (gw1Breakdown.assists_points || 0), 2)
      : isAttacker
      ? roundTo(gw1?.expected_points * 0.65, 2)
      : roundTo(gw1?.expected_points * 0.15, 2);

    // Predict price change
    const pricePrediction = predictPlayerPriceChange(p, totalManagers);

    evaluations.push({
      rawPlayer: p,
      costInM,
      ownershipPercent,
      availabilityProb: availProb,
      projectedXpts: roundTo(projectedXpts, 2),
      avgXptsPerGw: avgXpts,
      gw1Xpts: roundTo(gw1?.expected_points || 0.0, 2),
      gw1Fixture,
      gw1PApp: roundTo(gw1?.probability_appearance ?? availProb, 2),
      gw1Minutes: roundTo(gw1?.expected_minutes || 0.0, 1),
      scoringPotential,
      cleanSheetPotential,
      pricePrediction,
    });
  }

  return evaluations;
}

// ============================================================================
// Module 1: Top Transfer Targets
// ============================================================================

export function getTopTransferTargets(
  evaluations: EnrichedPlayerEvaluation[],
  limit = 10,
  filters?: { elementType?: number | null; maxCost?: number | null }
): ExpertTargetPick[] {
  const maxCostM = filters?.maxCost ? normalizeCostToMillions(filters.maxCost) : null;

  const candidates = evaluations.filter((ev) => {
    // Strictly exclude ruled-out players
    if (isPlayerRuledOut(ev.rawPlayer)) return false;

    // Secure status: prob >= 0.75
    if (ev.availabilityProb < 0.75) return false;

    // Filter by position
    if (filters?.elementType && ev.rawPlayer.element_type !== filters.elementType) {
      return false;
    }

    // Filter by max budget
    if (maxCostM !== null && ev.costInM > maxCostM) {
      return false;
    }

    // Filter out zero-projection benchwarmers
    if (ev.projectedXpts <= 0) return false;

    return true;
  });

  // Sort by projected points with price momentum bonus
  candidates.sort((a, b) => {
    // Momentum bonus: players rising get slight priority for transfer targets
    const aRiseBonus =
      a.pricePrediction.estimated_change_direction === "RISE"
        ? 1.5
        : a.pricePrediction.net_event_transfers > 0
        ? 0.5
        : 0.0;
    const bRiseBonus =
      b.pricePrediction.estimated_change_direction === "RISE"
        ? 1.5
        : b.pricePrediction.net_event_transfers > 0
        ? 0.5
        : 0.0;

    const scoreA = a.projectedXpts + aRiseBonus;
    const scoreB = b.projectedXpts + bRiseBonus;

    if (Math.abs(scoreB - scoreA) > 0.01) {
      return scoreB - scoreA;
    }
    return b.projectedXpts - a.projectedXpts;
  });

  return candidates.slice(0, limit).map((ev) => {
    const isRising = ev.pricePrediction.estimated_change_direction === "RISE";
    let reason = `${ev.projectedXpts.toFixed(1)} projected xPts with secure starting minutes.`;
    if (isRising) {
      reason += ` Strong transfer momentum (${ev.pricePrediction.momentum_state.replace(/_/g, " ")}).`;
    } else if (ev.pricePrediction.net_event_transfers > 0) {
      reason += ` Positive market backing (+${ev.pricePrediction.net_event_transfers.toLocaleString()} net transfers).`;
    }

    return {
      player_id: ev.rawPlayer.id,
      web_name: ev.rawPlayer.web_name,
      team_id: ev.rawPlayer.team,
      team_short_name: ev.rawPlayer.team_short_name || `Team ${ev.rawPlayer.team}`,
      element_type: ev.rawPlayer.element_type,
      position: getPositionShortName(ev.rawPlayer.element_type),
      now_cost: ev.rawPlayer.now_cost,
      cost_in_millions: ev.costInM,
      selected_by_percent: ev.ownershipPercent,
      projected_xpts: ev.projectedXpts,
      avg_xpts_per_gw: ev.avgXptsPerGw,
      availability_status: ev.rawPlayer.injury_status || "AVAILABLE",
      availability_probability: ev.availabilityProb,
      price_momentum: ev.pricePrediction.momentum_state,
      estimated_change_direction: ev.pricePrediction.estimated_change_direction,
      is_price_rising: isRising,
      price_change_probability: ev.pricePrediction.price_change_probability,
      net_event_transfers: ev.pricePrediction.net_event_transfers,
      recommendation_reason: reason,
    };
  });
}

// ============================================================================
// Module 2: Differential Radar
// ============================================================================

export function getDifferentialRadar(
  evaluations: EnrichedPlayerEvaluation[],
  maxOwnership = 10.0,
  limit = 8,
  filters?: { elementType?: number | null; maxCost?: number | null }
): DifferentialPick[] {
  const maxCostM = filters?.maxCost ? normalizeCostToMillions(filters.maxCost) : null;

  const candidates = evaluations.filter((ev) => {
    // Strictly exclude ruled-out players
    if (isPlayerRuledOut(ev.rawPlayer)) return false;

    // Strictly enforce ownership cap
    if (ev.ownershipPercent > maxOwnership) return false;

    // Minimum baseline playability (prob >= 0.60, projected xpts > 0)
    if (ev.availabilityProb < 0.6) return false;
    if (ev.projectedXpts <= 0) return false;

    // Position filter
    if (filters?.elementType && ev.rawPlayer.element_type !== filters.elementType) {
      return false;
    }

    // Budget filter
    if (maxCostM !== null && ev.costInM > maxCostM) {
      return false;
    }

    return true;
  });

  // Calculate differential score: high projected points with lower ownership bonus
  const scored = candidates.map((ev) => {
    const valueRatio = roundTo(ev.projectedXpts / Math.max(ev.costInM, 3.8), 2);
    // Differential score balances raw expected points with rank gain potential
    const diffScore = roundTo(
      ev.projectedXpts * (1.0 + (maxOwnership - ev.ownershipPercent) / (maxOwnership * 2)),
      2
    );

    return {
      ev,
      diffScore,
      valueRatio,
    };
  });

  scored.sort((a, b) => b.diffScore - a.diffScore);

  return scored.slice(0, limit).map(({ ev, diffScore, valueRatio }) => {
    const upside = `Only ${ev.ownershipPercent}% owned with ${ev.projectedXpts.toFixed(1)} xPts projected (${valueRatio.toFixed(2)} pts/£m). High rank climb leverage.`;

    return {
      player_id: ev.rawPlayer.id,
      web_name: ev.rawPlayer.web_name,
      team_id: ev.rawPlayer.team,
      team_short_name: ev.rawPlayer.team_short_name || `Team ${ev.rawPlayer.team}`,
      element_type: ev.rawPlayer.element_type,
      position: getPositionShortName(ev.rawPlayer.element_type),
      now_cost: ev.rawPlayer.now_cost,
      cost_in_millions: ev.costInM,
      selected_by_percent: ev.ownershipPercent,
      projected_xpts: ev.projectedXpts,
      avg_xpts_per_gw: ev.avgXptsPerGw,
      differential_score: diffScore,
      value_ratio: valueRatio,
      upside_summary: upside,
    };
  });
}

// ============================================================================
// Module 3: Value Picks
// ============================================================================

export function getValuePicks(
  evaluations: EnrichedPlayerEvaluation[],
  limit = 8,
  filters?: { elementType?: number | null; maxCost?: number | null }
): ValuePick[] {
  const maxCostM = filters?.maxCost ? normalizeCostToMillions(filters.maxCost) : null;

  const candidates = evaluations.filter((ev) => {
    // Strictly exclude ruled-out players
    if (isPlayerRuledOut(ev.rawPlayer)) return false;

    // Must have playing security (prob >= 0.70) and positive minutes
    if (ev.availabilityProb < 0.7) return false;
    if (ev.projectedXpts < 5.0) return false;

    // Position filter
    if (filters?.elementType && ev.rawPlayer.element_type !== filters.elementType) {
      return false;
    }

    // Budget filter
    if (maxCostM !== null && ev.costInM > maxCostM) {
      return false;
    }

    return true;
  });

  const scored = candidates.map((ev) => {
    const valueRatio = roundTo(ev.projectedXpts / Math.max(ev.costInM, 3.8), 2);
    return { ev, valueRatio };
  });

  // Sort descending by value ratio
  scored.sort((a, b) => b.valueRatio - a.valueRatio);

  return scored.slice(0, limit).map(({ ev, valueRatio }) => {
    const analysis = `Top value efficiency at ${valueRatio.toFixed(2)} xPts/£m with ${ev.projectedXpts.toFixed(1)} xPts at £${ev.costInM.toFixed(1)}m.`;

    return {
      player_id: ev.rawPlayer.id,
      web_name: ev.rawPlayer.web_name,
      team_id: ev.rawPlayer.team,
      team_short_name: ev.rawPlayer.team_short_name || `Team ${ev.rawPlayer.team}`,
      element_type: ev.rawPlayer.element_type,
      position: getPositionShortName(ev.rawPlayer.element_type),
      now_cost: ev.rawPlayer.now_cost,
      cost_in_millions: ev.costInM,
      selected_by_percent: ev.ownershipPercent,
      projected_xpts: ev.projectedXpts,
      avg_xpts_per_gw: ev.avgXptsPerGw,
      value_ratio: valueRatio,
      analysis,
    };
  });
}

// ============================================================================
// Module 4: Captaincy Comparison
// ============================================================================

export function getCaptaincyComparison(
  evaluations: EnrichedPlayerEvaluation[],
  targetGw?: number
): CaptainMatrix {
  // Filter for valid captaincy candidates
  const eligible = evaluations.filter((ev) => {
    // Strictly exclude ruled-out players
    if (isPlayerRuledOut(ev.rawPlayer)) return false;

    // Must have upcoming fixture and positive appearance probability
    if (!ev.gw1Fixture || ev.gw1PApp <= 0.2) return false;

    // Must have reasonable baseline points
    return ev.gw1Xpts > 1.0;
  });

  // Score captain utility: base_xpts * (1 + appearance_prob)
  const scored = eligible.map((ev) => {
    const capScore = roundTo(ev.gw1Xpts * 2 * ev.gw1PApp, 2);
    return { ev, capScore };
  });

  scored.sort((a, b) => {
    if (Math.abs(b.capScore - a.capScore) > 0.01) {
      return b.capScore - a.capScore;
    }
    return b.ev.gw1Xpts - a.ev.gw1Xpts;
  });

  const top3 = scored.slice(0, 3);
  const candidates: CaptainCandidate[] = top3.map(({ ev, capScore }, idx) => {
    const opp = ev.gw1Fixture?.opponent_short_name || "OPP";
    const diff = ev.gw1Fixture?.difficulty || 3;
    const homeStr = ev.gw1Fixture?.is_home ? "H" : "A";

    let rationale = `${ev.gw1Xpts.toFixed(1)} base xPts vs ${opp} (${homeStr}, FDR ${diff}).`;
    if (ev.scoringPotential > 0) {
      rationale += ` High attacking threat (${ev.scoringPotential.toFixed(1)} xG+A pts).`;
    }

    return {
      rank: idx + 1,
      player_id: ev.rawPlayer.id,
      web_name: ev.rawPlayer.web_name,
      team_short_name: ev.rawPlayer.team_short_name || `Team ${ev.rawPlayer.team}`,
      position: getPositionShortName(ev.rawPlayer.element_type),
      cost_in_millions: ev.costInM,
      base_xpts: ev.gw1Xpts,
      probability_appearance: ev.gw1PApp,
      fixture_difficulty: diff,
      opponent_short_name: opp,
      is_home: ev.gw1Fixture?.is_home ?? true,
      clean_sheet_potential: ev.cleanSheetPotential,
      scoring_potential: ev.scoringPotential,
      captaincy_score: capScore,
      rationale,
    };
  });

  const nextGw = targetGw || top3[0]?.ev.gw1Fixture?.gameweek || 1;
  let verdict = "No eligible captain choices identified.";
  if (candidates.length > 0) {
    const topPick = candidates[0];
    const secondPick = candidates[1];
    verdict = `${topPick.web_name} is the clear prime captain selection for GW${nextGw} (${topPick.base_xpts.toFixed(1)} base xPts, ${topPick.captaincy_score.toFixed(1)} captain score).`;
    if (secondPick) {
      verdict += ` ${secondPick.web_name} represents the primary alternative pick (${secondPick.base_xpts.toFixed(1)} base xPts).`;
    }
  }

  return {
    target_gameweek: nextGw,
    candidates,
    verdict,
  };
}

// ============================================================================
// Master Recommendation Aggregator
// ============================================================================

export async function getExpertRecommendations(
  options: GetExpertOptions = {}
): Promise<ExpertRecommendationsResult> {
  const {
    elementType = null,
    maxCost = null,
    horizon = DEFAULT_PROJECTION_HORIZON,
    totalManagers = 10_000_000,
  } = options;

  let bootstrap = options.bootstrap;
  let allFixtures = options.allFixtures;

  if (!bootstrap || !allFixtures) {
    const [fetchedBoot, fetchedFixt] = await Promise.all([
      bootstrap ? Promise.resolve(bootstrap) : fetchBootstrapData(),
      allFixtures ? Promise.resolve(allFixtures) : fetchFixtures(),
    ]);
    bootstrap = fetchedBoot;
    allFixtures = fetchedFixt;
  }

  const rawPlayers =
    bootstrap.players && bootstrap.players.length > 0
      ? bootstrap.players
      : (bootstrap as any).elements || [];

  const teams = bootstrap.teams || [];
  const snapshot =
    options.snapshot ||
    bootstrap.snapshot ||
    new PredictionSnapshot({
      historical_cutoff_gameweek: null,
      prediction_gameweek: bootstrap.gameweek_boundary?.next_gameweek || 1,
    });

  // Evaluate all players with overrides and multi-gameweek models
  const evaluations = evaluatePlayersForExpert(
    rawPlayers,
    allFixtures,
    teams,
    snapshot,
    horizon,
    options.playerHistories,
    totalManagers
  );

  const filterOpts = { elementType, maxCost };

  const topTargets = getTopTransferTargets(evaluations, 10, filterOpts);
  const differentials = getDifferentialRadar(evaluations, 10.0, 8, filterOpts);
  const valuePicks = getValuePicks(evaluations, 8, filterOpts);
  const captainMatrix = getCaptaincyComparison(evaluations);

  return {
    version: EXPERT_ADVISOR_VERSION,
    generated_at: new Date().toISOString(),
    filters: {
      element_type: elementType ?? null,
      max_cost: maxCost ? normalizeCostToMillions(maxCost) : null,
      horizon,
    },
    top_targets: topTargets,
    differentials: differentials,
    value_picks: valuePicks,
    captain_matrix: captainMatrix,
  };
}
