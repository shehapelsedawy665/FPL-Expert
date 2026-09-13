import {
  DataValidity,
  DataValue,
  DataValueDict,
  GameweekBoundary,
  PredictionSnapshot,
  PredictionOutput,
  PredictionRange,
  LEGACY_RANK_SCORE_SOURCE,
} from "./prediction_contract.js";
import {
  CanonicalPlayerFeatures,
  FixtureContextItem,
  SetPieceRole,
} from "./prediction_features.js";
import {
  PlayerMinutesModelResult,
  MinutesModelBreakdown,
  buildPlayerExpectedMinutes,
} from "./expected_minutes_model.js";

export const FPL_SCORING_RULES_VERSION = "2026-27.v1";
export const EXPECTED_POINTS_MODEL_VERSION = "expected-points.v1";

// ============================================================================
// 1. OFFICIAL FPL SCORING RULES DEFINITION (2026/27)
// ============================================================================

export interface ScoringRuleSet {
  rules_version: string;
  appearance_under_60: number;
  appearance_60_plus: number;
  goal_by_position: Record<number, number>; // 1: GKP, 2: DEF, 3: MID, 4: FWD
  assist: number;
  clean_sheet_by_position: Record<number, number>; // 1: GKP, 2: DEF, 3: MID, 4: FWD
  save_points_per_block: number;
  saves_per_block_threshold: number;
  penalty_save: number;
  penalty_miss: number;
  goals_conceded_deduction_per_block: number;
  goals_conceded_block_threshold: number;
  goals_conceded_deduction_positions: number[]; // 1: GKP, 2: DEF
  yellow_card: number;
  red_card: number;
  own_goal: number;
  max_bonus_per_match: number;
  defensive_contribution_positions: number[]; // Outfield positions 2, 3, 4
  defensive_contribution_points_per_threshold: number; // +2 FPL points
  defensive_contribution_def_threshold: number; // 10+ CBIT for DEF
  defensive_contribution_mid_fwd_threshold: number; // 12+ CBIRT for MID & FWD
}

export const OFFICIAL_FPL_SCORING_RULES_2026_27: ScoringRuleSet = {
  rules_version: FPL_SCORING_RULES_VERSION,
  appearance_under_60: 1,
  appearance_60_plus: 2,
  goal_by_position: {
    1: 10, // Goalkeeper goal: 10 points
    2: 6,  // Defender goal: 6 points
    3: 5,  // Midfielder goal: 5 points
    4: 4,  // Forward goal: 4 points
  },
  assist: 3, // All positions: 3 points
  clean_sheet_by_position: {
    1: 4, // Goalkeeper clean sheet (60+ mins): 4 points
    2: 4, // Defender clean sheet (60+ mins): 4 points
    3: 1, // Midfielder clean sheet (60+ mins): 1 point
    4: 0, // Forward: 0 points
  },
  save_points_per_block: 1,
  saves_per_block_threshold: 3, // 1 point for every 3 saves
  penalty_save: 5,
  penalty_miss: -2,
  goals_conceded_deduction_per_block: -1,
  goals_conceded_block_threshold: 2, // -1 point for every 2 goals conceded
  goals_conceded_deduction_positions: [1, 2], // GKP, DEF
  yellow_card: -1,
  red_card: -3,
  own_goal: -2,
  max_bonus_per_match: 3,
  defensive_contribution_positions: [2, 3, 4],
  defensive_contribution_points_per_threshold: 2, // +2 standalone Fantasy points
  defensive_contribution_def_threshold: 10, // 10+ CBIT
  defensive_contribution_mid_fwd_threshold: 12, // 12+ CBIRT
};

/**
 * Evaluates official 2026/27 Defensive Contribution points for a single match row:
 * - DEF (Pos 2): 10+ CBIT (Clearances, Blocks, Interceptions + Tackles) = +2 pts (max 2 pts/fixture). Recoveries do NOT count.
 * - MID/FWD (Pos 3 & 4): 12+ CBIRT (CBI + Tackles + Recoveries) = +2 pts (max 2 pts/fixture). Recoveries DO count.
 * - GKP (Pos 1): NOT_APPLICABLE / 0 pts.
 */
export function evaluateDefensiveContributionMatch(
  positionId: number,
  matchStats: {
    clearances_blocks_interceptions?: number;
    tackles?: number;
    recoveries?: number;
    defensive_contribution?: number;
  },
  rules: ScoringRuleSet = OFFICIAL_FPL_SCORING_RULES_2026_27
): {
  cbit: number;
  cbirt: number;
  threshold: number;
  thresholdHit: boolean;
  pointsAwarded: number;
} {
  const cbi = Number(matchStats.clearances_blocks_interceptions) || 0;
  const tackles = Number(matchStats.tackles) || 0;
  const recoveries = Number(matchStats.recoveries) || 0;

  const cbit = cbi + tackles;
  const cbirt = cbi + tackles + recoveries;

  if (positionId === 2) {
    // Defender: 10+ CBIT
    const threshold = rules.defensive_contribution_def_threshold;
    const thresholdHit = cbit >= threshold;
    return {
      cbit,
      cbirt,
      threshold,
      thresholdHit,
      pointsAwarded: thresholdHit ? rules.defensive_contribution_points_per_threshold : 0,
    };
  } else if (positionId === 3 || positionId === 4) {
    // Midfielder or Forward: 12+ CBIRT
    const threshold = rules.defensive_contribution_mid_fwd_threshold;
    const thresholdHit = cbirt >= threshold;
    return {
      cbit,
      cbirt,
      threshold,
      thresholdHit,
      pointsAwarded: thresholdHit ? rules.defensive_contribution_points_per_threshold : 0,
    };
  } else {
    // Goalkeeper or other: Not applicable / 0 direct points
    return {
      cbit,
      cbirt,
      threshold: 0,
      thresholdHit: false,
      pointsAwarded: 0,
    };
  }
}

// ============================================================================
// 2. MODEL INTERFACES & BREAKDOWNS
// ============================================================================

export interface ComponentBreakdown<T = number> {
  value: T;
  points: number;
  validity: DataValidity;
  source: string;
  support_status?: "supported" | "unsupported" | "zero_expected_by_v1_policy";
  reason?: string;
}

export interface FixtureExpectedPointsBreakdown {
  fixture_id: number;
  opponent_team_id: number;
  is_home: boolean;
  difficulty: number;

  // Minutes & Appearance
  expected_minutes: number;
  probability_appearance: number;
  probability_60_plus_minutes: number;
  expected_appearance_points: number;

  // Attacking
  shrunk_xg_per90: number;
  expected_goals: number;
  expected_goal_points: number;
  shrunk_xa_per90: number;
  expected_assists: number;
  expected_assist_points: number;

  // Defensive
  probability_clean_sheet: number;
  expected_clean_sheet_points: number;
  expected_goals_conceded: number;
  expected_goals_conceded_deduction: number;
  probability_defensive_contribution_points: number;
  expected_defensive_contribution_points: number;

  // Goalkeeper Specific
  expected_saves: number;
  expected_save_points: number;
  expected_penalty_save_points: number;

  // Other Events & Deductions
  expected_bonus_points: number;
  expected_penalty_miss_deduction: number;
  expected_yellow_card_deduction: number;
  expected_red_card_deduction: number;
  expected_own_goal_deduction: number;

  // Total
  fixture_expected_points: number;
}

export interface ExpectedPointsBreakdown {
  player_id: number;
  model_version: string;
  scoring_rules_version: string;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  position_id: number;
  fixture_count: number;
  gameweek_type: "normal" | "blank" | "double" | "multiple" | "unknown";

  // Aggregated Components across GW
  expected_minutes: number;
  expected_appearance_points: number;

  expected_goals: number;
  expected_goal_points: number;
  expected_assists: number;
  expected_assist_points: number;

  probability_clean_sheet: number;
  expected_clean_sheet_points: number;
  expected_goals_conceded: number;
  expected_goals_conceded_deduction: number;

  expected_saves: number;
  expected_save_points: number;
  expected_penalty_save_points: number;

  probability_defensive_contribution_points: number;
  expected_defensive_contribution_points: number;

  expected_bonus_points: number;
  expected_penalty_miss_deduction: number;
  expected_yellow_card_deduction: number;
  expected_red_card_deduction: number;
  expected_own_goal_deduction: number;

  // Shrinkage & Diagnostics
  shrinkage_diagnostics: {
    sample_matches: number;
    sample_minutes: number;
    raw_xg_per90: number;
    prior_xg_per90: number;
    shrunk_xg_per90: number;
    raw_xa_per90: number;
    prior_xa_per90: number;
    shrunk_xa_per90: number;
    sample_dc_hits: number;
    raw_dc_rate: number;
    prior_dc_rate: number;
    shrunk_dc_rate: number;
    prior_sample_weight: number;
  };

  // Unsupported or policy-zero categories
  unsupported_components: Record<string, string>;

  // Per-Fixture Breakdown
  fixtures: FixtureExpectedPointsBreakdown[];

  // Total Expected Points
  expected_points_next_gameweek: number;
  expected_points_confidence: number;
}

export interface PlayerExpectedPointsResult {
  player_id: number;
  model_version: string;
  scoring_rules_version: string;
  expected_points_next_gameweek: DataValueDict;
  expected_points_confidence: DataValueDict;
  breakdown: ExpectedPointsBreakdown;
  prediction_output: Record<string, any>;
}

// ============================================================================
// 3. STATISTICAL & BAYESIAN PRIORS
// ============================================================================

export interface PositionPriors {
  prior_xg_per90: number;
  prior_xa_per90: number;
  prior_saves_per90: number;
  prior_yellow_per90: number;
  prior_red_per90: number;
  prior_own_goal_per90: number;
  prior_bonus_per_match: number;
  prior_def_contrib_rate: number;
  prior_sample_weight_matches: number;
}

export const POSITION_EVENT_PRIORS: Record<number, PositionPriors> = {
  1: { // GKP
    prior_xg_per90: 0.001,
    prior_xa_per90: 0.003,
    prior_saves_per90: 3.20,
    prior_yellow_per90: 0.03,
    prior_red_per90: 0.002,
    prior_own_goal_per90: 0.002,
    prior_bonus_per_match: 0.12,
    prior_def_contrib_rate: 0.0,
    prior_sample_weight_matches: 4.0,
  },
  2: { // DEF
    prior_xg_per90: 0.045,
    prior_xa_per90: 0.045,
    prior_saves_per90: 0.0,
    prior_yellow_per90: 0.13,
    prior_red_per90: 0.006,
    prior_own_goal_per90: 0.006,
    prior_bonus_per_match: 0.18,
    prior_def_contrib_rate: 0.08,
    prior_sample_weight_matches: 4.0,
  },
  3: { // MID
    prior_xg_per90: 0.16,
    prior_xa_per90: 0.15,
    prior_saves_per90: 0.0,
    prior_yellow_per90: 0.12,
    prior_red_per90: 0.005,
    prior_own_goal_per90: 0.002,
    prior_bonus_per_match: 0.22,
    prior_def_contrib_rate: 0.05,
    prior_sample_weight_matches: 4.0,
  },
  4: { // FWD
    prior_xg_per90: 0.38,
    prior_xa_per90: 0.14,
    prior_saves_per90: 0.0,
    prior_yellow_per90: 0.10,
    prior_red_per90: 0.004,
    prior_own_goal_per90: 0.001,
    prior_bonus_per_match: 0.28,
    prior_def_contrib_rate: 0.01,
    prior_sample_weight_matches: 4.0,
  },
};

// ============================================================================
// 4. MATHEMATICAL UTILITIES & DISCRETE DISTRIBUTIONS
// ============================================================================

function roundTo(val: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * Computes Poisson probability P(X = k; lambda)
 */
function poissonPdf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1.0 : 0.0;
  if (k < 0) return 0.0;
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

/**
 * Discrete expectation of goalkeeper save points: floor(saves / 3) * 1 pt
 * where saves ~ Poisson(lambda_saves)
 */
export function expectedSavePointsFromPoisson(lambdaSaves: number): number {
  if (lambdaSaves <= 0) return 0.0;
  let expPoints = 0.0;
  for (let s = 1; s <= 20; s++) {
    const p = poissonPdf(s, lambdaSaves);
    const pts = Math.floor(s / 3.0);
    expPoints += pts * p;
  }
  return roundTo(expPoints, 4);
}

/**
 * Discrete expectation of goals conceded deduction: floor(goals / 2) * -1 pt
 * where goals ~ Poisson(lambda_conceded)
 */
export function expectedGoalsConcededDeductionFromPoisson(lambdaConceded: number): number {
  if (lambdaConceded <= 0) return 0.0;
  let expDeduction = 0.0;
  for (let g = 1; g <= 15; g++) {
    const p = poissonPdf(g, lambdaConceded);
    const ded = Math.floor(g / 2.0);
    expDeduction += ded * p;
  }
  return roundTo(expDeduction, 4);
}

/**
 * Opponent fixture modifier based on FDR and Home/Away status
 */
export function calculateFixtureModifiers(difficulty: number, isHome: boolean): {
  attackMultiplier: number;
  defenseMultiplier: number;
} {
  // FDR scale: 1 (easiest) to 5 (hardest)
  let baseAtk = 1.0;
  let baseDef = 1.0;

  switch (difficulty) {
    case 1:
      baseAtk = 1.15;
      baseDef = 1.20;
      break;
    case 2:
      baseAtk = 1.08;
      baseDef = 1.10;
      break;
    case 3:
      baseAtk = 1.00;
      baseDef = 1.00;
      break;
    case 4:
      baseAtk = 0.92;
      baseDef = 0.90;
      break;
    case 5:
      baseAtk = 0.85;
      baseDef = 0.80;
      break;
    default:
      baseAtk = 1.00;
      baseDef = 1.00;
  }

  const homeAtkBonus = isHome ? 1.04 : 0.96;
  const homeDefBonus = isHome ? 1.08 : 0.92;

  const attackMultiplier = roundTo(Math.min(1.25, Math.max(0.75, baseAtk * homeAtkBonus)), 3);
  const defenseMultiplier = roundTo(Math.min(1.25, Math.max(0.75, baseDef * homeDefBonus)), 3);

  return { attackMultiplier, defenseMultiplier };
}

// ============================================================================
// 5. CORE EXPECTED POINTS MODEL BUILDER
// ============================================================================

export function buildPlayerExpectedPoints(options: {
  player: Record<string, any>;
  features: CanonicalPlayerFeatures;
  minutesResult: PlayerMinutesModelResult;
  snapshot: PredictionSnapshot;
  history?: Array<Record<string, any>> | null;
  allFixtures?: Array<Record<string, any>> | null;
  allTeams?: Array<Record<string, any>> | null;
  scoringRules?: ScoringRuleSet;
}): PlayerExpectedPointsResult {
  const {
    player,
    features,
    minutesResult,
    snapshot,
    history = null,
    scoringRules = OFFICIAL_FPL_SCORING_RULES_2026_27,
  } = options;

  const positionId = Number(player.element_type) || 3;
  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const predGw = snapshot.boundary.prediction_gameweek;
  const priors = POSITION_EVENT_PRIORS[positionId] || POSITION_EVENT_PRIORS[3];

  // 1. Filter cutoff-safe historical match rows
  const safeHistory = Array.isArray(history)
    ? history.filter((h) => {
        const r = typeof h.round === "number" ? h.round : typeof h.event === "number" ? h.event : null;
        return r !== null && (cutoffGw === null || r <= cutoffGw);
      })
    : [];

  // Calculate historical sample totals
  let sampleMinutes = 0;
  let sampleStarts = 0;
  let sampleGoals = 0;
  let sampleAssists = 0;
  let sampleXg = 0.0;
  let sampleXa = 0.0;
  let sampleSaves = 0;
  let sampleCleanSheets = 0;
  let sampleGoalsConceded = 0;
  let sampleBonus = 0;
  let sampleBps = 0;
  let sampleYellows = 0;
  let sampleReds = 0;
  let sampleOwnGoals = 0;
  let samplePensSaved = 0;
  let samplePensMissed = 0;
  let sampleDcHits = 0;

  for (const h of safeHistory) {
    const mins = Number(h.minutes) || 0;
    sampleMinutes += mins;
    if (mins > 0 && h.starts === 1) sampleStarts += 1;
    sampleGoals += Number(h.goals_scored) || 0;
    sampleAssists += Number(h.assists) || 0;
    sampleXg += parseFloat(String(h.expected_goals || "0")) || 0.0;
    sampleXa += parseFloat(String(h.expected_assists || "0")) || 0.0;
    sampleSaves += Number(h.saves) || 0;
    sampleCleanSheets += Number(h.clean_sheets) || 0;
    sampleGoalsConceded += Number(h.goals_conceded) || 0;
    sampleBonus += Number(h.bonus) || 0;
    sampleBps += Number(h.bps) || 0;
    sampleYellows += Number(h.yellow_cards) || 0;
    sampleReds += Number(h.red_cards) || 0;
    sampleOwnGoals += Number(h.own_goals) || 0;
    samplePensSaved += Number(h.penalties_saved) || 0;
    samplePensMissed += Number(h.penalties_missed) || 0;

    // Defensive Contribution evaluation (DEF: 10+ CBIT, MID/FWD: 12+ CBIRT, GKP: 0)
    const dcEval = evaluateDefensiveContributionMatch(positionId, h, scoringRules);
    if (dcEval.thresholdHit) {
      sampleDcHits += 1;
    }
  }

  const sampleMatches = safeHistory.length;
  const sample90s = sampleMinutes / 90.0;
  const priorWeight = priors.prior_sample_weight_matches;

  // 2. Bayesian Shrinkage of Attacking Rates (per 90 minutes)
  const rawXgPer90 = sample90s > 0 ? sampleXg / sample90s : priors.prior_xg_per90;
  const shrunkXgPer90 = roundTo(
    (sample90s * rawXgPer90 + priorWeight * priors.prior_xg_per90) / (sample90s + priorWeight),
    4
  );

  const rawXaPer90 = sample90s > 0 ? sampleXa / sample90s : priors.prior_xa_per90;
  const shrunkXaPer90 = roundTo(
    (sample90s * rawXaPer90 + priorWeight * priors.prior_xa_per90) / (sample90s + priorWeight),
    4
  );

  // Set-piece penalty-taker bonus xG (supported role from Phase 2)
  const penRole = features.set_pieces?.penalty_role;
  const penaltyTakerXgBoost =
    penRole === SetPieceRole.FIRST_CHOICE || penRole === SetPieceRole.SECONDARY
      ? penRole === SetPieceRole.FIRST_CHOICE
        ? 0.06
        : 0.03
      : 0.0;

  // 3. Clean-Sheet Base Rate Shrinkage
  // Baseline league clean sheet rate is ~0.28
  const rawCsRate = sampleMatches > 0 ? sampleCleanSheets / sampleMatches : 0.28;
  const shrunkCsBaseRate = roundTo(
    (sampleMatches * rawCsRate + 4.0 * 0.28) / (sampleMatches + 4.0),
    4
  );

  // 4. Goals Conceded Base Rate Shrinkage (for DEF / GKP)
  // Baseline goals conceded per match ~ 1.35
  const rawGcRate = sampleMatches > 0 ? sampleGoalsConceded / sampleMatches : 1.35;
  const shrunkGcBaseRate = roundTo(
    (sampleMatches * rawGcRate + 4.0 * 1.35) / (sampleMatches + 4.0),
    4
  );

  // 5. Goalkeeper Saves Shrinkage
  const rawSavesPer90 = sample90s > 0 ? sampleSaves / sample90s : priors.prior_saves_per90;
  const shrunkSavesPer90 = roundTo(
    (sample90s * rawSavesPer90 + priorWeight * priors.prior_saves_per90) / (sample90s + priorWeight),
    4
  );

  // 6. Defensive Contribution Base Rate Shrinkage (2026/27 Standalone +2 pts)
  const rawDcRate = sampleMatches > 0 ? sampleDcHits / sampleMatches : priors.prior_def_contrib_rate;
  const shrunkDcRate = positionId === 1
    ? 0.0
    : roundTo(
        (sampleMatches * rawDcRate + priorWeight * priors.prior_def_contrib_rate) / (sampleMatches + priorWeight),
        4
      );

  // 7. Bonus Points Base Rate Shrinkage
  const rawBonusPerMatch = sampleMatches > 0 ? sampleBonus / sampleMatches : priors.prior_bonus_per_match;
  const shrunkBonusBase = roundTo(
    (sampleMatches * rawBonusPerMatch + priorWeight * priors.prior_bonus_per_match) / (sampleMatches + priorWeight),
    4
  );

  // 8. Cards / Own Goals Shrinkage
  const rawYellowPer90 = sample90s > 0 ? sampleYellows / sample90s : priors.prior_yellow_per90;
  const shrunkYellowPer90 = roundTo(
    (sample90s * rawYellowPer90 + 6.0 * priors.prior_yellow_per90) / (sample90s + 6.0),
    4
  );

  const rawRedPer90 = sample90s > 0 ? sampleReds / sample90s : priors.prior_red_per90;
  const shrunkRedPer90 = roundTo(
    (sample90s * rawRedPer90 + 15.0 * priors.prior_red_per90) / (sample90s + 15.0),
    5
  );

  const rawOwnGoalPer90 = sample90s > 0 ? sampleOwnGoals / sample90s : priors.prior_own_goal_per90;
  const shrunkOwnGoalPer90 = roundTo(
    (sample90s * rawOwnGoalPer90 + 15.0 * priors.prior_own_goal_per90) / (sample90s + 15.0),
    5
  );

  // 8. Process Prediction Fixtures (Single, DGW, or BGW)
  const fixtureCount = features.fixtures.prediction_gw_fixture_count;
  const gwType = features.fixtures.gameweek_type;
  const predictionFixtures = features.fixtures.prediction_gw_fixtures;

  const fixtureBreakdowns: FixtureExpectedPointsBreakdown[] = [];

  let gwExpMinutes = 0.0;
  let gwExpAppPoints = 0.0;
  let gwExpGoals = 0.0;
  let gwExpGoalPoints = 0.0;
  let gwExpAssists = 0.0;
  let gwExpAssistPoints = 0.0;
  let gwProbCleanSheet = 0.0;
  let gwExpCleanSheetPoints = 0.0;
  let gwExpGoalsConceded = 0.0;
  let gwExpGoalsConcededDeduction = 0.0;
  let gwExpSaves = 0.0;
  let gwExpSavePoints = 0.0;
  let gwExpPenaltySavePoints = 0.0;
  let gwProbDefContrib = 0.0;
  let gwExpDefContribPoints = 0.0;
  let gwExpBonusPoints = 0.0;
  let gwExpPenaltyMissDeduction = 0.0;
  let gwExpYellowDeduction = 0.0;
  let gwExpRedDeduction = 0.0;
  let gwExpOwnGoalDeduction = 0.0;
  let gwTotalExpectedPoints = 0.0;

  if (fixtureCount === 0) {
    // Blank Gameweek (BGW): All fixture values remain exactly 0
    gwTotalExpectedPoints = 0.0;
  } else {
    // Normal or Double Gameweek: Compute each fixture independently
    for (let i = 0; i < predictionFixtures.length; i++) {
      const fix = predictionFixtures[i];
      const diff = fix.difficulty || 3;
      const isHome = fix.is_home;

      // Playing time for this specific fixture
      // In Phase 3 breakdown, single fixture minutes is minutes_decomposition.single_fixture_expected_minutes
      const fixMinutesBreakdown = minutesResult.breakdown.per_fixture_breakdown?.[i];
      const fixExpMins = fixMinutesBreakdown?.expected_minutes ??
        minutesResult.breakdown.minutes_decomposition.single_fixture_expected_minutes;
      const fixProbApp = fixMinutesBreakdown?.probability_appearance ??
        minutesResult.breakdown.probabilities.probability_appearance;
      const fixProb60 = fixMinutesBreakdown?.probability_60_plus_minutes ??
        minutesResult.breakdown.probabilities.probability_60_plus_minutes;

      // Fixture modifiers
      const { attackMultiplier, defenseMultiplier } = calculateFixtureModifiers(diff, isHome);

      // A. Appearance Points
      // Official rule: <60 mins = 1 pt, >=60 mins = 2 pts
      // P(<60) = P(appearance) - P(60+)
      // Exp App Pts = 1.0 * (P(app) - P(60+)) + 2.0 * P(60+) = P(app) + P(60+)
      const probUnder60 = Math.max(0, fixProbApp - fixProb60);
      const fixExpAppPoints = roundTo(
        probUnder60 * scoringRules.appearance_under_60 + fixProb60 * scoringRules.appearance_60_plus,
        4
      );

      // B. Expected Goals & Goal Points
      const effectiveXgPer90 = shrunkXgPer90 + penaltyTakerXgBoost;
      const fixExpGoals = roundTo(
        effectiveXgPer90 * (fixExpMins / 90.0) * attackMultiplier,
        4
      );
      const pointsPerGoal = scoringRules.goal_by_position[positionId] ?? 4;
      const fixExpGoalPoints = roundTo(fixExpGoals * pointsPerGoal, 4);

      // C. Expected Assists & Assist Points
      const fixExpAssists = roundTo(
        shrunkXaPer90 * (fixExpMins / 90.0) * attackMultiplier,
        4
      );
      const fixExpAssistPoints = roundTo(fixExpAssists * scoringRules.assist, 4);

      // D. Clean Sheet Probability & Points
      // GKP and DEF require >= 60 mins for clean sheet points (4 pts)
      // MID requires >= 60 mins for clean sheet points (1 pt)
      // FWD gets 0 pts
      const csPointsForPos = scoringRules.clean_sheet_by_position[positionId] ?? 0;
      const fixProbCs = roundTo(
        Math.min(0.70, Math.max(0.05, shrunkCsBaseRate * defenseMultiplier)),
        4
      );
      const fixExpCsPoints = csPointsForPos > 0
        ? roundTo(fixProb60 * fixProbCs * csPointsForPos, 4)
        : 0.0;

      // E. Goals Conceded Deduction (DEF & GKP only)
      let fixExpGc = 0.0;
      let fixExpGcDeduction = 0.0;
      if (scoringRules.goals_conceded_deduction_positions.includes(positionId)) {
        // Expected team goals conceded in match
        const lambdaGc = roundTo(shrunkGcBaseRate / defenseMultiplier, 3);
        fixExpGc = roundTo(lambdaGc * (fixExpMins / 90.0), 3);
        const discreteDeductionPerMatch = expectedGoalsConcededDeductionFromPoisson(lambdaGc);
        // Player deduction applies when on the pitch (primarily for 60+ starters)
        fixExpGcDeduction = roundTo(fixProb60 * discreteDeductionPerMatch * -1.0, 4);
      }

      // F. Goalkeeper Saves & Penalty Saves (GKP only)
      let fixExpSaves = 0.0;
      let fixExpSavePoints = 0.0;
      let fixExpPenSavePoints = 0.0;
      if (positionId === 1) {
        // Goalkeepers face more saves against difficult opponents (higher attackMultiplier for opp)
        const oppAtkThreat = 2.0 - defenseMultiplier;
        const lambdaSaves = roundTo(shrunkSavesPer90 * (fixExpMins / 90.0) * oppAtkThreat, 3);
        fixExpSaves = lambdaSaves;
        fixExpSavePoints = expectedSavePointsFromPoisson(lambdaSaves);

        // Conservative penalty save expectation: ~0.02 pens faced per match * 0.25 save rate * 5 pts
        fixExpPenSavePoints = roundTo(0.005 * (fixExpMins / 90.0) * scoringRules.penalty_save, 4);
      }

      // G. Defensive Contribution Points (2026/27)
      // Official rule: DEF (10+ CBIT) = +2 pts; MID/FWD (12+ CBIRT) = +2 pts (max 2 pts/fixture). GKP = 0 pts.
      let fixProbDefContrib = 0.0;
      let fixExpDefContribPoints = 0.0;
      if (scoringRules.defensive_contribution_positions.includes(positionId)) {
        fixProbDefContrib = roundTo(
          Math.min(0.75, shrunkDcRate * (fixExpMins / 90.0) * defenseMultiplier),
          4
        );
        fixExpDefContribPoints = roundTo(
          fixProbDefContrib * scoringRules.defensive_contribution_points_per_threshold,
          4
        );
      }

      // H. Bonus Points Expectation
      // Derived from shrunk base rate, scaled by match playing time and event expectations
      const attackInvolvementRatio = (fixExpGoals + fixExpAssists) / Math.max(0.1, priors.prior_xg_per90 + priors.prior_xa_per90);
      const bonusMultiplier = Math.min(2.5, Math.max(0.4, 0.70 + 0.30 * attackInvolvementRatio + 0.20 * (fixProbCs > 0.35 ? 1.0 : 0.0)));
      const fixExpBonusPoints = roundTo(
        Math.min(
          scoringRules.max_bonus_per_match,
          shrunkBonusBase * (fixExpMins / 90.0) * bonusMultiplier
        ),
        4
      );

      // I. Disciplinary & Rare Event Deductions
      const fixExpYellowDeduction = roundTo(
        shrunkYellowPer90 * (fixExpMins / 90.0) * scoringRules.yellow_card,
        4
      );
      const fixExpRedDeduction = roundTo(
        shrunkRedPer90 * (fixExpMins / 90.0) * scoringRules.red_card,
        4
      );
      const fixExpOwnGoalDeduction = roundTo(
        shrunkOwnGoalPer90 * (fixExpMins / 90.0) * scoringRules.own_goal,
        4
      );

      // Penalty miss deduction for designated takers
      const fixExpPenaltyMissDeduction =
        penRole === SetPieceRole.FIRST_CHOICE || penRole === SetPieceRole.SECONDARY
          ? roundTo(0.015 * (fixExpMins / 90.0) * scoringRules.penalty_miss, 4)
          : 0.0;

      // J. Fixture Total Expected Points Identity:
      // SUM of positive expected points + negative deductions
      const fixTotalEp = roundTo(
        fixExpAppPoints +
        fixExpGoalPoints +
        fixExpAssistPoints +
        fixExpCsPoints +
        fixExpSavePoints +
        fixExpPenSavePoints +
        fixExpDefContribPoints +
        fixExpBonusPoints +
        fixExpGcDeduction +          // already negative
        fixExpPenaltyMissDeduction + // already negative
        fixExpYellowDeduction +      // already negative
        fixExpRedDeduction +         // already negative
        fixExpOwnGoalDeduction,      // already negative
        4
      );

      const fixBreakdown: FixtureExpectedPointsBreakdown = {
        fixture_id: fix.fixture_id,
        opponent_team_id: fix.opponent_team_id,
        is_home: isHome,
        difficulty: diff,

        expected_minutes: fixExpMins,
        probability_appearance: fixProbApp,
        probability_60_plus_minutes: fixProb60,
        expected_appearance_points: fixExpAppPoints,

        shrunk_xg_per90: shrunkXgPer90,
        expected_goals: fixExpGoals,
        expected_goal_points: fixExpGoalPoints,
        shrunk_xa_per90: shrunkXaPer90,
        expected_assists: fixExpAssists,
        expected_assist_points: fixExpAssistPoints,

        probability_clean_sheet: fixProbCs,
        expected_clean_sheet_points: fixExpCsPoints,
        expected_goals_conceded: fixExpGc,
        expected_goals_conceded_deduction: fixExpGcDeduction,
        probability_defensive_contribution_points: fixProbDefContrib,
        expected_defensive_contribution_points: fixExpDefContribPoints,

        expected_saves: fixExpSaves,
        expected_save_points: fixExpSavePoints,
        expected_penalty_save_points: fixExpPenSavePoints,

        expected_bonus_points: fixExpBonusPoints,
        expected_penalty_miss_deduction: fixExpPenaltyMissDeduction,
        expected_yellow_card_deduction: fixExpYellowDeduction,
        expected_red_card_deduction: fixExpRedDeduction,
        expected_own_goal_deduction: fixExpOwnGoalDeduction,

        fixture_expected_points: fixTotalEp,
      };

      fixtureBreakdowns.push(fixBreakdown);

      // Aggregate across Gameweek
      gwExpMinutes += fixExpMins;
      gwExpAppPoints += fixExpAppPoints;
      gwExpGoals += fixExpGoals;
      gwExpGoalPoints += fixExpGoalPoints;
      gwExpAssists += fixExpAssists;
      gwExpAssistPoints += fixExpAssistPoints;
      gwProbCleanSheet = Math.max(gwProbCleanSheet, fixProbCs);
      gwExpCleanSheetPoints += fixExpCsPoints;
      gwExpGoalsConceded += fixExpGc;
      gwExpGoalsConcededDeduction += fixExpGcDeduction;
      gwExpSaves += fixExpSaves;
      gwExpSavePoints += fixExpSavePoints;
      gwExpPenaltySavePoints += fixExpPenSavePoints;
      gwProbDefContrib = Math.max(gwProbDefContrib, fixProbDefContrib);
      gwExpDefContribPoints += fixExpDefContribPoints;
      gwExpBonusPoints += fixExpBonusPoints;
      gwExpPenaltyMissDeduction += fixExpPenaltyMissDeduction;
      gwExpYellowDeduction += fixExpYellowDeduction;
      gwExpRedDeduction += fixExpRedDeduction;
      gwExpOwnGoalDeduction += fixExpOwnGoalDeduction;
      gwTotalExpectedPoints += fixTotalEp;
    }
  }

  // Round aggregated totals
  gwExpMinutes = roundTo(gwExpMinutes, 1);
  gwExpAppPoints = roundTo(gwExpAppPoints, 2);
  gwExpGoals = roundTo(gwExpGoals, 3);
  gwExpGoalPoints = roundTo(gwExpGoalPoints, 2);
  gwExpAssists = roundTo(gwExpAssists, 3);
  gwExpAssistPoints = roundTo(gwExpAssistPoints, 2);
  gwProbCleanSheet = roundTo(gwProbCleanSheet, 3);
  gwExpCleanSheetPoints = roundTo(gwExpCleanSheetPoints, 2);
  gwExpGoalsConceded = roundTo(gwExpGoalsConceded, 2);
  gwExpGoalsConcededDeduction = roundTo(gwExpGoalsConcededDeduction, 2);
  gwExpSaves = roundTo(gwExpSaves, 2);
  gwExpSavePoints = roundTo(gwExpSavePoints, 2);
  gwExpPenaltySavePoints = roundTo(gwExpPenaltySavePoints, 2);
  gwProbDefContrib = roundTo(gwProbDefContrib, 3);
  gwExpDefContribPoints = roundTo(gwExpDefContribPoints, 2);
  gwExpBonusPoints = roundTo(gwExpBonusPoints, 2);
  gwExpPenaltyMissDeduction = roundTo(gwExpPenaltyMissDeduction, 2);
  gwExpYellowDeduction = roundTo(gwExpYellowDeduction, 2);
  gwExpRedDeduction = roundTo(gwExpRedDeduction, 2);
  gwExpOwnGoalDeduction = roundTo(gwExpOwnGoalDeduction, 2);
  gwTotalExpectedPoints = roundTo(gwTotalExpectedPoints, 2);

  // 9. Model Confidence (Decoupled from probability / expected points value)
  const ptConfidenceVal = minutesResult.playing_time_confidence.value !== null
    ? Number(minutesResult.playing_time_confidence.value)
    : 0.0;
  const sampleMatchFactor = roundTo(1.0 - Math.exp(-sampleMatches / 4.0), 3);
  const epConfidenceVal = fixtureCount === 0
    ? 1.0
    : roundTo(ptConfidenceVal * (0.35 + 0.65 * sampleMatchFactor), 3);

  // 10. Validity & Reason Determinations
  let epValidity = DataValidity.DERIVED;
  let epReason: string | null = null;

  if (fixtureCount === 0) {
    epValidity = DataValidity.NOT_APPLICABLE;
    epReason = "Blank gameweek; 0 expected points.";
  } else if (gwTotalExpectedPoints === 0 && gwExpMinutes === 0) {
    epValidity = DataValidity.OBSERVED_ZERO;
    epReason = "Zero expected minutes yields zero expected points.";
  } else {
    epReason = `Interpretable sum of ${fixtureCount} fixture(s) expected scoring events under official FPL rules.`;
  }

  const epEnvelope: DataValueDict = {
    value: epValidity === DataValidity.NOT_APPLICABLE ? null : gwTotalExpectedPoints,
    validity: epValidity,
    source: EXPECTED_POINTS_MODEL_VERSION,
    as_of_gameweek: cutoffGw,
    reason: epReason,
  };

  const confidenceEnvelope: DataValueDict = {
    value: epConfidenceVal,
    validity: DataValidity.DERIVED,
    source: EXPECTED_POINTS_MODEL_VERSION,
    as_of_gameweek: cutoffGw,
    reason: `Confidence based on playing time model and ${sampleMatches} completed match sample.`,
  };

  const breakdown: ExpectedPointsBreakdown = {
    player_id: player.id,
    model_version: EXPECTED_POINTS_MODEL_VERSION,
    scoring_rules_version: FPL_SCORING_RULES_VERSION,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    position_id: positionId,
    fixture_count: fixtureCount,
    gameweek_type: gwType,

    expected_minutes: gwExpMinutes,
    expected_appearance_points: gwExpAppPoints,

    expected_goals: gwExpGoals,
    expected_goal_points: gwExpGoalPoints,
    expected_assists: gwExpAssists,
    expected_assist_points: gwExpAssistPoints,

    probability_clean_sheet: gwProbCleanSheet,
    expected_clean_sheet_points: gwExpCleanSheetPoints,
    expected_goals_conceded: gwExpGoalsConceded,
    expected_goals_conceded_deduction: gwExpGoalsConcededDeduction,

    expected_saves: gwExpSaves,
    expected_save_points: gwExpSavePoints,
    expected_penalty_save_points: gwExpPenaltySavePoints,

    probability_defensive_contribution_points: gwProbDefContrib,
    expected_defensive_contribution_points: gwExpDefContribPoints,

    expected_bonus_points: gwExpBonusPoints,
    expected_penalty_miss_deduction: gwExpPenaltyMissDeduction,
    expected_yellow_card_deduction: gwExpYellowDeduction,
    expected_red_card_deduction: gwExpRedDeduction,
    expected_own_goal_deduction: gwExpOwnGoalDeduction,

    shrinkage_diagnostics: {
      sample_matches: sampleMatches,
      sample_minutes: sampleMinutes,
      raw_xg_per90: rawXgPer90,
      prior_xg_per90: priors.prior_xg_per90,
      shrunk_xg_per90: shrunkXgPer90,
      raw_xa_per90: rawXaPer90,
      prior_xa_per90: priors.prior_xa_per90,
      shrunk_xa_per90: shrunkXaPer90,
      sample_dc_hits: sampleDcHits,
      raw_dc_rate: rawDcRate,
      prior_dc_rate: priors.prior_def_contrib_rate,
      shrunk_dc_rate: shrunkDcRate,
      prior_sample_weight: priorWeight,
    },

    unsupported_components: {},

    fixtures: fixtureBreakdowns,
    expected_points_next_gameweek: gwTotalExpectedPoints,
    expected_points_confidence: epConfidenceVal,
  };

  // Build the complete Phase 0 / Phase 4 PredictionOutput object
  const legacyScoreVal = player.expert_score !== undefined ? Number(player.expert_score) : null;
  const legacyScoreEnvelope = new DataValue({
    value: legacyScoreVal,
    validity: legacyScoreVal !== null ? DataValidity.DERIVED : DataValidity.MISSING,
    source: LEGACY_RANK_SCORE_SOURCE,
    as_of_gameweek: cutoffGw,
    reason: "Legacy relative ranking score; not expected FPL points.",
  });

  const predictionOutputObj = new PredictionOutput({
    player_id: player.id,
    snapshot_id: snapshot.snapshot_id,
    last_finished_gameweek: snapshot.boundary.last_finished_gameweek,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    expected_points_next_gameweek: new DataValue({
      value: epEnvelope.value,
      validity: epEnvelope.validity as DataValidity,
      source: epEnvelope.source,
      as_of_gameweek: epEnvelope.as_of_gameweek,
      reason: epEnvelope.reason,
    }),
    expert_rank_score: legacyScoreEnvelope,
    expected_minutes: new DataValue({
      value: minutesResult.expected_minutes.value,
      validity: minutesResult.expected_minutes.validity as DataValidity,
      source: minutesResult.expected_minutes.source,
      as_of_gameweek: minutesResult.expected_minutes.as_of_gameweek,
      reason: minutesResult.expected_minutes.reason,
    }),
    probability_available: new DataValue({
      value: minutesResult.probability_available.value,
      validity: minutesResult.probability_available.validity as DataValidity,
      source: minutesResult.probability_available.source,
      as_of_gameweek: minutesResult.probability_available.as_of_gameweek,
      reason: minutesResult.probability_available.reason,
    }),
    probability_appearance: new DataValue({
      value: minutesResult.probability_appearance.value,
      validity: minutesResult.probability_appearance.validity as DataValidity,
      source: minutesResult.probability_appearance.source,
      as_of_gameweek: minutesResult.probability_appearance.as_of_gameweek,
      reason: minutesResult.probability_appearance.reason,
    }),
    probability_start: new DataValue({
      value: minutesResult.probability_start.value,
      validity: minutesResult.probability_start.validity as DataValidity,
      source: minutesResult.probability_start.source,
      as_of_gameweek: minutesResult.probability_start.as_of_gameweek,
      reason: minutesResult.probability_start.reason,
    }),
    probability_60_plus_minutes: new DataValue({
      value: minutesResult.probability_60_plus_minutes.value,
      validity: minutesResult.probability_60_plus_minutes.validity as DataValidity,
      source: minutesResult.probability_60_plus_minutes.source,
      as_of_gameweek: minutesResult.probability_60_plus_minutes.as_of_gameweek,
      reason: minutesResult.probability_60_plus_minutes.reason,
    }),
    prediction_confidence: new DataValue({
      value: confidenceEnvelope.value,
      validity: confidenceEnvelope.validity as DataValidity,
      source: confidenceEnvelope.source,
      as_of_gameweek: confidenceEnvelope.as_of_gameweek,
      reason: confidenceEnvelope.reason,
    }),
    prediction_range: new PredictionRange({
      lower: null,
      upper: null,
      validity: DataValidity.MISSING,
      reason: "Prediction intervals are not implemented in Phase 4.",
    }),
  });

  return {
    player_id: player.id,
    model_version: EXPECTED_POINTS_MODEL_VERSION,
    scoring_rules_version: FPL_SCORING_RULES_VERSION,
    expected_points_next_gameweek: epEnvelope,
    expected_points_confidence: confidenceEnvelope,
    breakdown,
    prediction_output: predictionOutputObj.toDict(),
  };
}

export function buildBulkExpectedPoints(options: {
  players: Array<Record<string, any>>;
  featuresByPlayer: Record<number, CanonicalPlayerFeatures>;
  minutesByPlayer: Record<number, PlayerMinutesModelResult>;
  snapshot: PredictionSnapshot;
  recentHistoryByPlayer?: Record<number, Array<Record<string, any>>> | null;
  allFixtures?: Array<Record<string, any>> | null;
  allTeams?: Array<Record<string, any>> | null;
}): Record<number, PlayerExpectedPointsResult> {
  const {
    players,
    featuresByPlayer,
    minutesByPlayer,
    snapshot,
    recentHistoryByPlayer = null,
    allFixtures = null,
    allTeams = null,
  } = options;

  const result: Record<number, PlayerExpectedPointsResult> = {};

  for (const p of players) {
    const feat = featuresByPlayer[p.id];
    const mins = minutesByPlayer[p.id];
    if (feat && mins) {
      const hist = recentHistoryByPlayer?.[p.id] ?? p._history ?? null;
      result[p.id] = buildPlayerExpectedPoints({
        player: p,
        features: feat,
        minutesResult: mins,
        snapshot,
        history: hist,
        allFixtures,
        allTeams,
      });
    }
  }

  return result;
}
