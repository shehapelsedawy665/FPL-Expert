import {
  DataValidity,
  DataValue,
  DataValueDict,
  GameweekBoundary,
  PredictionSnapshot,
} from "./prediction_contract.js";
import {
  CanonicalPlayerFeatures,
  FixtureContextItem,
  buildPlayerPredictionFeatures,
} from "./prediction_features.js";
import {
  PlayerMinutesModelResult,
  MINUTES_MODEL_VERSION,
  buildPlayerExpectedMinutes,
} from "./expected_minutes_model.js";
import {
  PlayerExpectedPointsResult,
  EXPECTED_POINTS_MODEL_VERSION,
  FPL_SCORING_RULES_VERSION,
  FixtureExpectedPointsBreakdown,
  buildPlayerExpectedPoints,
} from "./expected_points_model.js";
import {
  CalibratedExpectedPointsResult,
  CalibrationStatus,
  LinearCalibrationCoefficients,
  CALIBRATION_MODEL_VERSION,
  UNCERTAINTY_MODEL_VERSION,
  buildCalibratedExpectedPoints,
} from "./calibration_service.js";

export const MULTI_GW_PROJECTION_VERSION = "multi-gw-projection.v1";
export const DEFAULT_PROJECTION_HORIZON = 5;
export const SUPPORTED_HORIZONS = [1, 3, 5, 8] as const;
export const DEFAULT_DISCOUNT_FACTORS = [1.00, 0.95, 0.90] as const;

export const FORWARD_ROLE_ASSUMPTION = "static_cutoff_role_state";
export const FORWARD_ROLE_ASSUMPTION_DESCRIPTION =
  "Hold current cutoff-safe role state constant across the horizon without simulating synthetic future match history.";

export const FORWARD_AVAILABILITY_ASSUMPTION = "static_current_status";
export const FORWARD_AVAILABILITY_ASSUMPTION_DESCRIPTION =
  "Carry current official availability status conservatively across the horizon unless explicit official return date is present.";

export const CORRELATED_UNCERTAINTY_NOTE =
  "Future gameweek projections for the same player are correlated through shared role, team form, and minutes risk; uncertainty intervals across multiple gameweeks are not independent.";

// ============================================================================
// 1. DATA CONTRACTS & INTERFACES
// ============================================================================

export interface MultiGwFixtureItem {
  fixture_id: number;
  gameweek: number;
  opponent_team_id: number;
  opponent_short_name: string;
  is_home: boolean;
  difficulty: number;
  expected_minutes: number;
  probability_appearance: number;
  probability_start: number;
  probability_60_plus_minutes: number;
  expected_points: number;
  breakdown?: FixtureExpectedPointsBreakdown;
}

export interface MultiGwConfidence {
  value: number;
  uncertainty_range_low: number | null;
  uncertainty_range_high: number | null;
  sample_matches: number;
}

export interface MultiGwGameweekProjection {
  gameweek: number;
  gw_offset: number; // 1-indexed: 1 = start_gw, 2 = start_gw+1, etc.
  fixture_count: number;
  gameweek_type: "normal" | "blank" | "double" | "multiple";
  is_bgw: boolean;
  is_dgw: boolean;
  fixtures: MultiGwFixtureItem[];

  expected_minutes: number;
  probability_appearance: number;
  probability_start: number;
  probability_60_plus_minutes: number;

  raw_expected_points: number;
  calibrated_expected_points: number | null;
  expected_points: number; // Primary usable xPts (calibrated if active, else raw)
  calibration_status: CalibrationStatus;

  validity: DataValidity;
  reason: string;
  confidence: MultiGwConfidence;
}

export interface MultiGwHorizonsBreakdown {
  gw1: number;
  gw3: number;
  gw5: number;
  gw8?: number;
}

export interface MultiGwProjectionProvenance {
  player_id: number;
  snapshot_id: string;
  historical_cutoff_gameweek: number | null;
  start_gameweek: number;
  horizon: number;
  gameweeks_projected: number[];
  models: {
    multi_gw_version: string;
    minutes_model_version: string;
    expected_points_model_version: string;
    calibration_version: string;
    uncertainty_version: string;
    scoring_rules_version: string;
  };
  generated_at: string;
}

export interface PlayerMultiGwProjection {
  player_id: number;
  web_name: string;
  position_short_name: string;
  element_type: number;
  team_id: number;
  team_short_name: string;

  snapshot_id: string;
  cutoff_gameweek: number | null;
  start_gameweek: number;
  horizon: number;

  gameweeks: MultiGwGameweekProjection[];

  cumulative_raw_xPts: number;
  cumulative_expected_points: number;
  discounted_expected_points: Record<string, number>;

  cumulative_horizons: MultiGwHorizonsBreakdown;
  discounted_horizons: Record<string, MultiGwHorizonsBreakdown>;

  total_fixtures_count: number;
  bgw_count: number;
  dgw_count: number;

  projection_method: string;
  role_assumption: string;
  availability_assumption: string;
  correlated_uncertainty_note: string;
  confidence_summary: {
    avg_confidence: number;
    min_confidence: number;
  };
  provenance: MultiGwProjectionProvenance;
}

// ============================================================================
// 2. HELPER UTILITIES
// ============================================================================

function roundTo(val: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function getTeamShortName(teamId: number, allTeams?: Array<Record<string, any>> | null): string {
  if (!allTeams || !Array.isArray(allTeams)) return `T${teamId}`;
  const t = allTeams.find((item) => item.id === teamId);
  return t?.short_name || t?.name || `T${teamId}`;
}

function getPositionShortName(elementType: number): string {
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
      return "UNK";
  }
}

// ============================================================================
// 3. CORE SINGLE-PLAYER MULTI-GAMEWEEK PROJECTION
// ============================================================================

export interface ProjectPlayerMultiGwOptions {
  player: Record<string, any>;
  snapshot: PredictionSnapshot;
  allFixtures: Array<Record<string, any>>;
  allTeams?: Array<Record<string, any>> | null;
  history?: Array<Record<string, any>> | null;
  horizon?: number;
  discountFactors?: number[];
  calibrationCoeffs?: LinearCalibrationCoefficients | null;
  startGameweek?: number;
}

export function projectPlayerMultiGameweek(
  options: ProjectPlayerMultiGwOptions
): PlayerMultiGwProjection {
  const {
    player,
    snapshot,
    allFixtures,
    allTeams = null,
    history = null,
    horizon = DEFAULT_PROJECTION_HORIZON,
    discountFactors = Array.from(DEFAULT_DISCOUNT_FACTORS),
    calibrationCoeffs = null,
  } = options;

  const playerId = Number(player.id) || 0;
  const webName = player.web_name || `Player ${playerId}`;
  const elementType = Number(player.element_type) || 3;
  const positionShortName = getPositionShortName(elementType);
  const teamId = Number(player.team) || 0;
  const teamShortName = getTeamShortName(teamId, allTeams);

  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const startGw =
    options.startGameweek ??
    snapshot.boundary.prediction_gameweek ??
    (cutoffGw !== null ? cutoffGw + 1 : 1);

  // Pre-filter fixtures involving this player's team for faster horizon lookup
  const teamFixtures = Array.isArray(allFixtures)
    ? allFixtures.filter((f) => f.team_h === teamId || f.team_a === teamId)
    : [];

  const gameweekProjections: MultiGwGameweekProjection[] = [];
  const gameweekNumbers: number[] = [];

  let totalFixturesCount = 0;
  let bgwCount = 0;
  let dgwCount = 0;

  for (let offsetIndex = 0; offsetIndex < horizon; offsetIndex++) {
    const targetGw = startGw + offsetIndex;
    const gwOffset = offsetIndex + 1;
    gameweekNumbers.push(targetGw);

    // Find all official fixtures for targetGw
    const gwFixturesRaw = teamFixtures.filter((f) => f.event === targetGw);
    const fixtureCount = gwFixturesRaw.length;
    totalFixturesCount += fixtureCount;

    let gwType: "normal" | "blank" | "double" | "multiple" = "normal";
    if (fixtureCount === 0) {
      gwType = "blank";
      bgwCount++;
    } else if (fixtureCount === 1) {
      gwType = "normal";
    } else if (fixtureCount === 2) {
      gwType = "double";
      dgwCount++;
    } else {
      gwType = "multiple";
      dgwCount++;
    }

    if (fixtureCount === 0) {
      // Blank Gameweek (BGW) Exact Evaluation: 0 points, 0 minutes
      const bgwConfidence: MultiGwConfidence = {
        value: 1.0,
        uncertainty_range_low: 0.0,
        uncertainty_range_high: 0.0,
        sample_matches: Array.isArray(history) ? history.length : 0,
      };

      gameweekProjections.push({
        gameweek: targetGw,
        gw_offset: gwOffset,
        fixture_count: 0,
        gameweek_type: "blank",
        is_bgw: true,
        is_dgw: false,
        fixtures: [],
        expected_minutes: 0.0,
        probability_appearance: 0.0,
        probability_start: 0.0,
        probability_60_plus_minutes: 0.0,
        raw_expected_points: 0.0,
        calibrated_expected_points: null,
        expected_points: 0.0,
        calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
        validity: DataValidity.NOT_APPLICABLE,
        reason: "Blank gameweek; 0 expected points.",
        confidence: bgwConfidence,
      });
      continue;
    }

    // Target Prediction Snapshot for targetGw (Cutoff-Safe, Non-Mutating)
    const targetBoundary = new GameweekBoundary({
      last_finished_gameweek: snapshot.boundary.last_finished_gameweek,
      historical_cutoff_gameweek: snapshot.boundary.historical_cutoff_gameweek,
      in_progress_gameweek: snapshot.boundary.in_progress_gameweek,
      prediction_gameweek: targetGw,
    });

    const targetSnapshot = new PredictionSnapshot({
      snapshot_id: `${snapshot.snapshot_id}_gw${targetGw}`,
      boundary: targetBoundary,
      snapshot_created_at: snapshot.snapshot_created_at,
    });

    // 1. Build Prediction Features for targetGw (holding cutoff history constant)
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: targetSnapshot,
      history,
      allFixtures,
      allTeams,
    });

    // 2. Build Expected Minutes Model (Static forward role policy)
    const minutesResult = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: targetSnapshot,
      history,
    });

    // 3. Build Expected Points Model (Phase 4 fixture-level evaluator)
    const rawPointsResult = buildPlayerExpectedPoints({
      player,
      features,
      minutesResult,
      snapshot: targetSnapshot,
      history,
      allFixtures,
      allTeams,
    });

    // 4. Build Calibrated Expected Points (Phase 5)
    const calibratedResult = buildCalibratedExpectedPoints({
      player,
      rawResult: rawPointsResult,
      minutesResult,
      snapshot: targetSnapshot,
      calibrationCoeffs,
    });

    const isCalibratedActive =
      calibratedResult.calibration_status === CalibrationStatus.CALIBRATED &&
      calibratedResult.calibrated_expected_points.value !== null;

    const rawXpts = Number(rawPointsResult.expected_points_next_gameweek.value) || 0.0;
    const calXpts = isCalibratedActive
      ? Number(calibratedResult.calibrated_expected_points.value)
      : null;
    const decisionXpts = isCalibratedActive ? (calXpts ?? rawXpts) : rawXpts;

    // Construct Fixture-level projection items
    const fixtureItems: MultiGwFixtureItem[] = (
      rawPointsResult.breakdown?.fixtures || []
    ).map((fb) => {
      const oppTeamId = fb.opponent_team_id;
      const oppShortName = getTeamShortName(oppTeamId, allTeams);
      return {
        fixture_id: fb.fixture_id,
        gameweek: targetGw,
        opponent_team_id: oppTeamId,
        opponent_short_name: oppShortName,
        is_home: fb.is_home,
        difficulty: fb.difficulty,
        expected_minutes: fb.expected_minutes,
        probability_appearance: fb.probability_appearance,
        probability_start: minutesResult.breakdown.probabilities.probability_start,
        probability_60_plus_minutes: fb.probability_60_plus_minutes,
        expected_points: fb.fixture_expected_points,
        breakdown: fb,
      };
    });

    const gwConfidenceVal =
      rawPointsResult.expected_points_confidence.value !== null
        ? Number(rawPointsResult.expected_points_confidence.value)
        : 0.5;

    const uncertaintyRange = calibratedResult.uncertainty;
    const gwConfidence: MultiGwConfidence = {
      value: gwConfidenceVal,
      uncertainty_range_low: uncertaintyRange?.prediction_range_low ?? null,
      uncertainty_range_high: uncertaintyRange?.prediction_range_high ?? null,
      sample_matches:
        rawPointsResult.breakdown?.shrinkage_diagnostics?.sample_matches ?? 0,
    };

    gameweekProjections.push({
      gameweek: targetGw,
      gw_offset: gwOffset,
      fixture_count: fixtureCount,
      gameweek_type: gwType,
      is_bgw: fixtureCount === 0,
      is_dgw: fixtureCount >= 2,
      fixtures: fixtureItems,
      expected_minutes: Number(minutesResult.expected_minutes.value) || 0.0,
      probability_appearance:
        minutesResult.breakdown.probabilities.probability_appearance,
      probability_start: minutesResult.breakdown.probabilities.probability_start,
      probability_60_plus_minutes:
        minutesResult.breakdown.probabilities.probability_60_plus_minutes,
      raw_expected_points: roundTo(rawXpts, 2),
      calibrated_expected_points: calXpts !== null ? roundTo(calXpts, 2) : null,
      expected_points: roundTo(decisionXpts, 2),
      calibration_status: calibratedResult.calibration_status,
      validity: rawPointsResult.expected_points_next_gameweek.validity as DataValidity,
      reason: rawPointsResult.expected_points_next_gameweek.reason || "",
      confidence: gwConfidence,
    });
  }

  // 5. Aggregate Cumulative & Discounted Expected Points across Horizon
  let cumRawXpts = 0.0;
  let cumDecisionXpts = 0.0;

  for (const gp of gameweekProjections) {
    cumRawXpts += gp.raw_expected_points;
    cumDecisionXpts += gp.expected_points;
  }

  cumRawXpts = roundTo(cumRawXpts, 2);
  cumDecisionXpts = roundTo(cumDecisionXpts, 2);

  // Calculate Cumulative Horizon Sub-totals (GW1, GW3, GW5, GW8)
  const calculateCumSubHorizon = (subH: number): number => {
    const slice = gameweekProjections.slice(0, Math.min(subH, gameweekProjections.length));
    const sum = slice.reduce((acc, g) => acc + g.expected_points, 0);
    return roundTo(sum, 2);
  };

  const cumulativeHorizons: MultiGwHorizonsBreakdown = {
    gw1: calculateCumSubHorizon(1),
    gw3: calculateCumSubHorizon(3),
    gw5: calculateCumSubHorizon(5),
    ...(horizon >= 8 ? { gw8: calculateCumSubHorizon(8) } : {}),
  };

  // Calculate Discounted Horizon totals: SUM( gamma^(gw_offset - 1) * per_GW_xPts )
  const discountedExpectedPoints: Record<string, number> = {};
  const discountedHorizons: Record<string, MultiGwHorizonsBreakdown> = {};

  for (const factor of discountFactors) {
    const factorKey = factor.toFixed(2);
    let totalDiscounted = 0.0;

    for (let i = 0; i < gameweekProjections.length; i++) {
      const g = gameweekProjections[i];
      const discountWeight = Math.pow(factor, i);
      totalDiscounted += discountWeight * g.expected_points;
    }
    discountedExpectedPoints[factorKey] = roundTo(totalDiscounted, 2);

    const calcDiscSubHorizon = (subH: number): number => {
      let subSum = 0.0;
      const count = Math.min(subH, gameweekProjections.length);
      for (let i = 0; i < count; i++) {
        const discountWeight = Math.pow(factor, i);
        subSum += discountWeight * gameweekProjections[i].expected_points;
      }
      return roundTo(subSum, 2);
    };

    discountedHorizons[factorKey] = {
      gw1: calcDiscSubHorizon(1),
      gw3: calcDiscSubHorizon(3),
      gw5: calcDiscSubHorizon(5),
      ...(horizon >= 8 ? { gw8: calcDiscSubHorizon(8) } : {}),
    };
  }

  // Summary Confidence
  const confValues = gameweekProjections.map((g) => g.confidence.value);
  const avgConfidence =
    confValues.length > 0
      ? roundTo(confValues.reduce((a, b) => a + b, 0) / confValues.length, 3)
      : 0.0;
  const minConfidence = confValues.length > 0 ? Math.min(...confValues) : 0.0;

  const provenance: MultiGwProjectionProvenance = {
    player_id: playerId,
    snapshot_id: snapshot.snapshot_id,
    historical_cutoff_gameweek: cutoffGw,
    start_gameweek: startGw,
    horizon,
    gameweeks_projected: gameweekNumbers,
    models: {
      multi_gw_version: MULTI_GW_PROJECTION_VERSION,
      minutes_model_version: MINUTES_MODEL_VERSION,
      expected_points_model_version: EXPECTED_POINTS_MODEL_VERSION,
      calibration_version: CALIBRATION_MODEL_VERSION,
      uncertainty_version: UNCERTAINTY_MODEL_VERSION,
      scoring_rules_version: FPL_SCORING_RULES_VERSION,
    },
    generated_at: new Date().toISOString(),
  };

  return {
    player_id: playerId,
    web_name: webName,
    position_short_name: positionShortName,
    element_type: elementType,
    team_id: teamId,
    team_short_name: teamShortName,
    snapshot_id: snapshot.snapshot_id,
    cutoff_gameweek: cutoffGw,
    start_gameweek: startGw,
    horizon,
    gameweeks: gameweekProjections,
    cumulative_raw_xPts: cumRawXpts,
    cumulative_expected_points: cumDecisionXpts,
    discounted_expected_points: discountedExpectedPoints,
    cumulative_horizons: cumulativeHorizons,
    discounted_horizons: discountedHorizons,
    total_fixtures_count: totalFixturesCount,
    bgw_count: bgwCount,
    dgw_count: dgwCount,
    projection_method: "phase4_fixture_summation",
    role_assumption: FORWARD_ROLE_ASSUMPTION,
    availability_assumption: FORWARD_AVAILABILITY_ASSUMPTION,
    correlated_uncertainty_note: CORRELATED_UNCERTAINTY_NOTE,
    confidence_summary: {
      avg_confidence: avgConfidence,
      min_confidence: minConfidence,
    },
    provenance,
  };
}

// ============================================================================
// 4. BATCH / SQUAD PROJECTION SERVICES
// ============================================================================

export interface ProjectSquadMultiGwOptions {
  players: Array<Record<string, any>>;
  snapshot: PredictionSnapshot;
  allFixtures: Array<Record<string, any>>;
  allTeams?: Array<Record<string, any>> | null;
  playerHistories?: Record<number, Array<Record<string, any>>> | null;
  horizon?: number;
  discountFactors?: number[];
  calibrationCoeffs?: LinearCalibrationCoefficients | null;
  startGameweek?: number;
}

export function projectSquadMultiGameweek(
  options: ProjectSquadMultiGwOptions
): PlayerMultiGwProjection[] {
  const {
    players,
    snapshot,
    allFixtures,
    allTeams = null,
    playerHistories = null,
    horizon = DEFAULT_PROJECTION_HORIZON,
    discountFactors = Array.from(DEFAULT_DISCOUNT_FACTORS),
    calibrationCoeffs = null,
    startGameweek,
  } = options;

  return players.map((player) => {
    const history = playerHistories?.[player.id] ?? player.history ?? null;
    return projectPlayerMultiGameweek({
      player,
      snapshot,
      allFixtures,
      allTeams,
      history,
      horizon,
      discountFactors,
      calibrationCoeffs,
      startGameweek,
    });
  });
}
