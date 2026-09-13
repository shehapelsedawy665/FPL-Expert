import {
  DataValidity,
  DataValue,
  PredictionSnapshot,
  GameweekBoundary,
} from "./prediction_contract";
import {
  CanonicalPlayerFeatures,
  buildPlayerPredictionFeatures,
} from "./prediction_features";
import {
  PlayerMinutesModelResult,
  MINUTES_MODEL_VERSION_V1_1,
  buildPlayerExpectedMinutes,
} from "./expected_minutes_model";
import {
  PlayerExpectedPointsResult,
  EXPECTED_POINTS_MODEL_VERSION,
  buildPlayerExpectedPoints,
} from "./expected_points_model";
import {
  CalibratedExpectedPointsResult,
  CalibrationStatus,
} from "./calibration_service";

export const DECISION_ENGINE_VERSION_V1 = "6a.1.0";
export const EPSILON = 1e-9;
export const APP_PROB_EPSILON = 0.05;

export const LEGAL_FORMATIONS: Array<[number, number, number]> = [
  [3, 4, 3],
  [3, 5, 2],
  [4, 3, 3],
  [4, 4, 2],
  [4, 5, 1],
  [5, 2, 3],
  [5, 3, 2],
  [5, 4, 1],
];

export const POSITION_LIMITS = {
  GKP: { min_start: 1, max_start: 1, total_squad: 2, element_type: 1 },
  DEF: { min_start: 3, max_start: 5, total_squad: 5, element_type: 2 },
  MID: { min_start: 2, max_start: 5, total_squad: 5, element_type: 3 },
  FWD: { min_start: 1, max_start: 3, total_squad: 3, element_type: 4 },
};

export const POSITION_NAMES: Record<number, string> = {
  1: "GKP",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

export interface DecisionSquadPlayer {
  id: number;
  web_name: string;
  element_type: number; // 1=GKP, 2=DEF, 3=MID, 4=FWD
  position_short_name: string;
  team_id?: number;
  team_short_name?: string;
  status?: string;
  news?: string;
  chance_of_playing_next_round?: number | null;
  fixture_count: number;
  fixtures_summary?: Array<{
    opponent_short_name: string;
    is_home: boolean;
    difficulty: number;
  }>;

  // Phase 3.1 Expected Minutes outputs
  expected_minutes: number;
  probability_available: number;
  probability_appearance: number;
  probability_start: number;
  probability_60_plus_minutes: number;

  // Phase 4 & Phase 5 Expected Points outputs
  raw_expected_points: number;
  calibrated_expected_points?: number | null;
  calibration_status?: CalibrationStatus | string;

  // Resolved usable decision value
  decision_expected_points: number;

  // Legacy comparison scores (preserved for explainability/regression)
  expert_score?: number;
  future_fpl_score?: number;
  current_form_score?: number;
  expected_minutes_proxy?: number;

  // Raw models results for reference
  minutes_result?: PlayerMinutesModelResult;
  points_result?: PlayerExpectedPointsResult;
  calibrated_points_result?: CalibratedExpectedPointsResult | null;
}

export interface FormationEvaluation {
  formation: [number, number, number];
  formation_label: string;
  starters: DecisionSquadPlayer[];
  total_decision_expected_points: number;
  is_legal: boolean;
  difference_from_best: number;
}

export interface BenchPermutationEvaluation {
  permutation: DecisionSquadPlayer[];
  permutation_ids: number[];
  permutation_names: string[];
  expected_replacement_utility: number;
  slot_weighted_xpts: number;
  simulation_details: Array<{
    starter_absent_id: number;
    starter_absent_name: string;
    starter_p_dnp: number;
    sub_used_id: number | null;
    sub_used_name: string | null;
    sub_replacement_xpts: number;
    resulting_formation: string;
    is_formation_legal: boolean;
  }>;
}

export interface CaptaincyPairEvaluation {
  captain: DecisionSquadPlayer;
  vice_captain: DecisionSquadPlayer;
  captain_unconditional_xpts: number;
  captain_p_appearance: number;
  vice_unconditional_xpts: number;
  vice_p_appearance: number;
  expected_captaincy_bonus: number;
  difference_from_best: number;
  reason: string;
}

export interface AutoSubSimulationResult {
  scenario_name: string;
  absent_starters: DecisionSquadPlayer[];
  starting_xi_before: DecisionSquadPlayer[];
  final_lineup: DecisionSquadPlayer[];
  final_formation: string;
  is_final_formation_legal: boolean;
  substitutions_made: Array<{
    starter_out: DecisionSquadPlayer;
    bench_in: DecisionSquadPlayer;
    bench_slot: number;
    reason: string;
  }>;
  unresolved_absences: DecisionSquadPlayer[];
}

export interface DecisionEngineResult {
  snapshot_id: string;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;

  // Recommended Lineup
  recommended_formation: [number, number, number];
  recommended_formation_label: string;
  starting_xi: DecisionSquadPlayer[];
  starting_xi_total_xpts: number;

  // Bench
  bench_goalkeeper: DecisionSquadPlayer | null;
  ordered_outfield_bench: DecisionSquadPlayer[];

  // Captaincy
  captain: DecisionSquadPlayer;
  vice_captain: DecisionSquadPlayer;
  captaincy_bonus: number;

  // Diagnostics & Explainability
  all_formations: FormationEvaluation[];
  formation_margin: number; // Best formation xPts minus 2nd best formation xPts
  runner_up_formation_label: string;

  bench_permutations: BenchPermutationEvaluation[];
  best_bench_utility: number;
  runner_up_bench_utility_margin: number;

  captaincy_pairs: CaptaincyPairEvaluation[];
  captaincy_margin: number; // Best pair bonus minus 2nd best pair bonus
  runner_up_captain_pair: { captain_name: string; vice_name: string } | null;

  player_diagnostics: Array<{
    player_id: number;
    web_name: string;
    position: string;
    status: "STARTING_XI" | "BENCH_GK" | "BENCH_OUTFIELD_1" | "BENCH_OUTFIELD_2" | "BENCH_OUTFIELD_3";
    decision_expected_points: number;
    expected_minutes: number;
    probability_start: number;
    probability_appearance: number;
    fixtures_count: number;
    selection_reason: string;
  }>;

  auto_sub_simulations: AutoSubSimulationResult[];

  // Legacy comparison
  legacy_comparison: {
    legacy_formation: string;
    legacy_starting_ids: number[];
    legacy_captain_id: number | null;
    legacy_vice_id: number | null;
    legacy_bench_ids: number[];
    is_identical_lineup: boolean;
    is_identical_captain: boolean;
    xpts_difference_predictive_vs_legacy: number;
    players_changed: Array<{
      player_id: number;
      web_name: string;
      in_predictive: "START" | "BENCH";
      in_legacy: "START" | "BENCH";
      predictive_xpts: number;
      legacy_expert_score: number;
      reason: string;
    }>;
  };
}

/**
 * Standard rounding helper
 */
export function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Resolve usable Expected Points for a player according to Phase 6A rules.
 */
export function resolveDecisionExpectedPoints(player: {
  raw_expected_points?: number | null;
  calibrated_expected_points?: number | null;
  calibration_status?: CalibrationStatus | string | null;
  fixture_count?: number;
}): number {
  if (player.fixture_count === 0) {
    return 0.0;
  }

  const isCalibratedActive =
    player.calibration_status === CalibrationStatus.CALIBRATED ||
    player.calibration_status === "calibrated" ||
    player.calibration_status === "active";

  if (
    isCalibratedActive &&
    player.calibrated_expected_points !== undefined &&
    player.calibrated_expected_points !== null &&
    !isNaN(player.calibrated_expected_points)
  ) {
    return roundTo(player.calibrated_expected_points, 2);
  }

  const raw = player.raw_expected_points ?? 0.0;
  return isNaN(raw) ? 0.0 : roundTo(raw, 2);
}

/**
 * Deterministic tiebreaker for player comparisons:
 * 1. higher decision_expected_points
 * 2. higher P(appearance)
 * 3. higher P(start)
 * 4. higher expected_minutes
 * 5. lower player ID
 */
export function comparePlayersForSelection(
  a: DecisionSquadPlayer,
  b: DecisionSquadPlayer
): number {
  const diffXpts = b.decision_expected_points - a.decision_expected_points;
  if (Math.abs(diffXpts) > EPSILON) {
    return diffXpts > 0 ? 1 : -1;
  }

  const diffApp = b.probability_appearance - a.probability_appearance;
  if (Math.abs(diffApp) > EPSILON) {
    return diffApp > 0 ? 1 : -1;
  }

  const diffStart = b.probability_start - a.probability_start;
  if (Math.abs(diffStart) > EPSILON) {
    return diffStart > 0 ? 1 : -1;
  }

  const diffMins = b.expected_minutes - a.expected_minutes;
  if (Math.abs(diffMins) > EPSILON) {
    return diffMins > 0 ? 1 : -1;
  }

  return a.id - b.id;
}

/**
 * Verify if an 11-player lineup conforms to legal FPL formation constraints.
 */
export function isFormationLegal(players: DecisionSquadPlayer[]): boolean {
  if (players.length !== 11) return false;

  let gkpCount = 0;
  let defCount = 0;
  let midCount = 0;
  let fwdCount = 0;

  for (const p of players) {
    if (p.element_type === 1) gkpCount++;
    else if (p.element_type === 2) defCount++;
    else if (p.element_type === 3) midCount++;
    else if (p.element_type === 4) fwdCount++;
  }

  return (
    gkpCount === 1 &&
    defCount >= 3 &&
    defCount <= 5 &&
    midCount >= 2 &&
    midCount <= 5 &&
    fwdCount >= 1 &&
    fwdCount <= 3 &&
    defCount + midCount + fwdCount === 10
  );
}

/**
 * Evaluate all 8 legal formations and find the optimal Starting XI maximizing SUM(decision_expected_points).
 */
export function optimizeStartingXi(
  squad: DecisionSquadPlayer[]
): {
  best_formation: FormationEvaluation;
  all_formations: FormationEvaluation[];
  formation_margin: number;
  runner_up_formation_label: string;
} {
  const gks = squad.filter((p) => p.element_type === 1).sort(comparePlayersForSelection);
  const defs = squad.filter((p) => p.element_type === 2).sort(comparePlayersForSelection);
  const mids = squad.filter((p) => p.element_type === 3).sort(comparePlayersForSelection);
  const fwds = squad.filter((p) => p.element_type === 4).sort(comparePlayersForSelection);

  const chosenGk = gks[0];

  const evaluations: FormationEvaluation[] = [];

  for (const [defCount, midCount, fwdCount] of LEGAL_FORMATIONS) {
    const formationLabel = `${defCount}-${midCount}-${fwdCount}`;
    const selectedDefs = defs.slice(0, defCount);
    const selectedMids = mids.slice(0, midCount);
    const selectedFwds = fwds.slice(0, fwdCount);

    const hasEnoughPlayers =
      chosenGk &&
      selectedDefs.length === defCount &&
      selectedMids.length === midCount &&
      selectedFwds.length === fwdCount;

    if (!hasEnoughPlayers) {
      evaluations.push({
        formation: [defCount, midCount, fwdCount],
        formation_label: formationLabel,
        starters: [],
        total_decision_expected_points: 0,
        is_legal: false,
        difference_from_best: 0,
      });
      continue;
    }

    const starters = [chosenGk, ...selectedDefs, ...selectedMids, ...selectedFwds];
    const totalXpts = roundTo(
      starters.reduce((sum, p) => sum + p.decision_expected_points, 0),
      2
    );

    evaluations.push({
      formation: [defCount, midCount, fwdCount],
      formation_label: formationLabel,
      starters,
      total_decision_expected_points: totalXpts,
      is_legal: isFormationLegal(starters),
      difference_from_best: 0,
    });
  }

  // Sort formations: highest xPts first, then deterministic tiebreaking by formation label
  evaluations.sort((a, b) => {
    const diff = b.total_decision_expected_points - a.total_decision_expected_points;
    if (Math.abs(diff) > EPSILON) {
      return diff > 0 ? 1 : -1;
    }
    return a.formation_label.localeCompare(b.formation_label);
  });

  const bestFormation = evaluations[0];
  const runnerUp = evaluations.length > 1 ? evaluations[1] : bestFormation;
  const formationMargin = roundTo(
    bestFormation.total_decision_expected_points - runnerUp.total_decision_expected_points,
    2
  );

  for (const ev of evaluations) {
    ev.difference_from_best = roundTo(
      bestFormation.total_decision_expected_points - ev.total_decision_expected_points,
      2
    );
  }

  return {
    best_formation: bestFormation,
    all_formations: evaluations,
    formation_margin: formationMargin,
    runner_up_formation_label: runnerUp.formation_label,
  };
}

/**
 * Generate all permutations of an array of items.
 */
function getPermutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const current = items[i];
    const remaining = [...items.slice(0, i), ...items.slice(i + 1)];
    const perms = getPermutations(remaining);
    for (const p of perms) {
      result.push([current, ...p]);
    }
  }
  return result;
}

/**
 * Simulate single starter DNP substitution for a proposed bench permutation.
 * Checks if substituting `starterAbsent` with a candidate bench sub keeps the 11-player lineup legal.
 */
export function simulateSingleDnpReplacement(
  startingXi: DecisionSquadPlayer[],
  starterAbsent: DecisionSquadPlayer,
  proposedBench: DecisionSquadPlayer[]
): {
  subUsed: DecisionSquadPlayer | null;
  resultingLineup: DecisionSquadPlayer[];
  isLegal: boolean;
  resultingFormationLabel: string;
} {
  const outfieldStarters = startingXi.filter((p) => p.element_type !== 1);
  const remainingStarters = startingXi.filter((p) => p.id !== starterAbsent.id);

  if (starterAbsent.element_type === 1) {
    // Goalkeeper non-appearance can ONLY be replaced by bench GK, handled separately.
    return {
      subUsed: null,
      resultingLineup: remainingStarters,
      isLegal: false,
      resultingFormationLabel: "Invalid (Missing GKP)",
    };
  }

  for (const candidateSub of proposedBench) {
    const testLineup = [...remainingStarters, candidateSub];
    if (isFormationLegal(testLineup)) {
      const defs = testLineup.filter((p) => p.element_type === 2).length;
      const mids = testLineup.filter((p) => p.element_type === 3).length;
      const fwds = testLineup.filter((p) => p.element_type === 4).length;
      return {
        subUsed: candidateSub,
        resultingLineup: testLineup,
        isLegal: true,
        resultingFormationLabel: `${defs}-${mids}-${fwds}`,
      };
    }
  }

  return {
    subUsed: null,
    resultingLineup: remainingStarters,
    isLegal: false,
    resultingFormationLabel: "No Legal Substitution",
  };
}

/**
 * Optimize the order of the 3 outfield bench players by maximizing probability-weighted expected replacement utility.
 */
export function optimizeOutfieldBenchOrder(
  startingXi: DecisionSquadPlayer[],
  outfieldBench: DecisionSquadPlayer[]
): {
  best_order: DecisionSquadPlayer[];
  all_permutations: BenchPermutationEvaluation[];
  best_utility: number;
  runner_up_margin: number;
} {
  const permutations = getPermutations(outfieldBench);
  const outfieldStarters = startingXi.filter((p) => p.element_type !== 1);

  const evaluations: BenchPermutationEvaluation[] = [];

  for (const perm of permutations) {
    let totalUtility = 0.0;
    const simDetails: BenchPermutationEvaluation["simulation_details"] = [];

    for (const starter of outfieldStarters) {
      const pDnp = roundTo(1.0 - starter.probability_appearance, 4);
      const sim = simulateSingleDnpReplacement(startingXi, starter, perm);

      const replacementXpts = sim.subUsed ? sim.subUsed.decision_expected_points : 0.0;
      const contribution = pDnp * replacementXpts;
      totalUtility += contribution;

      simDetails.push({
        starter_absent_id: starter.id,
        starter_absent_name: starter.web_name,
        starter_p_dnp: pDnp,
        sub_used_id: sim.subUsed?.id ?? null,
        sub_used_name: sim.subUsed?.web_name ?? null,
        sub_replacement_xpts: replacementXpts,
        resulting_formation: sim.resultingFormationLabel,
        is_formation_legal: sim.isLegal,
      });
    }

    const slotWeightedXpts = roundTo(
      (perm[0]?.decision_expected_points ?? 0) * 3.0 +
        (perm[1]?.decision_expected_points ?? 0) * 2.0 +
        (perm[2]?.decision_expected_points ?? 0) * 1.0,
      3
    );

    evaluations.push({
      permutation: perm,
      permutation_ids: perm.map((p) => p.id),
      permutation_names: perm.map((p) => p.web_name),
      expected_replacement_utility: roundTo(totalUtility, 4),
      slot_weighted_xpts: slotWeightedXpts,
      simulation_details: simDetails,
    });
  }

  // Sort permutations:
  // 1. higher expected_replacement_utility
  // 2. higher slot-weighted xpts
  // 3. deterministic player IDs
  evaluations.sort((a, b) => {
    const diffUtil = b.expected_replacement_utility - a.expected_replacement_utility;
    if (Math.abs(diffUtil) > EPSILON) {
      return diffUtil > 0 ? 1 : -1;
    }
    const diffSlot = b.slot_weighted_xpts - a.slot_weighted_xpts;
    if (Math.abs(diffSlot) > EPSILON) {
      return diffSlot > 0 ? 1 : -1;
    }
    const strA = a.permutation_ids.join("-");
    const strB = b.permutation_ids.join("-");
    return strA.localeCompare(strB);
  });

  const best = evaluations[0];
  const runnerUp = evaluations.length > 1 ? evaluations[1] : best;
  const margin = roundTo(best.expected_replacement_utility - runnerUp.expected_replacement_utility, 4);

  return {
    best_order: best.permutation,
    all_permutations: evaluations,
    best_utility: best.expected_replacement_utility,
    runner_up_margin: margin,
  };
}

/**
 * Sequential FPL Auto-Sub Engine for 1, 2, or 3 starter non-appearances.
 */
export function simulateAutoSubSequential(
  startingXi: DecisionSquadPlayer[],
  absentStarters: DecisionSquadPlayer[],
  benchGk: DecisionSquadPlayer | null,
  orderedOutfieldBench: DecisionSquadPlayer[],
  scenarioName: string = "Simulation"
): AutoSubSimulationResult {
  let currentLineup = [...startingXi];
  const substitutionsMade: AutoSubSimulationResult["substitutions_made"] = [];
  const unresolved: DecisionSquadPlayer[] = [];

  const usedBenchIds = new Set<number>();

  for (const absent of absentStarters) {
    if (absent.element_type === 1) {
      // Goalkeeper replacement
      if (benchGk && !usedBenchIds.has(benchGk.id) && benchGk.probability_appearance > 0) {
        currentLineup = currentLineup.map((p) => (p.id === absent.id ? benchGk : p));
        usedBenchIds.add(benchGk.id);
        substitutionsMade.push({
          starter_out: absent,
          bench_in: benchGk,
          bench_slot: 0,
          reason: "Starting Goalkeeper DNP -> Bench Goalkeeper entered directly.",
        });
      } else {
        currentLineup = currentLineup.filter((p) => p.id !== absent.id);
        unresolved.push(absent);
      }
    } else {
      // Outfield replacement
      let substituted = false;
      const currentWithoutAbsent = currentLineup.filter((p) => p.id !== absent.id);

      for (let slot = 0; slot < orderedOutfieldBench.length; slot++) {
        const sub = orderedOutfieldBench[slot];
        if (usedBenchIds.has(sub.id)) continue;

        const testLineup = [...currentWithoutAbsent, sub];
        if (isFormationLegal(testLineup)) {
          currentLineup = testLineup;
          usedBenchIds.add(sub.id);
          substitutionsMade.push({
            starter_out: absent,
            bench_in: sub,
            bench_slot: slot + 1,
            reason: `Starter ${absent.web_name} (${absent.position_short_name}) DNP -> Bench #${slot + 1} ${sub.web_name} (${sub.position_short_name}) entered preserving legal formation.`,
          });
          substituted = true;
          break;
        }
      }

      if (!substituted) {
        currentLineup = currentWithoutAbsent;
        unresolved.push(absent);
      }
    }
  }

  const defs = currentLineup.filter((p) => p.element_type === 2).length;
  const mids = currentLineup.filter((p) => p.element_type === 3).length;
  const fwds = currentLineup.filter((p) => p.element_type === 4).length;
  const finalFormation = currentLineup.length === 11 ? `${defs}-${mids}-${fwds}` : `Incomplete (${currentLineup.length} players)`;

  return {
    scenario_name: scenarioName,
    absent_starters: absentStarters,
    starting_xi_before: startingXi,
    final_lineup: currentLineup,
    final_formation: finalFormation,
    is_final_formation_legal: isFormationLegal(currentLineup),
    substitutions_made: substitutionsMade,
    unresolved_absences: unresolved,
  };
}

/**
 * Evaluate expected captaincy bonus for all ordered pairs (C, V) in Starting XI.
 * Joint expectation formula:
 * CaptainBonus(C, V) = P(app_C) * E[Pts_C | app] + (1 - P(app_C)) * P(app_V) * E[Pts_V | app]
 * Under the unconditional relation:
 * P(app) * E[Pts | app] = decision_expected_points
 * CaptainBonus(C, V) = decision_expected_points_C + (1 - P(app_C)) * decision_expected_points_V
 */
export function evaluateCaptaincyPairs(
  startingXi: DecisionSquadPlayer[]
): {
  best_pair: CaptaincyPairEvaluation;
  all_pairs: CaptaincyPairEvaluation[];
  captaincy_margin: number;
} {
  const eligibleCandidates = startingXi.filter((p) => {
    if (p.fixture_count === 0 && startingXi.some((other) => other.fixture_count > 0)) {
      return false; // Skip BGW if others have fixtures
    }
    const status = p.status?.toLowerCase();
    if (status === "i" || status === "n" || status === "s") return false;
    return true;
  });

  const pool = eligibleCandidates.length >= 2 ? eligibleCandidates : startingXi;
  const pairs: CaptaincyPairEvaluation[] = [];

  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const cap = pool[i];
      const vice = pool[j];

      const pAppC = cap.probability_appearance;
      const xptsC = cap.decision_expected_points;

      const pAppV = vice.probability_appearance;
      const xptsV = vice.decision_expected_points;

      // Safe conditional expectation derivation:
      // When P(app) >= APP_PROB_EPSILON, E[Pts|app] = xpts / P(app).
      // Joint bonus = P(app_C)*E[Pts_C|app] + (1 - P(app_C))*P(app_V)*E[Pts_V|app]
      // Mathematically = xptsC + (1 - pAppC) * xptsV
      let expPtsGivenAppC = xptsC;
      if (pAppC >= APP_PROB_EPSILON) {
        expPtsGivenAppC = roundTo(xptsC / pAppC, 3);
      }
      let expPtsGivenAppV = xptsV;
      if (pAppV >= APP_PROB_EPSILON) {
        expPtsGivenAppV = roundTo(xptsV / pAppV, 3);
      }

      const cContrib = roundTo(pAppC >= APP_PROB_EPSILON ? pAppC * expPtsGivenAppC : xptsC, 4);
      const vContrib = roundTo((1.0 - pAppC) * (pAppV >= APP_PROB_EPSILON ? pAppV * expPtsGivenAppV : xptsV), 4);
      const jointBonus = roundTo(cContrib + vContrib, 3);

      let reason = `Captain ${cap.web_name} provides ${xptsC.toFixed(2)} unconditional xPts (P(app)=${pAppC.toFixed(2)}). Vice ${vice.web_name} provides hedge utility (${xptsV.toFixed(2)} xPts) yielding ${jointBonus.toFixed(2)} joint expected captaincy bonus.`;

      pairs.push({
        captain: cap,
        vice_captain: vice,
        captain_unconditional_xpts: xptsC,
        captain_p_appearance: pAppC,
        vice_unconditional_xpts: xptsV,
        vice_p_appearance: pAppV,
        expected_captaincy_bonus: jointBonus,
        difference_from_best: 0,
        reason,
      });
    }
  }

  // Sort pairs:
  // 1. higher expected_captaincy_bonus
  // 2. higher captain decision_expected_points
  // 3. higher captain P(appearance)
  // 4. higher captain P(60+)
  // 5. higher vice decision_expected_points
  // 6. lower captain ID
  // 7. lower vice ID
  pairs.sort((a, b) => {
    const diffBonus = b.expected_captaincy_bonus - a.expected_captaincy_bonus;
    if (Math.abs(diffBonus) > EPSILON) {
      return diffBonus > 0 ? 1 : -1;
    }
    const diffCapXpts = b.captain.decision_expected_points - a.captain.decision_expected_points;
    if (Math.abs(diffCapXpts) > EPSILON) {
      return diffCapXpts > 0 ? 1 : -1;
    }
    const diffCapApp = b.captain.probability_appearance - a.captain.probability_appearance;
    if (Math.abs(diffCapApp) > EPSILON) {
      return diffCapApp > 0 ? 1 : -1;
    }
    const diffCap60 = b.captain.probability_60_plus_minutes - a.captain.probability_60_plus_minutes;
    if (Math.abs(diffCap60) > EPSILON) {
      return diffCap60 > 0 ? 1 : -1;
    }
    const diffViceXpts = b.vice_captain.decision_expected_points - a.vice_captain.decision_expected_points;
    if (Math.abs(diffViceXpts) > EPSILON) {
      return diffViceXpts > 0 ? 1 : -1;
    }
    if (a.captain.id !== b.captain.id) {
      return a.captain.id - b.captain.id;
    }
    return a.vice_captain.id - b.vice_captain.id;
  });

  const bestPair = pairs[0];
  const runnerUp = pairs.length > 1 ? pairs[1] : bestPair;
  const margin = roundTo(bestPair.expected_captaincy_bonus - runnerUp.expected_captaincy_bonus, 3);

  for (const p of pairs) {
    p.difference_from_best = roundTo(bestPair.expected_captaincy_bonus - p.expected_captaincy_bonus, 3);
  }

  return {
    best_pair: bestPair,
    all_pairs: pairs,
    captaincy_margin: margin,
  };
}

/**
 * Execute Legacy Selection for side-by-side comparison without modifying underlying legacy scores.
 */
export function executeLegacySelection(
  squad: DecisionSquadPlayer[]
): {
  legacy_formation: string;
  legacy_starting_xi: DecisionSquadPlayer[];
  legacy_bench_gk: DecisionSquadPlayer | null;
  legacy_bench_outfield: DecisionSquadPlayer[];
  legacy_captain: DecisionSquadPlayer | null;
  legacy_vice_captain: DecisionSquadPlayer | null;
} {
  const gks = squad.filter((p) => p.element_type === 1).sort((a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0));
  const defs = squad.filter((p) => p.element_type === 2).sort((a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0));
  const mids = squad.filter((p) => p.element_type === 3).sort((a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0));
  const fwds = squad.filter((p) => p.element_type === 4).sort((a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0));

  const chosenGk = gks[0] || null;

  let bestScore = -1.0;
  let bestFormation: [number, number, number] = [3, 4, 3];
  let bestOutfield: DecisionSquadPlayer[] = [];

  for (const [defCount, midCount, fwdCount] of LEGAL_FORMATIONS) {
    const sDefs = defs.slice(0, defCount);
    const sMids = mids.slice(0, midCount);
    const sFwds = fwds.slice(0, fwdCount);

    if (sDefs.length === defCount && sMids.length === midCount && sFwds.length === fwdCount) {
      const line = [...sDefs, ...sMids, ...sFwds];
      const score = line.reduce((sum, p) => sum + (p.expert_score ?? 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestFormation = [defCount, midCount, fwdCount];
        bestOutfield = line;
      }
    }
  }

  const legacyStartingXi: DecisionSquadPlayer[] = [];
  if (chosenGk) legacyStartingXi.push(chosenGk);
  legacyStartingXi.push(...bestOutfield);

  const startingIds = new Set(legacyStartingXi.map((p) => p.id));
  const bench = squad.filter((p) => !startingIds.has(p.id));
  const benchGk = bench.find((p) => p.element_type === 1) || null;
  const benchOutfield = bench
    .filter((p) => p.element_type !== 1)
    .sort((a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0));

  const sortedByExpert = [...legacyStartingXi].sort(
    (a, b) => (b.expert_score ?? 0) - (a.expert_score ?? 0)
  );
  const cap = sortedByExpert[0] || null;
  const vice = sortedByExpert[1] || null;

  return {
    legacy_formation: `${bestFormation[0]}-${bestFormation[1]}-${bestFormation[2]}`,
    legacy_starting_xi: legacyStartingXi,
    legacy_bench_gk: benchGk,
    legacy_bench_outfield: benchOutfield,
    legacy_captain: cap,
    legacy_vice_captain: vice,
  };
}

/**
 * Main Phase 6A Decision Engine Entry Point.
 */
export function runFplDecisionEngine(options: {
  squad: DecisionSquadPlayer[];
  snapshot: PredictionSnapshot;
}): DecisionEngineResult {
  const { squad, snapshot } = options;

  if (squad.length !== 15) {
    throw new Error(`FPL Decision Engine requires exactly 15 squad players, received ${squad.length}`);
  }

  // 1. Optimize Starting XI across all legal formations
  const { best_formation, all_formations, formation_margin, runner_up_formation_label } =
    optimizeStartingXi(squad);

  const startingXi = best_formation.starters;
  const startingIds = new Set(startingXi.map((p) => p.id));
  const totalXiXpts = best_formation.total_decision_expected_points;

  // 2. Identify Bench Players
  const benchPlayers = squad.filter((p) => !startingIds.has(p.id));
  const benchGk = benchPlayers.find((p) => p.element_type === 1) || null;
  const outfieldBench = benchPlayers.filter((p) => p.element_type !== 1);

  // 3. Optimize Outfield Bench Order
  const {
    best_order: orderedOutfieldBench,
    all_permutations: benchPermutations,
    best_utility: bestBenchUtility,
    runner_up_margin: runnerUpBenchUtilityMargin,
  } = optimizeOutfieldBenchOrder(startingXi, outfieldBench);

  // 4. Optimize Captain & Vice-Captain Joint Expectation
  const {
    best_pair: bestCaptainPair,
    all_pairs: captaincyPairs,
    captaincy_margin: captaincyMargin,
  } = evaluateCaptaincyPairs(startingXi);

  // 5. Run Auto-Sub Simulations for Verification
  const outfieldStarters = startingXi.filter((p) => p.element_type !== 1);
  const defStarters = outfieldStarters.filter((p) => p.element_type === 2).sort((a, b) => a.probability_appearance - b.probability_appearance);
  const midStarters = outfieldStarters.filter((p) => p.element_type === 3).sort((a, b) => a.probability_appearance - b.probability_appearance);
  const fwdStarters = outfieldStarters.filter((p) => p.element_type === 4).sort((a, b) => a.probability_appearance - b.probability_appearance);

  const autoSubSimulations: AutoSubSimulationResult[] = [];

  // Sim 1: Highest P(DNP) DEF absent
  if (defStarters.length > 0) {
    autoSubSimulations.push(
      simulateAutoSubSequential(
        startingXi,
        [defStarters[0]],
        benchGk,
        orderedOutfieldBench,
        `Single DEF Absent (${defStarters[0].web_name}, P(DNP)=${roundTo(1 - defStarters[0].probability_appearance, 3)})`
      )
    );
  }

  // Sim 2: Highest P(DNP) MID absent
  if (midStarters.length > 0) {
    autoSubSimulations.push(
      simulateAutoSubSequential(
        startingXi,
        [midStarters[0]],
        benchGk,
        orderedOutfieldBench,
        `Single MID Absent (${midStarters[0].web_name}, P(DNP)=${roundTo(1 - midStarters[0].probability_appearance, 3)})`
      )
    );
  }

  // Sim 3: Highest P(DNP) FWD absent
  if (fwdStarters.length > 0) {
    autoSubSimulations.push(
      simulateAutoSubSequential(
        startingXi,
        [fwdStarters[0]],
        benchGk,
        orderedOutfieldBench,
        `Single FWD Absent (${fwdStarters[0].web_name}, P(DNP)=${roundTo(1 - fwdStarters[0].probability_appearance, 3)})`
      )
    );
  }

  // Sim 4: Two Starters Absent (highest DNP DEF and MID)
  const twoAbsent = [defStarters[0], midStarters[0]].filter(Boolean);
  if (twoAbsent.length === 2) {
    autoSubSimulations.push(
      simulateAutoSubSequential(
        startingXi,
        twoAbsent,
        benchGk,
        orderedOutfieldBench,
        `Two Starters Absent (${twoAbsent[0].web_name} & ${twoAbsent[1].web_name})`
      )
    );
  }

  // Sim 5: Three Starters Absent (highest DNP DEF, MID, FWD)
  const threeAbsent = [defStarters[0], midStarters[0], fwdStarters[0]].filter(Boolean);
  if (threeAbsent.length === 3) {
    autoSubSimulations.push(
      simulateAutoSubSequential(
        startingXi,
        threeAbsent,
        benchGk,
        orderedOutfieldBench,
        `Three Starters Absent (${threeAbsent.map((p) => p.web_name).join(", ")})`
      )
    );
  }

  // 6. Diagnostics & Explainability
  const playerDiagnostics: DecisionEngineResult["player_diagnostics"] = [];

  for (const starter of startingXi) {
    playerDiagnostics.push({
      player_id: starter.id,
      web_name: starter.web_name,
      position: starter.position_short_name,
      status: "STARTING_XI",
      decision_expected_points: starter.decision_expected_points,
      expected_minutes: starter.expected_minutes,
      probability_start: starter.probability_start,
      probability_appearance: starter.probability_appearance,
      fixtures_count: starter.fixture_count,
      selection_reason: `Selected in Starting XI: top positional Expected Points (${starter.decision_expected_points.toFixed(2)}) and optimal formation fit (${best_formation.formation_label}).`,
    });
  }

  if (benchGk) {
    playerDiagnostics.push({
      player_id: benchGk.id,
      web_name: benchGk.web_name,
      position: "GKP",
      status: "BENCH_GK",
      decision_expected_points: benchGk.decision_expected_points,
      expected_minutes: benchGk.expected_minutes,
      probability_start: benchGk.probability_start,
      probability_appearance: benchGk.probability_appearance,
      fixtures_count: benchGk.fixture_count,
      selection_reason: `Reserve Goalkeeper: Starting GK ${startingXi.find((p) => p.element_type === 1)?.web_name} selected on higher Expected Points (${startingXi.find((p) => p.element_type === 1)?.decision_expected_points.toFixed(2)} vs ${benchGk.decision_expected_points.toFixed(2)}).`,
    });
  }

  const benchSlotStatuses = ["BENCH_OUTFIELD_1", "BENCH_OUTFIELD_2", "BENCH_OUTFIELD_3"] as const;
  orderedOutfieldBench.forEach((bSub, idx) => {
    playerDiagnostics.push({
      player_id: bSub.id,
      web_name: bSub.web_name,
      position: bSub.position_short_name,
      status: benchSlotStatuses[idx],
      decision_expected_points: bSub.decision_expected_points,
      expected_minutes: bSub.expected_minutes,
      probability_start: bSub.probability_start,
      probability_appearance: bSub.probability_appearance,
      fixtures_count: bSub.fixture_count,
      selection_reason: `Bench slot #${idx + 1}: Expected replacement utility optimized across starting DNP scenarios (${bSub.decision_expected_points.toFixed(2)} xPts).`,
    });
  });

  // 7. Legacy Comparison
  const legacyResult = executeLegacySelection(squad);
  const legacyStartingIds = new Set(legacyResult.legacy_starting_xi.map((p) => p.id));
  const isIdenticalLineup =
    startingIds.size === legacyStartingIds.size &&
    [...startingIds].every((id) => legacyStartingIds.has(id));
  const isIdenticalCaptain =
    bestCaptainPair.captain.id === legacyResult.legacy_captain?.id &&
    bestCaptainPair.vice_captain.id === legacyResult.legacy_vice_captain?.id;

  const legacyXiXpts = roundTo(
    legacyResult.legacy_starting_xi.reduce((sum, p) => sum + p.decision_expected_points, 0),
    2
  );
  const xptsDiff = roundTo(totalXiXpts - legacyXiXpts, 2);

  const playersChanged: DecisionEngineResult["legacy_comparison"]["players_changed"] = [];
  for (const p of squad) {
    const inPred = startingIds.has(p.id) ? "START" : "BENCH";
    const inLeg = legacyStartingIds.has(p.id) ? "START" : "BENCH";
    if (inPred !== inLeg) {
      playersChanged.push({
        player_id: p.id,
        web_name: p.web_name,
        in_predictive: inPred,
        in_legacy: inLeg,
        predictive_xpts: p.decision_expected_points,
        legacy_expert_score: p.expert_score ?? 0,
        reason:
          inPred === "START"
            ? `Promoted to Starting XI in predictive model due to higher Expected Points (${p.decision_expected_points.toFixed(2)} vs legacy Expert Score ${p.expert_score?.toFixed(1)}).`
            : `Moved to Bench in predictive model because higher Expected Points were available elsewhere (${p.decision_expected_points.toFixed(2)} xPts).`,
      });
    }
  }

  const runnerUpPair =
    captaincyPairs.length > 1
      ? {
          captain_name: captaincyPairs[1].captain.web_name,
          vice_name: captaincyPairs[1].vice_captain.web_name,
        }
      : null;

  return {
    snapshot_id: snapshot.snapshot_id,
    prediction_gameweek: snapshot.boundary?.prediction_gameweek ?? null,
    historical_cutoff_gameweek: snapshot.boundary?.historical_cutoff_gameweek ?? null,

    recommended_formation: best_formation.formation,
    recommended_formation_label: best_formation.formation_label,
    starting_xi: startingXi,
    starting_xi_total_xpts: totalXiXpts,

    bench_goalkeeper: benchGk,
    ordered_outfield_bench: orderedOutfieldBench,

    captain: bestCaptainPair.captain,
    vice_captain: bestCaptainPair.vice_captain,
    captaincy_bonus: bestCaptainPair.expected_captaincy_bonus,

    all_formations,
    formation_margin: formation_margin,
    runner_up_formation_label: runner_up_formation_label,

    bench_permutations: benchPermutations,
    best_bench_utility: bestBenchUtility,
    runner_up_bench_utility_margin: runnerUpBenchUtilityMargin,

    captaincy_pairs: captaincyPairs,
    captaincy_margin: captaincyMargin,
    runner_up_captain_pair: runnerUpPair,

    player_diagnostics: playerDiagnostics,
    auto_sub_simulations: autoSubSimulations,

    legacy_comparison: {
      legacy_formation: legacyResult.legacy_formation,
      legacy_starting_ids: [...legacyStartingIds],
      legacy_captain_id: legacyResult.legacy_captain?.id ?? null,
      legacy_vice_id: legacyResult.legacy_vice_captain?.id ?? null,
      legacy_bench_ids: [
        legacyResult.legacy_bench_gk?.id,
        ...legacyResult.legacy_bench_outfield.map((p) => p.id),
      ].filter(Boolean) as number[],
      is_identical_lineup: isIdenticalLineup,
      is_identical_captain: isIdenticalCaptain,
      xpts_difference_predictive_vs_legacy: xptsDiff,
      players_changed: playersChanged,
    },
  };
}

/**
 * Build DecisionSquadPlayer instances from raw squad players, features, minutes, and points models.
 */
export function buildDecisionSquadFromPlayers(options: {
  players: Array<Record<string, any>>;
  snapshot: PredictionSnapshot;
  allFixtures?: Array<Record<string, any>> | null;
  allTeams?: Array<Record<string, any>> | null;
  playerHistories?: Record<number, Array<Record<string, any>>> | null;
}): DecisionSquadPlayer[] {
  const { players, snapshot, allFixtures = null, allTeams = null, playerHistories = null } = options;

  return players.map((p) => {
    const history = playerHistories ? playerHistories[p.id] || null : null;

    // 1. Build canonical features
    const features = buildPlayerPredictionFeatures({
      player: p,
      snapshot,
      history,
      allFixtures,
      allTeams,
    });

    // 2. Build Phase 3.1 Expected Minutes
    const minutesResult = buildPlayerExpectedMinutes({
      player: p,
      features,
      snapshot,
      history,
    });

    // 3. Build Phase 4 Expected Points
    const pointsResult = buildPlayerExpectedPoints({
      player: p,
      features,
      minutesResult,
      snapshot,
      history,
      allFixtures,
      allTeams,
    });

    const fixtureCount = features.fixtures.prediction_gw_fixture_count;
    const rawXpts = typeof pointsResult.expected_points_next_gameweek?.value === "number"
      ? pointsResult.expected_points_next_gameweek.value
      : (pointsResult.breakdown?.expected_points_next_gameweek ?? 0.0);
    const calStatus = CalibrationStatus.INSUFFICIENT_DATA; // Phase 5 currently inactive

    const decisionXpts = resolveDecisionExpectedPoints({
      raw_expected_points: rawXpts,
      calibrated_expected_points: null,
      calibration_status: calStatus,
      fixture_count: fixtureCount,
    });

    const fixturesSummary = features.fixtures.prediction_gw_fixtures.map((f) => {
      const oppTeam = allTeams?.find((t) => t.id === f.opponent_team_id);
      return {
        opponent_short_name: oppTeam?.short_name || `T${f.opponent_team_id}`,
        is_home: f.is_home,
        difficulty: f.difficulty,
      };
    });

    const positionShortName =
      POSITION_NAMES[p.element_type] || p.position_short_name || "MID";

    const expMins = typeof minutesResult.expected_minutes?.value === "number"
      ? minutesResult.expected_minutes.value
      : (minutesResult.breakdown?.minutes_decomposition?.total_expected_minutes ?? 0.0);

    const pAvail = typeof minutesResult.probability_available?.value === "number"
      ? minutesResult.probability_available.value
      : (minutesResult.breakdown?.probabilities?.probability_available ?? 1.0);

    const pApp = typeof minutesResult.probability_appearance?.value === "number"
      ? minutesResult.probability_appearance.value
      : (minutesResult.breakdown?.probabilities?.probability_appearance ?? 0.0);

    const pStart = typeof minutesResult.probability_start?.value === "number"
      ? minutesResult.probability_start.value
      : (minutesResult.breakdown?.probabilities?.probability_start ?? 0.0);

    const p60 = typeof minutesResult.probability_60_plus_minutes?.value === "number"
      ? minutesResult.probability_60_plus_minutes.value
      : (minutesResult.breakdown?.probabilities?.probability_60_plus_minutes ?? 0.0);

    return {
      id: p.id,
      web_name: p.web_name || `Player ${p.id}`,
      element_type: p.element_type,
      position_short_name: positionShortName,
      team_id: p.team,
      team_short_name: p.team_short_name,
      status: p.status,
      news: p.news,
      chance_of_playing_next_round: p.chance_of_playing_next_round,
      fixture_count: fixtureCount,
      fixtures_summary: fixturesSummary,

      expected_minutes: expMins,
      probability_available: pAvail,
      probability_appearance: pApp,
      probability_start: pStart,
      probability_60_plus_minutes: p60,

      raw_expected_points: rawXpts,
      calibrated_expected_points: null,
      calibration_status: calStatus,
      decision_expected_points: decisionXpts,

      expert_score: p.expert_score,
      future_fpl_score: p.future_fpl_score,
      current_form_score: p.current_form_score,
      expected_minutes_proxy: p.expected_minutes_proxy,

      minutes_result: minutesResult,
      points_result: pointsResult,
      calibrated_points_result: null,
    };
  });
}

