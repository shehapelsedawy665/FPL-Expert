import {
  FPL_RULES,
  TeamFinancialState,
  CandidateIncomingPlayer,
  OwnedPlayerFinancialState,
  isClubConstraintValid,
  isSquadPositionalBalanceValid,
  buildDecisionPlayerForGw,
  calculatePostTransferBank,
} from "./transfer_engine.js";
import {
  roundTo,
  EPSILON,
  optimizeStartingXi,
  evaluateCaptaincyPairs,
  DecisionSquadPlayer,
} from "./decision_engine.js";
import {
  PlayerMultiGwProjection,
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  DEFAULT_PROJECTION_HORIZON,
  DEFAULT_DISCOUNT_FACTORS,
} from "./multi_gw_projection.js";
import { PredictionSnapshot } from "./prediction_contract.js";
import {
  assessTransferUrgency,
  UrgencyAssessment,
} from "./price_predictor.js";
import { applyActiveGlobalOverrides } from "./availability_intelligence.js";

// ============================================================================
// 1. VERSION CONTRACTS & METADATA
// ============================================================================

export const SEQUENTIAL_ENGINE_VERSION = "sequential-transfer.v1";
export const SEQUENTIAL_PRICE_MODEL = "FROZEN_DEADLINE_PRICES_ZERO_DRIFT";
export const SEQUENTIAL_SEARCH_SCOPE = "HEURISTIC_BEAM_SEARCH";
export const SEQUENTIAL_FPL_RULES_VERSION = "fpl-transfer-rules.2026-27.v1";

// ============================================================================
// 2. DATA STRUCTURES & INTERFACES
// ============================================================================

export type SequentialSearchScopeType = "HEURISTIC_BEAM_SEARCH";
export type SequentialPriceModelType = "FROZEN_DEADLINE_PRICES_ZERO_DRIFT";

export interface SequentialStepAction {
  gameweek: number;
  transfers_out_ids: number[];
  transfers_in_ids: number[];
  transfer_count: number;
  free_transfers_available_before: number;
  free_transfers_used: number;
  paid_transfers: number;
  hit_cost: number;
  bank_before: number;
  bank_after: number;
  action_label: string; // e.g. "HOLD" or "OUT:31 -> IN:173"
}

export interface PlayerValuationRecord {
  id: number;
  selling_price: number;
  purchase_price: number;
}

export interface SequentialState {
  gameweek: number;
  squad_ids: number[]; // sorted 15 player ids
  bank: number; // in £m (e.g. 0.4)
  available_ft: number; // in [1, 5]
  player_valuations: Map<number, PlayerValuationRecord>;
}

export interface TrajectoryNode {
  stage: number; // 0 to horizon-1
  state: SequentialState;
  cumulative_points: number; // discounted xPts minus hits accrued so far
  cumulative_hit_cost: number;
  cumulative_transfers: number;
  action_history: SequentialStepAction[];
  parent_node_id?: string;
  node_id: string;
}

export interface SequentialPlan {
  plan_id: string;
  horizon: number;
  total_discounted_points: number;
  total_hit_cost: number;
  total_transfers: number;
  trajectory_steps: SequentialStepAction[];
  final_state: {
    squad_ids: number[];
    bank: number;
    available_ft: number;
  };
  metadata: {
    engine_version: string;
    price_model: SequentialPriceModelType;
    search_scope: SequentialSearchScopeType;
    global_optimality: "NOT_PROVEN";
  };
  financial_state_validity?: "VALID" | "INSUFFICIENT_HISTORICAL_FINANCIAL_STATE";
  validation_message?: string;
  gw_breakdown?: Array<{
    gameweek: number;
    gw_offset: number;
    action_label: string;
    starting_xi_points: number;
    captain?: {
      id: number;
      web_name: string;
      bonus_points: number;
    };
    team_points: number;
    discounted_points: number;
    hit_cost: number;
    discounted_hit_cost: number;
    net_points: number;
    available_ft_after: number;
    bank_after: number;
  }>;
  urgency_assessment?: UrgencyAssessment;
}

export interface BudgetDeltaResult {
  newBank: number;
  isAffordable: boolean;
  delta: number;
}

// ============================================================================
// 3. PURE STATE-TRANSITION FUNCTIONS
// ============================================================================

/**
 * Computes available Free Transfers for the next gameweek.
 * Follows 2026/27 FPL rules:
 * - Free transfers can accumulate up to a maximum of 5.
 * - Minimum FT is 1 (each gameweek boundary awards +1 FT to remaining FTs).
 *
 * Rule formula:
 *   free_transfers_used = min(transfersUsed, currentFT)
 *   remaining_FT = currentFT - free_transfers_used
 *   nextFT = min(max_banked_free_transfers, remaining_FT + 1)
 */
export function nextGameweekFT(
  currentFT: number,
  transfersUsed: number,
  maxBanked: number = FPL_RULES.max_banked_free_transfers
): number {
  const boundedCurrent = Math.max(1, Math.min(maxBanked, Math.floor(currentFT)));
  const nonNegativeUsed = Math.max(0, Math.floor(transfersUsed));

  const ftUsed = Math.min(nonNegativeUsed, boundedCurrent);
  const remaining = boundedCurrent - ftUsed;
  const nextFT = Math.min(maxBanked, remaining + 1);

  return Math.max(1, nextFT);
}

/**
 * Computes hit penalty (in points) incurred by transfer count given available FTs.
 * Each extra transfer beyond available FT costs 4 points.
 */
export function calculateHitCost(
  transfersUsed: number,
  availableFT: number,
  costPerExtraTransfer: number = FPL_RULES.extra_transfer_hit_cost_points
): number {
  const boundedFT = Math.max(0, Math.floor(availableFT));
  const boundedUsed = Math.max(0, Math.floor(transfersUsed));

  const extraTransfers = Math.max(0, boundedUsed - boundedFT);
  return extraTransfers * costPerExtraTransfer;
}

/**
 * Applies zero-drift budget calculation using integer-tenths arithmetic.
 * Ensures no floating-point precision drift (e.g. 0.1 + 0.2 != 0.30000000000000004).
 *
 * @param bank Current bank in millions (£m, e.g. 0.5)
 * @param sellingPrices Array of selling prices in £m (e.g. [4.4, 4.5])
 * @param buyingPrices Array of buying prices in £m (e.g. [4.0, 4.5])
 */
export function applyZeroDriftBudget(
  bank: number,
  sellingPrices: number[],
  buyingPrices: number[]
): BudgetDeltaResult {
  const bankTenths = Math.round(bank * 10);
  const totalSellTenths = sellingPrices.reduce((acc, p) => acc + Math.round(p * 10), 0);
  const totalBuyTenths = buyingPrices.reduce((acc, p) => acc + Math.round(p * 10), 0);

  const deltaTenths = totalSellTenths - totalBuyTenths;
  const newBankTenths = bankTenths + deltaTenths;

  return {
    newBank: newBankTenths / 10,
    isAffordable: newBankTenths >= 0,
    delta: deltaTenths / 10,
  };
}

/**
 * Checks if candidate trajectory state is dominated by baseline trajectory state.
 *
 * Two states at the same stage with identical squads:
 * Baseline dominates Candidate if:
 *   - baseline.cumulative_points >= candidate.cumulative_points
 *   - baseline.state.bank >= candidate.state.bank
 *   - baseline.state.available_ft >= candidate.state.available_ft
 *   AND at least one is strictly greater:
 *     (points > points OR bank > bank OR FT > FT),
 *     OR if all three are equal, baseline achieves it with <= cumulative_hit_cost and <= cumulative_transfers.
 */
export function isStateDominated(
  candidate: TrajectoryNode,
  baseline: TrajectoryNode
): boolean {
  if (candidate.stage !== baseline.stage) {
    return false;
  }

  // Must have identical 15-player squads
  if (candidate.state.squad_ids.length !== baseline.state.squad_ids.length) {
    return false;
  }
  for (let i = 0; i < candidate.state.squad_ids.length; i++) {
    if (candidate.state.squad_ids[i] !== baseline.state.squad_ids[i]) {
      return false;
    }
  }

  const bankDiff = Math.round(baseline.state.bank * 10) - Math.round(candidate.state.bank * 10);
  const ftDiff = baseline.state.available_ft - candidate.state.available_ft;
  const pointsDiff = baseline.cumulative_points - candidate.cumulative_points;

  // Baseline must be at least as good in all three dimensions
  if (pointsDiff < -EPSILON || bankDiff < 0 || ftDiff < 0) {
    return false;
  }

  const strictlyBetterPoints = pointsDiff > EPSILON;
  const strictlyBetterBank = bankDiff > 0;
  const strictlyBetterFt = ftDiff > 0;

  if (strictlyBetterPoints || strictlyBetterBank || strictlyBetterFt) {
    return true;
  }

  // All 3 primary metrics are virtually identical: tiebreak on fewer cumulative hits/transfers
  if (
    baseline.cumulative_hit_cost <= candidate.cumulative_hit_cost &&
    baseline.cumulative_transfers < candidate.cumulative_transfers
  ) {
    return true;
  }

  if (
    baseline.cumulative_hit_cost < candidate.cumulative_hit_cost &&
    baseline.cumulative_transfers <= candidate.cumulative_transfers
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// 4. LINEUP EVALUATION & SEQUENTIAL OPTIMIZER
// ============================================================================

export interface SequentialOptimizerOptions {
  financialState: TeamFinancialState;
  snapshot: PredictionSnapshot;
  allPlayers: Array<Record<string, any>>;
  allFixtures: Array<Record<string, any>>;
  allTeams: Array<Record<string, any>>;
  playerHistories?: Record<number, Array<Record<string, any>>>;
  horizon?: number;
  discountFactor?: number;
  beamWidth?: number;
  candidateLimitPerPosition?: number;
  maxTransfersPerGw?: number;
  precomputedProjections?: Map<number, PlayerMultiGwProjection>;
}

export function evaluateSquadLineupForGameweek(options: {
  squadIds: number[];
  gwOffset: number;
  snapshot: PredictionSnapshot;
  precomputedProjections: Map<number, PlayerMultiGwProjection>;
  allPlayerMetaMap: Map<number, any>;
}): {
  startingXiXpts: number;
  captaincyBonus: number;
  gwTeamTotal: number;
  starters: DecisionSquadPlayer[];
  bestPair: any;
  formationLabel: string;
} {
  const { squadIds, gwOffset, precomputedProjections, allPlayerMetaMap } = options;
  const squadForGw: DecisionSquadPlayer[] = squadIds.map((id) => {
    const meta = allPlayerMetaMap.get(id);
    if (!meta) {
      throw new Error(`Missing metadata for player ID ${id}`);
    }
    const proj = precomputedProjections.get(id);
    if (!proj) {
      throw new Error(`Missing projection for player ID ${id}`);
    }
    const gwProj = proj.gameweeks.find((g) => g.gw_offset === gwOffset);
    if (!gwProj) {
      throw new Error(`Missing gameweek projection at offset ${gwOffset} for player ID ${id}`);
    }
    return buildDecisionPlayerForGw(meta, gwProj);
  });

  const { best_formation } = optimizeStartingXi(squadForGw);
  const starters = best_formation.starters;
  const { best_pair } = evaluateCaptaincyPairs(starters);

  const startingXiXpts = roundTo(best_formation.total_decision_expected_points, 2);
  const captaincyBonus = roundTo(best_pair.expected_captaincy_bonus, 3);
  const gwTeamTotal = roundTo(startingXiXpts + captaincyBonus, 3);

  return {
    startingXiXpts,
    captaincyBonus,
    gwTeamTotal,
    starters,
    bestPair: best_pair,
    formationLabel: best_formation.formation_label,
  };
}

/**
 * Optimizes sequential transfer trajectories across a Multi-GW horizon using
 * constrained Forward Beam Search with State Dominance Pruning.
 */
export function optimizeSequentialTransfers(
  options: SequentialOptimizerOptions
): SequentialPlan {
  const {
    financialState,
    snapshot,
    allPlayers,
    allFixtures,
    allTeams,
    playerHistories = {},
    horizon = DEFAULT_PROJECTION_HORIZON,
    discountFactor = DEFAULT_DISCOUNT_FACTORS[1], // 0.95
    beamWidth = 20,
    candidateLimitPerPosition = 10,
    maxTransfersPerGw = 2,
  } = options;

  if (
    !financialState ||
    !Array.isArray(financialState.owned_players) ||
    financialState.owned_players.length !== 15
  ) {
    throw new Error(
      `Sequential optimizer requires exactly 15 owned squad players in financial state, received ${financialState?.owned_players?.length ?? 0}`
    );
  }

  // Guard: Historical financial state missing/unverified
  if (financialState.is_historical && !financialState.is_historical_verified) {
    const holdPlan = optimizeSequentialTransfers({
      ...options,
      maxTransfersPerGw: 0,
      financialState: {
        ...financialState,
        is_historical: false,
      },
    });
    return {
      ...holdPlan,
      financial_state_validity: "INSUFFICIENT_HISTORICAL_FINANCIAL_STATE",
      validation_message:
        "The official FPL API does not retain historical selling prices or bank per gameweek in the public picks endpoint without explicit snapshotting at the deadline. Historical selling prices, bank, and purchase prices were not stored or verified at exact GW cutoff.",
    };
  }

  // Phase 8: Automatically apply live availability overrides before sequential planning
  const effectiveAllPlayers = applyActiveGlobalOverrides(allPlayers);
  const effectiveOwnedPlayers = applyActiveGlobalOverrides(financialState.owned_players);
  const effectiveFinancialState: TeamFinancialState = {
    ...financialState,
    owned_players: effectiveOwnedPlayers,
  };

  // 1. Build Metadata Map
  const allPlayerMetaMap = new Map<number, any>();
  for (const p of effectiveAllPlayers) {
    allPlayerMetaMap.set(p.id, p);
  }
  for (const op of effectiveFinancialState.owned_players) {
    if (!allPlayerMetaMap.has(op.id)) {
      allPlayerMetaMap.set(op.id, {
        id: op.id,
        web_name: op.web_name,
        element_type: op.element_type,
        team: op.team,
        now_cost: op.now_cost,
        selling_price: op.selling_price,
      });
    }
  }

  // 2. Normalize Financials (detect tenths vs £m)
  const isTenthsBased = effectiveFinancialState.owned_players.some((p) => p.now_cost > 20);
  const bankInM = isTenthsBased ? effectiveFinancialState.bank / 10 : effectiveFinancialState.bank;

  const initialSquadIds = [...effectiveFinancialState.owned_players.map((p) => p.id)].sort(
    (a, b) => a - b
  );
  const initialValuations = new Map<number, PlayerValuationRecord>();
  for (const p of effectiveFinancialState.owned_players) {
    const sellM = isTenthsBased ? p.selling_price / 10 : p.selling_price;
    const buyM = isTenthsBased ? p.now_cost / 10 : p.now_cost;
    initialValuations.set(p.id, {
      id: p.id,
      selling_price: sellM,
      purchase_price: buyM,
    });
  }

  // 3. Precompute Projections
  const precomputedProjections =
    options.precomputedProjections || new Map<number, PlayerMultiGwProjection>();

  if (precomputedProjections.size === 0) {
    // Project owned
    for (const owned of effectiveFinancialState.owned_players) {
      const raw = allPlayerMetaMap.get(owned.id);
      const proj = projectPlayerMultiGameweek({
        player: raw,
        snapshot,
        allFixtures,
        allTeams,
        history: playerHistories[owned.id] || [],
        horizon: Math.max(horizon, 5),
      });
      precomputedProjections.set(owned.id, proj);
    }

    // Project non-owned active candidates
    const ownedSet = new Set(initialSquadIds);
    const nonOwnedCandidates = effectiveAllPlayers.filter((p) => {
      if (ownedSet.has(p.id)) return false;
      if (!p.element_type || p.element_type < 1 || p.element_type > 4) return false;
      const status = String(p.status || "").toLowerCase();
      if (status === "u") return false;
      return true;
    });

    const candProjs = projectSquadMultiGameweek({
      players: nonOwnedCandidates,
      snapshot,
      allFixtures,
      allTeams,
      playerHistories,
      horizon: Math.max(horizon, 5),
    });
    for (const proj of candProjs) {
      precomputedProjections.set(proj.player_id, proj);
    }
  }

  // 4. Group candidate incoming pool by position sorted by cumulative expected points
  const candidatePoolByPos: Record<number, CandidateIncomingPlayer[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };
  for (const p of allPlayers) {
    if (p.element_type >= 1 && p.element_type <= 4) {
      const status = String(p.status || "").toLowerCase();
      if (status === "u") continue;
      candidatePoolByPos[p.element_type].push({
        id: p.id,
        web_name: p.web_name,
        element_type: p.element_type,
        team: p.team,
        now_cost: isTenthsBased ? p.now_cost / 10 : p.now_cost,
        status: p.status,
        news: p.news,
      });
    }
  }

  for (let pos = 1; pos <= 4; pos++) {
    candidatePoolByPos[pos].sort((a, b) => {
      const pA = precomputedProjections.get(a.id)?.cumulative_expected_points ?? 0;
      const pB = precomputedProjections.get(b.id)?.cumulative_expected_points ?? 0;
      return pB - pA;
    });
  }

  // 5. Lineup Evaluation Memoization Cache
  const lineupCache = new Map<
    string,
    {
      startingXiXpts: number;
      captaincyBonus: number;
      gwTeamTotal: number;
      starters: DecisionSquadPlayer[];
      bestPair: any;
      formationLabel: string;
    }
  >();

  function getCachedLineup(squadIds: number[], gwOffset: number) {
    const key = `${[...squadIds].sort((a, b) => a - b).join(",")}:${gwOffset}`;
    const cached = lineupCache.get(key);
    if (cached) return cached;

    const res = evaluateSquadLineupForGameweek({
      squadIds,
      gwOffset,
      snapshot,
      precomputedProjections,
      allPlayerMetaMap,
    });
    lineupCache.set(key, res);
    return res;
  }

  // 6. Root Node
  const startGw = snapshot.boundary.prediction_gameweek ?? 1;
  const rootNode: TrajectoryNode = {
    stage: 0,
    node_id: "root",
    cumulative_points: 0,
    cumulative_hit_cost: 0,
    cumulative_transfers: 0,
    action_history: [],
    state: {
      gameweek: startGw,
      squad_ids: initialSquadIds,
      bank: bankInM,
      available_ft: Math.max(1, Math.min(5, effectiveFinancialState.available_free_transfers || 1)),
      player_valuations: initialValuations,
    },
  };

  // 7. Forward Beam Search Loop
  let currentBeam: TrajectoryNode[] = [rootNode];

  for (let stage = 0; stage < horizon; stage++) {
    const gwOffset = stage + 1;
    const currentGw = startGw + stage;
    const stageDiscount = roundTo(Math.pow(discountFactor, stage), 6);
    const candidateNodes: TrajectoryNode[] = [];

    for (const node of currentBeam) {
      const currentSquadIds = node.state.squad_ids;
      const currentSquadSet = new Set(currentSquadIds);
      const currentBank = node.state.bank;
      const currentFT = node.state.available_ft;

      // ----------------------------------------------------------------------
      // Action Type 1: HOLD (0 Transfers)
      // ----------------------------------------------------------------------
      {
        const nextFT = nextGameweekFT(currentFT, 0);
        const evalLineup = getCachedLineup(currentSquadIds, gwOffset);
        const discountedGwScore = roundTo(evalLineup.gwTeamTotal * stageDiscount, 4);

        const holdStep: SequentialStepAction = {
          gameweek: currentGw,
          transfers_out_ids: [],
          transfers_in_ids: [],
          transfer_count: 0,
          free_transfers_available_before: currentFT,
          free_transfers_used: 0,
          paid_transfers: 0,
          hit_cost: 0,
          bank_before: currentBank,
          bank_after: currentBank,
          action_label: "HOLD",
        };

        const holdChild: TrajectoryNode = {
          stage: stage + 1,
          node_id: `${node.node_id}_H`,
          parent_node_id: node.node_id,
          cumulative_points: roundTo(node.cumulative_points + discountedGwScore, 4),
          cumulative_hit_cost: node.cumulative_hit_cost,
          cumulative_transfers: node.cumulative_transfers,
          action_history: [...node.action_history, holdStep],
          state: {
            gameweek: currentGw + 1,
            squad_ids: currentSquadIds,
            bank: currentBank,
            available_ft: nextFT,
            player_valuations: new Map(node.state.player_valuations),
          },
        };
        candidateNodes.push(holdChild);
      }

      // ----------------------------------------------------------------------
      // Action Type 2: 1-Transfer
      // ----------------------------------------------------------------------
      if (maxTransfersPerGw >= 1) {
        for (const outId of currentSquadIds) {
          const outMeta = allPlayerMetaMap.get(outId);
          if (!outMeta) continue;
          const outVal = node.state.player_valuations.get(outId);
          const outSellPrice = outVal
            ? outVal.selling_price
            : (isTenthsBased ? outMeta.now_cost / 10 : outMeta.now_cost);

          const eligibleCandidates = (candidatePoolByPos[outMeta.element_type] || [])
            .filter((c) => !currentSquadSet.has(c.id))
            .slice(0, candidateLimitPerPosition);

          for (const inCand of eligibleCandidates) {
            const inBuyPrice = inCand.now_cost;
            const budgetRes = applyZeroDriftBudget(currentBank, [outSellPrice], [inBuyPrice]);
            if (!budgetRes.isAffordable) continue;

            // Check club constraint
            const candidateSquadIds = currentSquadIds
              .filter((id) => id !== outId)
              .concat([inCand.id])
              .sort((a, b) => a - b);

            const squadPlayersForClubCheck = candidateSquadIds.map((id) => {
              const meta = allPlayerMetaMap.get(id);
              return { team: meta?.team ?? inCand.team };
            });

            if (!isClubConstraintValid(squadPlayersForClubCheck).isValid) continue;

            const hitCost = calculateHitCost(1, currentFT);
            const discountedHit = roundTo(hitCost * stageDiscount, 4);
            const nextFT = nextGameweekFT(currentFT, 1);

            const evalLineup = getCachedLineup(candidateSquadIds, gwOffset);
            const discountedGwScore = roundTo(evalLineup.gwTeamTotal * stageDiscount, 4);

            const newValuations = new Map(node.state.player_valuations);
            newValuations.delete(outId);
            newValuations.set(inCand.id, {
              id: inCand.id,
              selling_price: inBuyPrice,
              purchase_price: inBuyPrice,
            });

            const actionStep: SequentialStepAction = {
              gameweek: currentGw,
              transfers_out_ids: [outId],
              transfers_in_ids: [inCand.id],
              transfer_count: 1,
              free_transfers_available_before: currentFT,
              free_transfers_used: Math.min(1, currentFT),
              paid_transfers: Math.max(0, 1 - currentFT),
              hit_cost: hitCost,
              bank_before: currentBank,
              bank_after: budgetRes.newBank,
              action_label: `OUT:${outMeta.web_name} -> IN:${inCand.web_name}`,
            };

            const childNode: TrajectoryNode = {
              stage: stage + 1,
              node_id: `${node.node_id}_1T_${outId}_${inCand.id}`,
              parent_node_id: node.node_id,
              cumulative_points: roundTo(
                node.cumulative_points + discountedGwScore - discountedHit,
                4
              ),
              cumulative_hit_cost: node.cumulative_hit_cost + hitCost,
              cumulative_transfers: node.cumulative_transfers + 1,
              action_history: [...node.action_history, actionStep],
              state: {
                gameweek: currentGw + 1,
                squad_ids: candidateSquadIds,
                bank: budgetRes.newBank,
                available_ft: nextFT,
                player_valuations: newValuations,
              },
            };
            candidateNodes.push(childNode);
          }
        }
      }

      // ----------------------------------------------------------------------
      // Action Type 3: 2-Transfers (Top Heuristic Pairs)
      // ----------------------------------------------------------------------
      if (maxTransfersPerGw >= 2) {
        // Outgoing candidate selection: players with lowest expected points in their positions
        const sortedOwned = [...currentSquadIds].sort((a, b) => {
          const pA = precomputedProjections.get(a)?.cumulative_expected_points ?? 0;
          const pB = precomputedProjections.get(b)?.cumulative_expected_points ?? 0;
          return pA - pB;
        });

        // Test bottom 6 outfield/gk candidates for pairing
        const bottomOutgoing = sortedOwned.slice(0, 6);
        const top2CandLimit = Math.min(3, candidateLimitPerPosition);

        for (let i = 0; i < bottomOutgoing.length; i++) {
          for (let j = i + 1; j < bottomOutgoing.length; j++) {
            const out1Id = bottomOutgoing[i];
            const out2Id = bottomOutgoing[j];
            const out1Meta = allPlayerMetaMap.get(out1Id);
            const out2Meta = allPlayerMetaMap.get(out2Id);
            if (!out1Meta || !out2Meta) continue;

            const out1Val = node.state.player_valuations.get(out1Id);
            const out2Val = node.state.player_valuations.get(out2Id);
            const sell1 = out1Val
              ? out1Val.selling_price
              : (isTenthsBased ? out1Meta.now_cost / 10 : out1Meta.now_cost);
            const sell2 = out2Val
              ? out2Val.selling_price
              : (isTenthsBased ? out2Meta.now_cost / 10 : out2Meta.now_cost);

            // Pair matching positions
            const cands1 = (candidatePoolByPos[out1Meta.element_type] || [])
              .filter((c) => !currentSquadSet.has(c.id))
              .slice(0, top2CandLimit);
            const cands2 = (candidatePoolByPos[out2Meta.element_type] || [])
              .filter((c) => !currentSquadSet.has(c.id))
              .slice(0, top2CandLimit);

            for (const in1 of cands1) {
              for (const in2 of cands2) {
                if (in1.id === in2.id) continue;

                const budgetRes = applyZeroDriftBudget(
                  currentBank,
                  [sell1, sell2],
                  [in1.now_cost, in2.now_cost]
                );
                if (!budgetRes.isAffordable) continue;

                const candidateSquadIds = currentSquadIds
                  .filter((id) => id !== out1Id && id !== out2Id)
                  .concat([in1.id, in2.id])
                  .sort((a, b) => a - b);

                const squadPlayersForClubCheck = candidateSquadIds.map((id) => {
                  const meta = allPlayerMetaMap.get(id);
                  return { team: meta?.team ?? (id === in1.id ? in1.team : in2.team) };
                });

                if (!isClubConstraintValid(squadPlayersForClubCheck).isValid) continue;

                const hitCost = calculateHitCost(2, currentFT);
                const discountedHit = roundTo(hitCost * stageDiscount, 4);
                const nextFT = nextGameweekFT(currentFT, 2);

                const evalLineup = getCachedLineup(candidateSquadIds, gwOffset);
                const discountedGwScore = roundTo(evalLineup.gwTeamTotal * stageDiscount, 4);

                const newValuations = new Map(node.state.player_valuations);
                newValuations.delete(out1Id);
                newValuations.delete(out2Id);
                newValuations.set(in1.id, {
                  id: in1.id,
                  selling_price: in1.now_cost,
                  purchase_price: in1.now_cost,
                });
                newValuations.set(in2.id, {
                  id: in2.id,
                  selling_price: in2.now_cost,
                  purchase_price: in2.now_cost,
                });

                const actionStep: SequentialStepAction = {
                  gameweek: currentGw,
                  transfers_out_ids: [out1Id, out2Id],
                  transfers_in_ids: [in1.id, in2.id],
                  transfer_count: 2,
                  free_transfers_available_before: currentFT,
                  free_transfers_used: Math.min(2, currentFT),
                  paid_transfers: Math.max(0, 2 - currentFT),
                  hit_cost: hitCost,
                  bank_before: currentBank,
                  bank_after: budgetRes.newBank,
                  action_label: `OUT:${out1Meta.web_name},${out2Meta.web_name} -> IN:${in1.web_name},${in2.web_name}`,
                };

                const childNode: TrajectoryNode = {
                  stage: stage + 1,
                  node_id: `${node.node_id}_2T_${out1Id}_${out2Id}`,
                  parent_node_id: node.node_id,
                  cumulative_points: roundTo(
                    node.cumulative_points + discountedGwScore - discountedHit,
                    4
                  ),
                  cumulative_hit_cost: node.cumulative_hit_cost + hitCost,
                  cumulative_transfers: node.cumulative_transfers + 2,
                  action_history: [...node.action_history, actionStep],
                  state: {
                    gameweek: currentGw + 1,
                    squad_ids: candidateSquadIds,
                    bank: budgetRes.newBank,
                    available_ft: nextFT,
                    player_valuations: newValuations,
                  },
                };
                candidateNodes.push(childNode);
              }
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // Stage Pruning: Group by squad and prune dominated nodes
    // ------------------------------------------------------------------------
    const squadGroups = new Map<string, TrajectoryNode[]>();
    for (const cand of candidateNodes) {
      const key = cand.state.squad_ids.join(",");
      const group = squadGroups.get(key) || [];
      group.push(cand);
      squadGroups.set(key, group);
    }

    const undominatedNodes: TrajectoryNode[] = [];
    for (const group of squadGroups.values()) {
      if (group.length === 1) {
        undominatedNodes.push(group[0]);
        continue;
      }

      for (let i = 0; i < group.length; i++) {
        const candidate = group[i];
        let dominated = false;
        for (let j = 0; j < group.length; j++) {
          if (i === j) continue;
          if (isStateDominated(candidate, group[j])) {
            dominated = true;
            break;
          }
        }
        if (!dominated) {
          undominatedNodes.push(candidate);
        }
      }
    }

    // ------------------------------------------------------------------------
    // Beam Truncation: Sort by cumulative points descending and retain top K
    // ------------------------------------------------------------------------
    undominatedNodes.sort((a, b) => {
      const diffPoints = b.cumulative_points - a.cumulative_points;
      if (Math.abs(diffPoints) > EPSILON) {
        return diffPoints > 0 ? 1 : -1;
      }
      const diffHits = a.cumulative_hit_cost - b.cumulative_hit_cost;
      if (diffHits !== 0) {
        return diffHits > 0 ? 1 : -1;
      }
      const diffTransfers = a.cumulative_transfers - b.cumulative_transfers;
      if (diffTransfers !== 0) {
        return diffTransfers > 0 ? 1 : -1;
      }
      const diffBank = b.state.bank - a.state.bank;
      if (Math.abs(diffBank) > 0.01) {
        return diffBank > 0 ? 1 : -1;
      }
      const diffFT = b.state.available_ft - a.state.available_ft;
      if (diffFT !== 0) {
        return diffFT > 0 ? 1 : -1;
      }
      return a.node_id.localeCompare(b.node_id);
    });

    currentBeam = undominatedNodes.slice(0, beamWidth);
  }

  // 8. Select Best Trajectory from Final Beam
  const bestNode = currentBeam[0];

  // 9. Build GW Breakdown
  const gwBreakdown: NonNullable<SequentialPlan["gw_breakdown"]> = [];
  let currentSquadTracker = [...initialSquadIds];

  for (let s = 0; s < horizon; s++) {
    const step = bestNode.action_history[s];
    const gwOffset = s + 1;
    const stageDiscount = roundTo(Math.pow(discountFactor, s), 6);

    // Apply step transfers to squad tracker
    if (step.transfers_out_ids.length > 0) {
      currentSquadTracker = currentSquadTracker
        .filter((id) => !step.transfers_out_ids.includes(id))
        .concat(step.transfers_in_ids)
        .sort((a, b) => a - b);
    }

    const evalGw = getCachedLineup(currentSquadTracker, gwOffset);
    const discPts = roundTo(evalGw.gwTeamTotal * stageDiscount, 4);
    const discHit = roundTo(step.hit_cost * stageDiscount, 4);
    const netPts = roundTo(discPts - discHit, 4);
    const ftAfter = nextGameweekFT(step.free_transfers_available_before, step.transfer_count);

    gwBreakdown.push({
      gameweek: step.gameweek,
      gw_offset: gwOffset,
      action_label: step.action_label,
      starting_xi_points: evalGw.startingXiXpts,
      captain: evalGw.bestPair?.captain
        ? {
            id: evalGw.bestPair.captain.id,
            web_name: evalGw.bestPair.captain.web_name,
            bonus_points: evalGw.captaincyBonus,
          }
        : undefined,
      team_points: evalGw.gwTeamTotal,
      discounted_points: discPts,
      hit_cost: step.hit_cost,
      discounted_hit_cost: discHit,
      net_points: netPts,
      available_ft_after: ftAfter,
      bank_after: step.bank_after,
    });
  }

  const firstStep = bestNode.action_history[0];
  const urgencyAssessment = assessTransferUrgency({
    transfersIn: firstStep ? firstStep.transfers_in_ids.map((id) => allPlayerMetaMap.get(id) || { id }) : [],
    transfersOut: firstStep ? firstStep.transfers_out_ids.map((id) => allPlayerMetaMap.get(id) || { id }) : [],
    bankAfter: firstStep ? firstStep.bank_after : bankInM,
    allPlayerMetaMap,
  });

  return {
    plan_id: `SEQ-PLAN-GW${startGw}-H${horizon}`,
    horizon,
    total_discounted_points: roundTo(bestNode.cumulative_points, 2),
    total_hit_cost: bestNode.cumulative_hit_cost,
    total_transfers: bestNode.cumulative_transfers,
    trajectory_steps: bestNode.action_history,
    final_state: {
      squad_ids: bestNode.state.squad_ids,
      bank: roundTo(bestNode.state.bank, 1),
      available_ft: bestNode.state.available_ft,
    },
    metadata: {
      engine_version: SEQUENTIAL_ENGINE_VERSION,
      price_model: SEQUENTIAL_PRICE_MODEL,
      search_scope: SEQUENTIAL_SEARCH_SCOPE,
      global_optimality: "NOT_PROVEN",
    },
    financial_state_validity: "VALID",
    gw_breakdown: gwBreakdown,
    urgency_assessment: urgencyAssessment,
  };
}
