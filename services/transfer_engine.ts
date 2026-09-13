import {
  DataValidity,
  PredictionSnapshot,
  GameweekBoundary,
  determineGameweekBoundary,
} from "./prediction_contract.js";
import {
  DecisionSquadPlayer,
  DecisionEngineResult,
  runFplDecisionEngine,
  optimizeStartingXi,
  evaluateCaptaincyPairs,
  roundTo,
  POSITION_NAMES,
  LEGAL_FORMATIONS,
  EPSILON,
} from "./decision_engine.js";
import {
  MultiGwGameweekProjection,
  PlayerMultiGwProjection,
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  MULTI_GW_PROJECTION_VERSION,
  DEFAULT_PROJECTION_HORIZON,
  DEFAULT_DISCOUNT_FACTORS,
} from "./multi_gw_projection.js";
import {
  assessTransferUrgency,
  UrgencyAssessment,
} from "./price_predictor.js";
import { applyActiveGlobalOverrides } from "./availability_intelligence.js";

// ============================================================================
// 1. VERSIONED RULES & CONTRACTS
// ============================================================================

export const TRANSFER_ENGINE_VERSION = "transfer-engine.v1";
export const FPL_TRANSFER_RULES_VERSION = "fpl-transfer-rules.2026-27.v1";

export const FPL_RULES = {
  version: FPL_TRANSFER_RULES_VERSION,
  free_transfers_per_gameweek: 1,
  max_banked_free_transfers: 5,
  extra_transfer_hit_cost_points: 4,
  squad_size: 15,
  position_counts: {
    1: 2, // 2 GKP
    2: 5, // 5 DEF
    3: 5, // 5 MID
    4: 3, // 3 FWD
  } as Record<number, number>,
  max_players_per_club: 3,
  min_transfer_gain_threshold: 0.0,
};

export type FtUsageStatus = "USE" | "ROLL" | "INDIFFERENT";

// ============================================================================
// 2. DATA STRUCTURES & INTERFACES
// ============================================================================

export interface OwnedPlayerFinancialState {
  id: number;
  web_name: string;
  element_type: number; // 1=GKP, 2=DEF, 3=MID, 4=FWD
  team: number;
  now_cost: number; // Integer tenths (e.g. 75 = £7.5m)
  selling_price: number; // Integer tenths
  purchase_price?: number; // Integer tenths
  status?: string;
  news?: string;
  chance_of_playing_next_round?: number | null;
}

export interface CandidateIncomingPlayer {
  id: number;
  web_name: string;
  element_type: number;
  team: number;
  team_short_name?: string;
  now_cost: number; // Integer tenths
  status?: string;
  news?: string;
  chance_of_playing_next_round?: number | null;
}

export interface TeamFinancialState {
  team_id: number;
  snapshot_id: string;
  bank: number; // Integer tenths (e.g. 15 = £1.5m)
  available_free_transfers: number; // 0 to 5
  owned_players: OwnedPlayerFinancialState[];
  as_of_gameweek?: number;
  is_historical?: boolean;
  is_historical_verified?: boolean;
}

export interface GwLineupDecision {
  gameweek: number;
  gw_offset: number;
  starting_xi_ids: number[];
  starting_xi_names: string[];
  formation_label: string;
  captain_id: number;
  captain_name: string;
  vice_captain_id: number;
  vice_captain_name: string;
  captaincy_bonus: number;
  starting_xi_xpts: number;
  total_team_xpts: number; // starting_xi_xpts + captaincy_bonus
  bench_gk_id: number | null;
  ordered_outfield_bench_ids: number[];
}

export interface TransferPlanEvaluation {
  plan_id: string; // Canonical key e.g. "HOLD" or "OUT:1;IN:2"
  transfers_out: OwnedPlayerFinancialState[];
  transfers_in: CandidateIncomingPlayer[];
  transfer_count: number;
  free_transfers_used: number;
  paid_transfers: number;
  hit_cost: number; // paid_transfers * 4
  bank_after: number; // Integer tenths
  resulting_squad_ids: number[];
  
  // Scoring
  gross_projected_gain: number;
  net_projected_gain: number;
  team_horizon_expected_points: number; // Sum over discounted GW scores
  hold_baseline_expected_points: number;
  
  // Detailed GW Decomposition
  gw_breakdown: Array<{
    gameweek: number;
    gw_offset: number;
    discount_factor: number;
    team_points: number;
    discounted_team_points: number;
    hold_team_points: number;
    discounted_hold_team_points: number;
    gross_gain: number;
    discounted_gain: number;
  }>;

  // GW Lineups
  lineups_by_gw: GwLineupDecision[];

  // Qualitative Impact & Explainability
  starting_xi_impact: {
    incoming_starts_count: number;
    starting_in_first_gw: boolean;
    replaced_starter_names: string[];
    formation_before_gw1: string;
    formation_after_gw1: string;
  };
  
  captaincy_impact: {
    gw1_captain_changed: boolean;
    old_captain_name: string;
    new_captain_name: string;
    old_captain_bonus: number;
    new_captain_bonus: number;
    captain_bonus_delta: number;
  };

  bench_impact: {
    bench_changed: boolean;
    bench_gk_before: string;
    bench_gk_after: string;
    outfield_bench_before: string[];
    outfield_bench_after: string[];
  };

  ft_usage_status: FtUsageStatus;
  is_legal: boolean;
  legality_notes?: string[];
  urgency_assessment?: UrgencyAssessment;
}

export interface HorizonSensitivityItem {
  horizon: number;
  discount_factor: number;
  recommended_plan_id: string;
  recommended_transfers_label: string;
  gross_gain: number;
  hit_cost: number;
  net_gain: number;
  rank_1_plan: TransferPlanEvaluation;
}

export interface TransferEngineResult {
  version: string;
  rules_version: string;
  snapshot_id: string;
  prediction_gameweek: number;
  historical_cutoff_gameweek: number | null;
  team_id: number;
  
  // Financial State
  bank: number; // Integer tenths
  available_free_transfers: number;
  squad_selling_value: number; // Integer tenths
  total_team_value: number; // Integer tenths
  financial_state_validity: "VALID" | "INSUFFICIENT_HISTORICAL_FINANCIAL_STATE";
  validation_message?: string;

  // Parameters
  horizon: number;
  discount_factor: number;
  max_transfers: number;
  min_transfer_gain_threshold: number;

  // Search Scope & Optimality Classifications
  search_scope: {
    one_transfer: "EXHAUSTIVE";
    two_transfer: "HEURISTIC";
  };
  global_optimality: "NOT_PROVEN" | "PROVEN";

  // Search Audit
  audit: {
    search_status_1_transfer: "EXHAUSTIVE";
    search_status_2_transfer: "HEURISTIC";
    one_transfer_optimality: "GLOBAL_OPTIMUM";
    two_transfer_optimality: "NOT_PROVEN";
    future_transfer_reoptimization: "NOT_YET_MODELED";
    chips_implemented: "NONE";
    active_player_pool_size: number;
    projection_valid_pool_size: number;
    candidate_pool_by_position: {
      GKP: number;
      DEF: number;
      MID: number;
      FWD: number;
    };
    candidate_incoming_pool_size: number;
    legal_1_transfer_count: number;
    legal_2_transfer_count: number;
    safe_pruned_2_transfer_count?: number;
    heuristic_pruned_2_transfer_count?: number;
    evaluated_plans_count: number;
    runtime_ms: number;
  };

  // Recommendations
  recommendation: "HOLD" | "TRANSFER";
  recommendation_action: "HOLD" | "TRANSFER";
  recommendation_basis: string;
  ft_usage_status: FtUsageStatus;
  ft_roll_explanation?: string;
  recommended_plan: TransferPlanEvaluation;
  hold_plan: TransferPlanEvaluation;
  urgency_assessment?: UrgencyAssessment;

  // Margin vs Best Alternative
  margin_vs_best_alternative?: {
    best_1_transfer_net_gain: number;
    best_2_transfer_net_gain: number;
    best_alternative_net_gain: number;
    margin_xpts: number;
    hold_points_advantage_over_best_1_transfer: number;
    decision_tiebreak: "fewer_transfers" | "expected_points" | "none";
    explanation: string;
  };

  // Ranked Alternatives
  top_1_transfer_plans: TransferPlanEvaluation[];
  top_2_transfer_plans: TransferPlanEvaluation[];
  all_ranked_plans: TransferPlanEvaluation[];

  // Horizon & Sensitivity Analysis
  horizon_sensitivity: HorizonSensitivityItem[];
}

// ============================================================================
// 3. FINANCIAL & SQUAD LEGALITY UTILITIES
// ============================================================================

/**
 * Verify financial feasibility:
 * new_bank = current_bank + sum(outgoing selling prices) - sum(incoming purchase prices) >= 0
 */
export function calculatePostTransferBank(
  currentBankTenths: number,
  transfersOut: OwnedPlayerFinancialState[],
  transfersIn: CandidateIncomingPlayer[]
): {
  bankAfterTenths: number;
  isAffordable: boolean;
} {
  const sellTotal = transfersOut.reduce((sum, p) => sum + p.selling_price, 0);
  const buyTotal = transfersIn.reduce((sum, p) => sum + p.now_cost, 0);
  const bankAfter = currentBankTenths + sellTotal - buyTotal;
  return {
    bankAfterTenths: bankAfter,
    isAffordable: bankAfter >= 0,
  };
}

/**
 * Verify squad positional counts: exactly 2 GKP, 5 DEF, 5 MID, 3 FWD
 */
export function isSquadPositionalBalanceValid(players: Array<{ element_type: number }>): boolean {
  if (players.length !== 15) return false;
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of players) {
    counts[p.element_type] = (counts[p.element_type] || 0) + 1;
  }
  return (
    counts[1] === FPL_RULES.position_counts[1] &&
    counts[2] === FPL_RULES.position_counts[2] &&
    counts[3] === FPL_RULES.position_counts[3] &&
    counts[4] === FPL_RULES.position_counts[4]
  );
}

/**
 * Verify club limit: maximum 3 players per Premier League club in the resulting 15-player squad
 */
export function isClubConstraintValid(players: Array<{ team: number }>): {
  isValid: boolean;
  violatingClubs: number[];
} {
  const clubCounts: Record<number, number> = {};
  const violatingClubs: number[] = [];

  for (const p of players) {
    clubCounts[p.team] = (clubCounts[p.team] || 0) + 1;
    if (clubCounts[p.team] > FPL_RULES.max_players_per_club && !violatingClubs.includes(p.team)) {
      violatingClubs.push(p.team);
    }
  }

  return {
    isValid: violatingClubs.length === 0,
    violatingClubs,
  };
}

/**
 * Calculate transfer hit points cost:
 * paid_transfers = max(0, transfer_count - available_free_transfers)
 * hit_cost = paid_transfers * 4
 */
export function calculateHitCost(
  transferCount: number,
  availableFreeTransfers: number
): {
  freeTransfersUsed: number;
  paidTransfers: number;
  hitCost: number;
} {
  const freeUsed = Math.min(transferCount, Math.max(0, availableFreeTransfers));
  const paid = Math.max(0, transferCount - freeUsed);
  const hitCost = paid * FPL_RULES.extra_transfer_hit_cost_points;
  return {
    freeTransfersUsed: freeUsed,
    paidTransfers: paid,
    hitCost,
  };
}

/**
 * Deterministic canonical plan ID generator to avoid duplicate permutations.
 */
export function generateCanonicalPlanId(
  transfersOut: Array<{ id: number }>,
  transfersIn: Array<{ id: number }>
): string {
  if (transfersOut.length === 0 && transfersIn.length === 0) {
    return "HOLD";
  }
  const outSorted = [...transfersOut].map((p) => p.id).sort((a, b) => a - b).join(",");
  const inSorted = [...transfersIn].map((p) => p.id).sort((a, b) => a - b).join(",");
  return `OUT:${outSorted};IN:${inSorted}`;
}

// ============================================================================
// 4. MULTI-GW SQUAD EVALUATOR & LINEUP OPTIMIZER
// ============================================================================

/**
 * Build a DecisionSquadPlayer for a specific Gameweek offset using precomputed Multi-GW projections.
 */
export function buildDecisionPlayerForGw(
  player: {
    id: number;
    web_name: string;
    element_type: number;
    team: number;
    team_short_name?: string;
    status?: string;
    news?: string;
    chance_of_playing_next_round?: number | null;
  },
  gwProj: MultiGwGameweekProjection
): DecisionSquadPlayer {
  return {
    id: player.id,
    web_name: player.web_name,
    element_type: player.element_type,
    position_short_name: POSITION_NAMES[player.element_type] || "UNK",
    team_id: player.team,
    team_short_name: player.team_short_name || "",
    status: player.status,
    news: player.news,
    chance_of_playing_next_round: player.chance_of_playing_next_round,
    fixture_count: gwProj.fixture_count,
    expected_minutes: gwProj.expected_minutes,
    probability_available: gwProj.probability_appearance > 0 ? 1.0 : 0.0,
    probability_appearance: gwProj.probability_appearance,
    probability_start: gwProj.probability_start,
    probability_60_plus_minutes: gwProj.probability_60_plus_minutes,
    raw_expected_points: gwProj.raw_expected_points,
    calibrated_expected_points: gwProj.calibrated_expected_points,
    calibration_status: gwProj.calibration_status,
    decision_expected_points: gwProj.expected_points,
  };
}

/**
 * Evaluate a 15-player squad across a Multi-GW horizon using the approved Phase 6A decision engine.
 * Returns the discounted team expectation and per-GW optimal lineups.
 */
export function evaluateSquadHorizonValue(options: {
  squad: Array<{
    id: number;
    web_name: string;
    element_type: number;
    team: number;
    team_short_name?: string;
    status?: string;
    news?: string;
    chance_of_playing_next_round?: number | null;
  }>;
  snapshot: PredictionSnapshot;
  precomputedProjections: Map<number, PlayerMultiGwProjection>;
  horizon: number;
  discountFactor: number;
}): {
  totalHorizonScore: number;
  lineupsByGw: GwLineupDecision[];
  gwBreakdown: Array<{
    gameweek: number;
    gw_offset: number;
    discount_factor: number;
    team_points: number;
    discounted_team_points: number;
  }>;
} {
  const { squad, snapshot, precomputedProjections, horizon, discountFactor } = options;

  let totalHorizonScore = 0.0;
  const lineupsByGw: GwLineupDecision[] = [];
  const gwBreakdown: Array<{
    gameweek: number;
    gw_offset: number;
    discount_factor: number;
    team_points: number;
    discounted_team_points: number;
  }> = [];

  for (let offset = 1; offset <= horizon; offset++) {
    // 1. Build 15 DecisionSquadPlayer objects for this gameweek offset
    const squadForGw: DecisionSquadPlayer[] = squad.map((p) => {
      const proj = precomputedProjections.get(p.id);
      if (!proj) {
        throw new Error(`Missing precomputed projection for player ID ${p.id} (${p.web_name})`);
      }
      const gwProj = proj.gameweeks.find((g) => g.gw_offset === offset);
      if (!gwProj) {
        throw new Error(
          `Missing projection for gameweek offset ${offset} for player ID ${p.id} (${p.web_name})`
        );
      }
      return buildDecisionPlayerForGw(p, gwProj);
    });

    // 2. Run optimized Starting XI & Captaincy optimization
    const { best_formation } = optimizeStartingXi(squadForGw);
    const starters = best_formation.starters;
    const { best_pair } = evaluateCaptaincyPairs(starters);

    const startingXiXpts = roundTo(best_formation.total_decision_expected_points, 2);
    const captaincyBonus = roundTo(best_pair.expected_captaincy_bonus, 3);
    const gwTeamTotal = roundTo(startingXiXpts + captaincyBonus, 3);

    // 3. Apply time discount
    const currentDiscount = roundTo(Math.pow(discountFactor, offset - 1), 6);
    const discountedGwTeam = roundTo(gwTeamTotal * currentDiscount, 4);

    totalHorizonScore += discountedGwTeam;

    const actualGw =
      (snapshot.boundary.prediction_gameweek ?? 1) + (offset - 1);

    const starterIds = new Set(starters.map((p) => p.id));
    const bench = squadForGw.filter((p) => !starterIds.has(p.id));
    const benchGk = bench.find((p) => p.element_type === 1) || null;
    const orderedOutfieldBench = bench
      .filter((p) => p.element_type !== 1)
      .sort((a, b) => b.decision_expected_points - a.decision_expected_points);

    lineupsByGw.push({
      gameweek: actualGw,
      gw_offset: offset,
      starting_xi_ids: starters.map((p) => p.id),
      starting_xi_names: starters.map((p) => p.web_name),
      formation_label: best_formation.formation_label,
      captain_id: best_pair.captain.id,
      captain_name: best_pair.captain.web_name,
      vice_captain_id: best_pair.vice_captain.id,
      vice_captain_name: best_pair.vice_captain.web_name,
      captaincy_bonus: captaincyBonus,
      starting_xi_xpts: startingXiXpts,
      total_team_xpts: gwTeamTotal,
      bench_gk_id: benchGk?.id ?? null,
      ordered_outfield_bench_ids: orderedOutfieldBench.map((p) => p.id),
    });

    gwBreakdown.push({
      gameweek: actualGw,
      gw_offset: offset,
      discount_factor: currentDiscount,
      team_points: gwTeamTotal,
      discounted_team_points: discountedGwTeam,
    });
  }

  return {
    totalHorizonScore: roundTo(totalHorizonScore, 2),
    lineupsByGw,
    gwBreakdown,
  };
}

// ============================================================================
// 5. TRANSFER PLAN EVALUATION ENGINE
// ============================================================================

/**
 * Compare two transfer plans deterministically:
 * 1. higher net_projected_gain
 * 2. lower hit_cost (fewer hit points)
 * 3. lower transfer_count (fewer transfers)
 * 4. higher bank_after (more money preserved)
 * 5. canonical plan_id string comparison
 */
export function compareTransferPlans(
  a: TransferPlanEvaluation,
  b: TransferPlanEvaluation
): number {
  const diffNet = b.net_projected_gain - a.net_projected_gain;
  if (Math.abs(diffNet) > EPSILON) {
    return diffNet > 0 ? 1 : -1;
  }

  const diffHit = a.hit_cost - b.hit_cost;
  if (diffHit !== 0) {
    return diffHit > 0 ? 1 : -1;
  }

  const diffCount = a.transfer_count - b.transfer_count;
  if (diffCount !== 0) {
    return diffCount > 0 ? 1 : -1;
  }

  const diffBank = b.bank_after - a.bank_after;
  if (diffBank !== 0) {
    return diffBank > 0 ? 1 : -1;
  }

  return a.plan_id.localeCompare(b.plan_id);
}

/**
 * Evaluate a single transfer plan against the HOLD baseline.
 */
export function evaluateTransferPlan(options: {
  transfersOut: OwnedPlayerFinancialState[];
  transfersIn: CandidateIncomingPlayer[];
  financialState: TeamFinancialState;
  snapshot: PredictionSnapshot;
  allPlayerMetaMap: Map<number, any>;
  precomputedProjections: Map<number, PlayerMultiGwProjection>;
  holdEvaluation: {
    totalHorizonScore: number;
    lineupsByGw: GwLineupDecision[];
    gwBreakdown: Array<{
      gameweek: number;
      gw_offset: number;
      discount_factor: number;
      team_points: number;
      discounted_team_points: number;
    }>;
  };
  horizon: number;
  discountFactor: number;
}): TransferPlanEvaluation {
  const {
    transfersOut,
    transfersIn,
    financialState,
    snapshot,
    allPlayerMetaMap,
    precomputedProjections,
    holdEvaluation,
    horizon,
    discountFactor,
  } = options;

  const planId = generateCanonicalPlanId(transfersOut, transfersIn);
  const transferCount = transfersOut.length;

  // 1. Calculate Financials
  const { bankAfterTenths, isAffordable } = calculatePostTransferBank(
    financialState.bank,
    transfersOut,
    transfersIn
  );

  const { freeTransfersUsed, paidTransfers, hitCost } = calculateHitCost(
    transferCount,
    financialState.available_free_transfers
  );

  // 2. Build Resulting Squad
  const outIds = new Set(transfersOut.map((p) => p.id));
  const retainedOwned = financialState.owned_players.filter((p) => !outIds.has(p.id));
  
  const resultingSquad = [
    ...retainedOwned.map((p) => {
      const meta = allPlayerMetaMap.get(p.id);
      return {
        id: p.id,
        web_name: p.web_name,
        element_type: p.element_type,
        team: meta?.team ?? p.team,
        team_short_name: meta?.team_short_name ?? "",
        status: meta?.status ?? p.status,
        news: meta?.news ?? p.news,
        chance_of_playing_next_round: meta?.chance_of_playing_next_round ?? p.chance_of_playing_next_round,
      };
    }),
    ...transfersIn.map((p) => {
      const meta = allPlayerMetaMap.get(p.id);
      return {
        id: p.id,
        web_name: p.web_name,
        element_type: p.element_type,
        team: meta?.team ?? p.team,
        team_short_name: meta?.team_short_name ?? p.team_short_name ?? "",
        status: meta?.status ?? p.status,
        news: meta?.news ?? p.news,
        chance_of_playing_next_round: meta?.chance_of_playing_next_round ?? p.chance_of_playing_next_round,
      };
    }),
  ];

  // 3. Verify Constraints
  const isPosValid = isSquadPositionalBalanceValid(resultingSquad);
  const clubCheck = isClubConstraintValid(resultingSquad);

  const isLegal = isAffordable && isPosValid && clubCheck.isValid;
  const legalityNotes: string[] = [];
  if (!isAffordable) legalityNotes.push(`Insufficient budget (deficit: £${Math.abs(bankAfterTenths / 10).toFixed(1)}m)`);
  if (!isPosValid) legalityNotes.push("Positional counts violated (must be 2 GKP, 5 DEF, 5 MID, 3 FWD)");
  if (!clubCheck.isValid) legalityNotes.push(`Club limits exceeded for clubs: ${clubCheck.violatingClubs.join(", ")}`);

  // 4. Evaluate Squad Horizon Output
  let postHorizonScore = 0.0;
  let postLineups: GwLineupDecision[] = [];
  let postGwBreakdown: Array<{
    gameweek: number;
    gw_offset: number;
    discount_factor: number;
    team_points: number;
    discounted_team_points: number;
  }> = [];

  if (isLegal) {
    const evalResult = evaluateSquadHorizonValue({
      squad: resultingSquad,
      snapshot,
      precomputedProjections,
      horizon,
      discountFactor,
    });
    postHorizonScore = evalResult.totalHorizonScore;
    postLineups = evalResult.lineupsByGw;
    postGwBreakdown = evalResult.gwBreakdown;
  } else {
    // If illegal, assign large penalty
    postHorizonScore = -999.0;
  }

  // 5. Calculate Gains
  const grossGain = roundTo(postHorizonScore - holdEvaluation.totalHorizonScore, 2);
  const netGain = roundTo(grossGain - hitCost, 2);

  // 6. GW Decomposition
  const gwDecomposition = holdEvaluation.gwBreakdown.map((holdGw, idx) => {
    const postGw = postGwBreakdown[idx] || { team_points: 0, discounted_team_points: 0 };
    const grossGwGain = roundTo(postGw.team_points - holdGw.team_points, 2);
    const discGwGain = roundTo(postGw.discounted_team_points - holdGw.discounted_team_points, 2);
    return {
      gameweek: holdGw.gameweek,
      gw_offset: holdGw.gw_offset,
      discount_factor: holdGw.discount_factor,
      team_points: postGw.team_points,
      discounted_team_points: postGw.discounted_team_points,
      hold_team_points: holdGw.team_points,
      discounted_hold_team_points: holdGw.discounted_team_points,
      gross_gain: grossGwGain,
      discounted_gain: discGwGain,
    };
  });

  // 7. Qualitative Starting XI & Lineup Impact
  const gw1Post = postLineups[0];
  const gw1Hold = holdEvaluation.lineupsByGw[0];

  const inIds = new Set(transfersIn.map((p) => p.id));
  const startingInGw1 = gw1Post ? transfersIn.some((p) => gw1Post.starting_xi_ids.includes(p.id)) : false;
  let incomingStartsCount = 0;
  for (const lineup of postLineups) {
    if (transfersIn.some((p) => lineup.starting_xi_ids.includes(p.id))) {
      incomingStartsCount++;
    }
  }

  const replacedStarters: string[] = [];
  if (gw1Hold && gw1Post) {
    const postSet = new Set(gw1Post.starting_xi_ids);
    for (const p of holdEvaluation.lineupsByGw[0].starting_xi_names) {
      const pId = gw1Hold.starting_xi_ids[gw1Hold.starting_xi_names.indexOf(p)];
      if (!postSet.has(pId)) {
        replacedStarters.push(p);
      }
    }
  }

  // 8. Captaincy Impact
  const capChanged = gw1Hold && gw1Post ? gw1Hold.captain_id !== gw1Post.captain_id : false;
  const oldCapBonus = gw1Hold ? gw1Hold.captaincy_bonus : 0.0;
  const newCapBonus = gw1Post ? gw1Post.captaincy_bonus : 0.0;

  // 9. Bench Impact
  const benchChanged = gw1Hold && gw1Post
    ? gw1Hold.bench_gk_id !== gw1Post.bench_gk_id ||
      JSON.stringify(gw1Hold.ordered_outfield_bench_ids) !== JSON.stringify(gw1Post.ordered_outfield_bench_ids)
    : false;

  // 10. FT Status
  let ftStatus: FtUsageStatus = "ROLL";
  if (transferCount === 0) {
    ftStatus = financialState.available_free_transfers >= FPL_RULES.max_banked_free_transfers ? "INDIFFERENT" : "ROLL";
  } else {
    ftStatus = netGain > FPL_RULES.min_transfer_gain_threshold ? "USE" : (
      financialState.available_free_transfers >= FPL_RULES.max_banked_free_transfers ? "INDIFFERENT" : "ROLL"
    );
  }

  return {
    plan_id: planId,
    transfers_out: transfersOut,
    transfers_in: transfersIn,
    transfer_count: transferCount,
    free_transfers_used: freeTransfersUsed,
    paid_transfers: paidTransfers,
    hit_cost: hitCost,
    bank_after: bankAfterTenths,
    resulting_squad_ids: resultingSquad.map((p) => p.id),
    gross_projected_gain: isLegal ? grossGain : -999.0,
    net_projected_gain: isLegal ? netGain : -999.0,
    team_horizon_expected_points: isLegal ? postHorizonScore : -999.0,
    hold_baseline_expected_points: holdEvaluation.totalHorizonScore,
    gw_breakdown: gwDecomposition,
    lineups_by_gw: postLineups,
    starting_xi_impact: {
      incoming_starts_count: incomingStartsCount,
      starting_in_first_gw: startingInGw1,
      replaced_starter_names: replacedStarters,
      formation_before_gw1: gw1Hold?.formation_label ?? "3-4-3",
      formation_after_gw1: gw1Post?.formation_label ?? "3-4-3",
    },
    captaincy_impact: {
      gw1_captain_changed: capChanged,
      old_captain_name: gw1Hold?.captain_name ?? "",
      new_captain_name: gw1Post?.captain_name ?? "",
      old_captain_bonus: oldCapBonus,
      new_captain_bonus: newCapBonus,
      captain_bonus_delta: roundTo(newCapBonus - oldCapBonus, 3),
    },
    bench_impact: {
      bench_changed: benchChanged,
      bench_gk_before: gw1Hold?.bench_gk_id ? (allPlayerMetaMap.get(gw1Hold.bench_gk_id)?.web_name || "GKP") : "None",
      bench_gk_after: gw1Post?.bench_gk_id ? (allPlayerMetaMap.get(gw1Post.bench_gk_id)?.web_name || "GKP") : "None",
      outfield_bench_before: (gw1Hold?.ordered_outfield_bench_ids || []).map((id) => allPlayerMetaMap.get(id)?.web_name || String(id)),
      outfield_bench_after: (gw1Post?.ordered_outfield_bench_ids || []).map((id) => allPlayerMetaMap.get(id)?.web_name || String(id)),
    },
    ft_usage_status: ftStatus,
    is_legal: isLegal,
    legality_notes: legalityNotes.length > 0 ? legalityNotes : undefined,
  };
}

// ============================================================================
// 6. MAIN TRANSFER OPTIMIZER ENGINE
// ============================================================================

export function runTransferEngine(options: {
  financialState: TeamFinancialState;
  snapshot: PredictionSnapshot;
  allPlayers: Array<Record<string, any>>;
  allFixtures: Array<Record<string, any>>;
  allTeams: Array<Record<string, any>>;
  playerHistories?: Record<number, Array<Record<string, any>>>;
  horizon?: number;
  discountFactor?: number;
  maxTransfers?: number;
  minTransferGainThreshold?: number;
  topCandidateLimitPerPosition?: number;
}): TransferEngineResult {
  const startTime = Date.now();

  const {
    financialState,
    snapshot,
    allPlayers,
    allFixtures,
    allTeams,
    playerHistories = {},
    horizon = DEFAULT_PROJECTION_HORIZON,
    discountFactor = DEFAULT_DISCOUNT_FACTORS[1], // 0.95
    maxTransfers = 2,
    minTransferGainThreshold = FPL_RULES.min_transfer_gain_threshold,
    topCandidateLimitPerPosition = 25,
  } = options;

  // 1. Validate Squad & Financial State
  if (!financialState || !Array.isArray(financialState.owned_players) || financialState.owned_players.length !== 15) {
    throw new Error(
      `Transfer engine requires exactly 15 owned squad players in financial state, received ${financialState?.owned_players?.length ?? 0}`
    );
  }

  // Check if historical financial state is missing or unverified
  if (financialState.is_historical && !financialState.is_historical_verified) {
    return {
      version: TRANSFER_ENGINE_VERSION,
      rules_version: FPL_TRANSFER_RULES_VERSION,
      snapshot_id: snapshot.snapshot_id,
      prediction_gameweek: snapshot.boundary.prediction_gameweek ?? 1,
      historical_cutoff_gameweek: snapshot.boundary.historical_cutoff_gameweek,
      team_id: financialState.team_id,
      bank: financialState.bank || 0,
      available_free_transfers: financialState.available_free_transfers || 0,
      squad_selling_value: 0,
      total_team_value: 0,
      financial_state_validity: "INSUFFICIENT_HISTORICAL_FINANCIAL_STATE",
      validation_message:
        "The official FPL API does not retain historical selling prices or bank per gameweek in the public picks endpoint without explicit snapshotting at the deadline. Historical selling prices, bank, and purchase prices were not stored or verified at exact GW cutoff.",
      horizon,
      discount_factor: discountFactor,
      max_transfers: maxTransfers,
      min_transfer_gain_threshold: minTransferGainThreshold,
      search_scope: {
        one_transfer: "EXHAUSTIVE",
        two_transfer: "HEURISTIC",
      },
      global_optimality: "NOT_PROVEN",
      audit: {
        search_status_1_transfer: "EXHAUSTIVE",
        search_status_2_transfer: "HEURISTIC",
        one_transfer_optimality: "GLOBAL_OPTIMUM",
        two_transfer_optimality: "NOT_PROVEN",
        future_transfer_reoptimization: "NOT_YET_MODELED",
        chips_implemented: "NONE",
        active_player_pool_size: 0,
        projection_valid_pool_size: 0,
        candidate_pool_by_position: { GKP: 0, DEF: 0, MID: 0, FWD: 0 },
        candidate_incoming_pool_size: 0,
        legal_1_transfer_count: 0,
        legal_2_transfer_count: 0,
        safe_pruned_2_transfer_count: 0,
        heuristic_pruned_2_transfer_count: 0,
        evaluated_plans_count: 0,
        runtime_ms: Date.now() - startTime,
      },
      recommendation: "HOLD",
      recommendation_action: "HOLD",
      recommendation_basis: "Historical financial state is unverified.",
      ft_usage_status: "ROLL",
      ft_roll_explanation: "HOLD leaves the FT unused, so under FPL rules it rolls into the next GW.",
      recommended_plan: null as any,
      hold_plan: null as any,
      top_1_transfer_plans: [],
      top_2_transfer_plans: [],
      all_ranked_plans: [],
      horizon_sensitivity: [],
    };
  }

  const isFinancialStateValid =
    typeof financialState.bank === "number" &&
    !isNaN(financialState.bank) &&
    financialState.owned_players.every(
      (p) => typeof p.selling_price === "number" && !isNaN(p.selling_price)
    );

  if (!isFinancialStateValid) {
    return {
      version: TRANSFER_ENGINE_VERSION,
      rules_version: FPL_TRANSFER_RULES_VERSION,
      snapshot_id: snapshot.snapshot_id,
      prediction_gameweek: snapshot.boundary.prediction_gameweek ?? 1,
      historical_cutoff_gameweek: snapshot.boundary.historical_cutoff_gameweek,
      team_id: financialState.team_id,
      bank: 0,
      available_free_transfers: 0,
      squad_selling_value: 0,
      total_team_value: 0,
      financial_state_validity: "INSUFFICIENT_HISTORICAL_FINANCIAL_STATE",
      validation_message:
        "The required bank or selling prices could not be reconstructed at snapshot cutoff.",
      horizon,
      discount_factor: discountFactor,
      max_transfers: maxTransfers,
      min_transfer_gain_threshold: minTransferGainThreshold,
      search_scope: {
        one_transfer: "EXHAUSTIVE",
        two_transfer: "HEURISTIC",
      },
      global_optimality: "NOT_PROVEN",
      audit: {
        search_status_1_transfer: "EXHAUSTIVE",
        search_status_2_transfer: "HEURISTIC",
        one_transfer_optimality: "GLOBAL_OPTIMUM",
        two_transfer_optimality: "NOT_PROVEN",
        future_transfer_reoptimization: "NOT_YET_MODELED",
        chips_implemented: "NONE",
        active_player_pool_size: 0,
        projection_valid_pool_size: 0,
        candidate_pool_by_position: { GKP: 0, DEF: 0, MID: 0, FWD: 0 },
        candidate_incoming_pool_size: 0,
        legal_1_transfer_count: 0,
        legal_2_transfer_count: 0,
        safe_pruned_2_transfer_count: 0,
        heuristic_pruned_2_transfer_count: 0,
        evaluated_plans_count: 0,
        runtime_ms: Date.now() - startTime,
      },
      recommendation: "HOLD",
      recommendation_action: "HOLD",
      recommendation_basis: "Financial state contains invalid or missing values.",
      ft_usage_status: "ROLL",
      ft_roll_explanation: "HOLD leaves the FT unused, so under FPL rules it rolls into the next GW.",
      recommended_plan: null as any,
      hold_plan: null as any,
      top_1_transfer_plans: [],
      top_2_transfer_plans: [],
      all_ranked_plans: [],
      horizon_sensitivity: [],
    };
  }

  // Phase 8: Automatically apply live availability overrides before transfer planning
  const effectiveAllPlayers = applyActiveGlobalOverrides(allPlayers);
  const effectiveOwnedPlayers = applyActiveGlobalOverrides(financialState.owned_players);
  const effectiveFinancialState: TeamFinancialState = {
    ...financialState,
    owned_players: effectiveOwnedPlayers,
  };

  // 2. Precompute Player Meta Map & Owned Sets
  const allPlayerMetaMap = new Map<number, any>();
  for (const p of effectiveAllPlayers) {
    allPlayerMetaMap.set(p.id, p);
  }

  const ownedIdSet = new Set(effectiveFinancialState.owned_players.map((p) => p.id));
  const squadSellingValue = effectiveFinancialState.owned_players.reduce((sum, p) => sum + p.selling_price, 0);
  const totalTeamValue = squadSellingValue + effectiveFinancialState.bank;

  // 3. Precompute Multi-GW Projections for Owned Players & Active Candidates
  const precomputedProjections = new Map<number, PlayerMultiGwProjection>();

  // A. Precompute for all 15 owned players
  for (const owned of effectiveFinancialState.owned_players) {
    const rawPlayer = allPlayerMetaMap.get(owned.id) || {
      id: owned.id,
      web_name: owned.web_name,
      element_type: owned.element_type,
      team: owned.team,
    };
    const proj = projectPlayerMultiGameweek({
      player: rawPlayer,
      snapshot,
      allFixtures,
      allTeams,
      history: playerHistories[owned.id] || [],
      horizon: Math.max(horizon, 5),
    });
    precomputedProjections.set(owned.id, proj);
  }

  // B. Build candidate incoming players by position (all active non-owned players)
  const candidatePoolByPos: Record<number, CandidateIncomingPlayer[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };
  const activeIncomingPlayers: CandidateIncomingPlayer[] = [];

  for (const rawPlayer of effectiveAllPlayers) {
    if (ownedIdSet.has(rawPlayer.id)) continue;
    if (typeof rawPlayer.now_cost !== "number" || rawPlayer.now_cost <= 0) continue;
    if (!rawPlayer.element_type || rawPlayer.element_type < 1 || rawPlayer.element_type > 4) continue;

    // Filter out completely inactive or long-term unavailable players if status is permanent 'u'
    const status = String(rawPlayer.status || "").toLowerCase();
    if (status === "u") continue;

    const cand: CandidateIncomingPlayer = {
      id: rawPlayer.id,
      web_name: rawPlayer.web_name,
      element_type: rawPlayer.element_type,
      team: rawPlayer.team,
      team_short_name: rawPlayer.team_short_name || "",
      now_cost: rawPlayer.now_cost,
      status: rawPlayer.status,
      news: rawPlayer.news,
      chance_of_playing_next_round: rawPlayer.chance_of_playing_next_round,
    };
    candidatePoolByPos[rawPlayer.element_type].push(cand);
    activeIncomingPlayers.push(cand);
  }

  // Precompute Phase 6B projections for ALL active non-owned candidates
  const rawPlayersToProject = activeIncomingPlayers.map((c) => allPlayerMetaMap.get(c.id)!);
  const activeProjections = projectSquadMultiGameweek({
    players: rawPlayersToProject,
    snapshot,
    allFixtures,
    allTeams,
    playerHistories,
    horizon: Math.max(horizon, 5),
  });
  for (const proj of activeProjections) {
    precomputedProjections.set(proj.player_id, proj);
  }

  // For 2-transfer search, select candidates strictly by Phase 6B multi-GW cumulative xPts (no Form or Expert Score)
  const filteredCandidatesByPos: Record<number, CandidateIncomingPlayer[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };
  let totalCandidatesCount = 0;
  for (let pos = 1; pos <= 4; pos++) {
    const sortedPos = [...candidatePoolByPos[pos]].sort((a, b) => {
      const projA = precomputedProjections.get(a.id)?.cumulative_expected_points ?? 0;
      const projB = precomputedProjections.get(b.id)?.cumulative_expected_points ?? 0;
      return projB - projA;
    });
    const topSlice = sortedPos.slice(0, topCandidateLimitPerPosition);
    filteredCandidatesByPos[pos] = topSlice;
    totalCandidatesCount += topSlice.length;
  }

  // 4. Compute HOLD Baseline Evaluation
  const holdSquad = effectiveFinancialState.owned_players.map((p) => {
    const meta = allPlayerMetaMap.get(p.id);
    return {
      id: p.id,
      web_name: p.web_name,
      element_type: p.element_type,
      team: meta?.team ?? p.team,
      team_short_name: meta?.team_short_name ?? "",
      status: meta?.status ?? p.status,
      news: meta?.news ?? p.news,
      chance_of_playing_next_round: meta?.chance_of_playing_next_round ?? p.chance_of_playing_next_round,
    };
  });

  const holdEvalResult = evaluateSquadHorizonValue({
    squad: holdSquad,
    snapshot,
    precomputedProjections,
    horizon,
    discountFactor,
  });

  const holdPlan = evaluateTransferPlan({
    transfersOut: [],
    transfersIn: [],
    financialState: effectiveFinancialState,
    snapshot,
    allPlayerMetaMap,
    precomputedProjections,
    holdEvaluation: holdEvalResult,
    horizon,
    discountFactor,
  });

  const evaluatedPlans: TransferPlanEvaluation[] = [holdPlan];
  let legal1TransferCount = 0;
  let legal2TransferCount = 0;

  // 5. Search 1-Transfer Plans (100% Exhaustive across ALL active players in position)
  const oneTransferPlans: TransferPlanEvaluation[] = [];

  for (const outPlayer of effectiveFinancialState.owned_players) {
    // Search the COMPLETE set of candidates in position without top-N truncation!
    const eligibleIn = candidatePoolByPos[outPlayer.element_type] || [];
    for (const inPlayer of eligibleIn) {
      // Safe pruning: Budget legality
      const bankCheck = calculatePostTransferBank(effectiveFinancialState.bank, [outPlayer], [inPlayer]);
      if (!bankCheck.isAffordable) continue;

      // Safe pruning: Club limit check
      const remainingSquadTeams = holdSquad
        .filter((p) => p.id !== outPlayer.id)
        .map((p) => ({ team: p.team }))
        .concat([{ team: inPlayer.team }]);
      const clubCheck = isClubConstraintValid(remainingSquadTeams);
      if (!clubCheck.isValid) continue;

      const plan = evaluateTransferPlan({
        transfersOut: [outPlayer],
        transfersIn: [inPlayer],
        financialState: effectiveFinancialState,
        snapshot,
        allPlayerMetaMap,
        precomputedProjections,
        holdEvaluation: holdEvalResult,
        horizon,
        discountFactor,
      });

      if (plan.is_legal) {
        legal1TransferCount++;
        oneTransferPlans.push(plan);
        evaluatedPlans.push(plan);
      }
    }
  }

  // 6. Search 2-Transfer Plans (Pruned / Approximate)
  const twoTransferPlans: TransferPlanEvaluation[] = [];
  let raw2TransferCombos = 0;
  let safePruned2Transfers = 0;
  let heuristicPruned2Transfers = 0;

  if (maxTransfers >= 2) {
    const owned = effectiveFinancialState.owned_players;
    const seenPlanIds = new Set<string>();

    for (let i = 0; i < owned.length; i++) {
      for (let j = i + 1; j < owned.length; j++) {
        const out1 = owned[i];
        const out2 = owned[j];

        const pos1 = out1.element_type;
        const pos2 = out2.element_type;

        const inCandidates1 = filteredCandidatesByPos[pos1] || [];
        const inCandidates2 = filteredCandidatesByPos[pos2] || [];

        for (const in1 of inCandidates1) {
          for (const in2 of inCandidates2) {
            raw2TransferCombos++;
            if (in1.id === in2.id) {
              safePruned2Transfers++;
              continue; // Must be distinct players
            }

            const canonicalKey = generateCanonicalPlanId([out1, out2], [in1, in2]);
            if (seenPlanIds.has(canonicalKey)) {
              safePruned2Transfers++;
              continue;
            }
            seenPlanIds.add(canonicalKey);

            // Fast budget check before full simulation
            const { isAffordable } = calculatePostTransferBank(
              effectiveFinancialState.bank,
              [out1, out2],
              [in1, in2]
            );
            if (!isAffordable) {
              safePruned2Transfers++;
              continue;
            }

            // Fast club limit check
            const remainingSquadTeams = holdSquad
              .filter((p) => p.id !== out1.id && p.id !== out2.id)
              .map((p) => ({ team: p.team }))
              .concat([
                { team: in1.team },
                { team: in2.team },
              ]);
            const clubCheck = isClubConstraintValid(remainingSquadTeams);
            if (!clubCheck.isValid) {
              safePruned2Transfers++;
              continue;
            }

            // Fast candidate projection heuristic prune
            const projOut1 = precomputedProjections.get(out1.id);
            const projOut2 = precomputedProjections.get(out2.id);
            const projIn1 = precomputedProjections.get(in1.id);
            const projIn2 = precomputedProjections.get(in2.id);

            if (projOut1 && projOut2 && projIn1 && projIn2) {
              const cumGain =
                projIn1.cumulative_expected_points +
                projIn2.cumulative_expected_points -
                (projOut1.cumulative_expected_points + projOut2.cumulative_expected_points);
              // If incoming candidates combined lose > 2.0 raw points compared to outgoing players, skip
              if (cumGain < -2.0) {
                heuristicPruned2Transfers++;
                continue;
              }
            }

            const plan = evaluateTransferPlan({
              transfersOut: [out1, out2],
              transfersIn: [in1, in2],
              financialState: effectiveFinancialState,
              snapshot,
              allPlayerMetaMap,
              precomputedProjections,
              holdEvaluation: holdEvalResult,
              horizon,
              discountFactor,
            });

            if (plan.is_legal) {
              legal2TransferCount++;
              twoTransferPlans.push(plan);
              evaluatedPlans.push(plan);
            }
          }
        }
      }
    }
  }

  // 7. Sort Plans Deterministically
  oneTransferPlans.sort(compareTransferPlans);
  twoTransferPlans.sort(compareTransferPlans);
  evaluatedPlans.sort(compareTransferPlans);

  const top1Transfers = oneTransferPlans.slice(0, 10);
  const top2Transfers = twoTransferPlans.slice(0, 10);

  const bestPlan = evaluatedPlans[0];
  const isTransferRecommended =
    bestPlan.transfer_count > 0 &&
    bestPlan.net_projected_gain > minTransferGainThreshold;

  const finalRecommendation = isTransferRecommended ? bestPlan : holdPlan;
  const action = isTransferRecommended ? "TRANSFER" : "HOLD";

  // 8. Horizon Sensitivity Analysis (1, 3, 5 GW with discounts 1.00, 0.95, 0.90)
  const sensitivityHorizons = [1, 3, 5];
  const sensitivityDiscounts = [1.00, 0.95, 0.90];
  const horizonSensitivity: HorizonSensitivityItem[] = [];

  for (const h of sensitivityHorizons) {
    for (const d of sensitivityDiscounts) {
      // Fast evaluate top candidates under this horizon & discount
      const testPlans: TransferPlanEvaluation[] = [];

      // Re-evaluate HOLD
      const hHoldEval = evaluateSquadHorizonValue({
        squad: holdSquad,
        snapshot,
        precomputedProjections,
        horizon: h,
        discountFactor: d,
      });

      const hHoldPlan = evaluateTransferPlan({
        transfersOut: [],
        transfersIn: [],
        financialState,
        snapshot,
        allPlayerMetaMap,
        precomputedProjections,
        holdEvaluation: hHoldEval,
        horizon: h,
        discountFactor: d,
      });
      testPlans.push(hHoldPlan);

      // Re-evaluate top 5 1-transfer plans
      for (const p of oneTransferPlans.slice(0, 5)) {
        const rePlan = evaluateTransferPlan({
          transfersOut: p.transfers_out,
          transfersIn: p.transfers_in,
          financialState,
          snapshot,
          allPlayerMetaMap,
          precomputedProjections,
          holdEvaluation: hHoldEval,
          horizon: h,
          discountFactor: d,
        });
        testPlans.push(rePlan);
      }

      // Re-evaluate top 5 2-transfer plans
      for (const p of twoTransferPlans.slice(0, 5)) {
        const rePlan = evaluateTransferPlan({
          transfersOut: p.transfers_out,
          transfersIn: p.transfers_in,
          financialState,
          snapshot,
          allPlayerMetaMap,
          precomputedProjections,
          holdEvaluation: hHoldEval,
          horizon: h,
          discountFactor: d,
        });
        testPlans.push(rePlan);
      }

      testPlans.sort(compareTransferPlans);
      const hBest = testPlans[0];
      const transfersLabel =
        hBest.transfer_count === 0
          ? "HOLD"
          : `${hBest.transfers_out.map((p) => p.web_name).join(", ")} -> ${hBest.transfers_in.map((p) => p.web_name).join(", ")}`;

      horizonSensitivity.push({
        horizon: h,
        discount_factor: d,
        recommended_plan_id: hBest.plan_id,
        recommended_transfers_label: transfersLabel,
        gross_gain: hBest.gross_projected_gain,
        hit_cost: hBest.hit_cost,
        net_gain: hBest.net_projected_gain,
        rank_1_plan: hBest,
      });
    }
  }

  const runtimeMs = Date.now() - startTime;

  const urgencyAssessment = assessTransferUrgency({
    transfersIn: finalRecommendation.transfers_in,
    transfersOut: finalRecommendation.transfers_out,
    bankAfter: finalRecommendation.bank_after,
    allPlayerMetaMap,
  });
  finalRecommendation.urgency_assessment = urgencyAssessment;

  return {
    version: TRANSFER_ENGINE_VERSION,
    rules_version: FPL_TRANSFER_RULES_VERSION,
    snapshot_id: snapshot.snapshot_id,
    prediction_gameweek: snapshot.boundary.prediction_gameweek ?? 1,
    historical_cutoff_gameweek: snapshot.boundary.historical_cutoff_gameweek,
    team_id: financialState.team_id,
    bank: financialState.bank,
    available_free_transfers: financialState.available_free_transfers,
    squad_selling_value: squadSellingValue,
    total_team_value: totalTeamValue,
    financial_state_validity: "VALID",
    horizon,
    discount_factor: discountFactor,
    max_transfers: maxTransfers,
    min_transfer_gain_threshold: minTransferGainThreshold,
    search_scope: {
      one_transfer: "EXHAUSTIVE",
      two_transfer: "HEURISTIC",
    },
    global_optimality: "NOT_PROVEN",
    audit: {
      search_status_1_transfer: "EXHAUSTIVE",
      search_status_2_transfer: "HEURISTIC",
      one_transfer_optimality: "GLOBAL_OPTIMUM",
      two_transfer_optimality: "NOT_PROVEN",
      future_transfer_reoptimization: "NOT_YET_MODELED",
      chips_implemented: "NONE",
      active_player_pool_size: activeIncomingPlayers.length + 15,
      projection_valid_pool_size: precomputedProjections.size,
      candidate_pool_by_position: {
        GKP: candidatePoolByPos[1].length,
        DEF: candidatePoolByPos[2].length,
        MID: candidatePoolByPos[3].length,
        FWD: candidatePoolByPos[4].length,
      },
      candidate_incoming_pool_size: totalCandidatesCount,
      legal_1_transfer_count: legal1TransferCount,
      legal_2_transfer_count: legal2TransferCount,
      safe_pruned_2_transfer_count: safePruned2Transfers,
      heuristic_pruned_2_transfer_count: heuristicPruned2Transfers,
      evaluated_plans_count: evaluatedPlans.length,
      runtime_ms: runtimeMs,
    },
    recommendation: action,
    recommendation_action: action,
    recommendation_basis:
      action === "HOLD"
        ? "Best decision found under exhaustive 0/1-transfer search and heuristic 2-transfer search."
        : `Transfer plan improves expected points by ${finalRecommendation.net_projected_gain.toFixed(2)} xPts (above ${minTransferGainThreshold.toFixed(2)} threshold).`,
    ft_usage_status: finalRecommendation.ft_usage_status,
    ft_roll_explanation:
      finalRecommendation.ft_usage_status === "ROLL"
        ? "HOLD leaves the FT unused, so under FPL rules it rolls into the next GW."
        : undefined,
    recommended_plan: finalRecommendation,
    hold_plan: holdPlan,
    urgency_assessment: urgencyAssessment,
    margin_vs_best_alternative: (() => {
      const bestAlt = evaluatedPlans.find((p) => p.plan_id !== "HOLD") ?? null;
      const best1 = oneTransferPlans[0] ?? null;
      const best2 = twoTransferPlans[0] ?? null;
      const margin = bestAlt ? roundTo(holdPlan.team_horizon_expected_points - bestAlt.team_horizon_expected_points, 2) : 0;
      const holdAdvantageOver1 = best1 ? roundTo(0.00 - best1.net_projected_gain, 2) : 0;
      const tiebreak = best1 && Math.abs(best1.net_projected_gain) < EPSILON ? "fewer_transfers" : (margin > 0 ? "expected_points" : "none");
      let explanation = "No legal non-HOLD transfer plan found.";
      if (bestAlt) {
        if (Math.abs(bestAlt.net_projected_gain) < EPSILON) {
          explanation = `HOLD ties best 1-transfer plan on expected points (points advantage: 0.00 xPts) and wins deterministically on fewer transfers.`;
        } else {
          explanation = `HOLD (${margin >= 0 ? "+" : ""}${margin.toFixed(2)} xPts net margin) beats the best non-HOLD plan (${bestAlt.transfers_out.map((p) => p.web_name).join("+")} -> ${bestAlt.transfers_in.map((p) => p.web_name).join("+")}).`;
        }
      }
      return {
        best_1_transfer_net_gain: best1?.net_projected_gain ?? 0,
        best_2_transfer_net_gain: best2?.net_projected_gain ?? 0,
        best_alternative_net_gain: bestAlt?.net_projected_gain ?? 0,
        margin_xpts: margin,
        hold_points_advantage_over_best_1_transfer: holdAdvantageOver1,
        decision_tiebreak: tiebreak,
        explanation,
      };
    })(),
    top_1_transfer_plans: top1Transfers,
    top_2_transfer_plans: top2Transfers,
    all_ranked_plans: evaluatedPlans.slice(0, 20),
    horizon_sensitivity: horizonSensitivity,
  };
}

/**
 * Creates a designated, immutable CURRENT_LIVE_TRANSFER_SNAPSHOT for live transfer evaluations.
 */
export function createCurrentLiveTransferSnapshot(events: any[]): PredictionSnapshot {
  const boundary = determineGameweekBoundary(events);
  return new PredictionSnapshot({
    snapshot_id: "CURRENT_LIVE_TRANSFER_SNAPSHOT",
    boundary,
  });
}
