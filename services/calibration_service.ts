import {
  DataValidity,
  PredictionRange,
  DataValue,
  DataValueDict,
  PredictionOutput,
  PredictionSnapshot,
  LEGACY_RANK_SCORE_SOURCE,
} from "./prediction_contract.js";
import { PlayerMinutesModelResult } from "./expected_minutes_model.js";
import {
  PlayerExpectedPointsResult,
  EXPECTED_POINTS_MODEL_VERSION,
  FPL_SCORING_RULES_VERSION,
} from "./expected_points_model.js";
import { CanonicalPlayerFeatures } from "./prediction_features.js";

export const CALIBRATION_MODEL_VERSION = "expected-points-calibration.v1";
export const UNCERTAINTY_MODEL_VERSION = "prediction-uncertainty.v1";

export enum CalibrationStatus {
  INSUFFICIENT_DATA = "insufficient_data",
  CALIBRATED = "calibrated",
  IDENTITY = "identity",
}

export enum CalibrationMethod {
  IDENTITY = "identity",
  LINEAR = "linear",
  POSITION_AWARE = "position_aware",
  ISOTONIC = "isotonic",
}

export enum UncertaintyMethod {
  EMPIRICAL_RESIDUAL_V1 = "empirical_residual_v1",
  POSITION_MINUTES_SCALED = "position_minutes_scaled",
}

export interface CalibrationThresholds {
  minSampleSize: number;
  minCompletedGameweeks: number;
  priorShrinkageWeight: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minSampleSize: 500,
  minCompletedGameweeks: 5,
  priorShrinkageWeight: 200,
};

export interface LinearCalibrationCoefficients {
  slope: number;
  intercept: number;
  raw_slope: number;
  raw_intercept: number;
  shrinkage_weight: number;
  sample_size: number;
  gameweeks_count: number;
  status: CalibrationStatus;
  reason: string;
}

export interface PositionCalibrationCoefficients {
  by_position: Record<number, LinearCalibrationCoefficients>;
  global: LinearCalibrationCoefficients;
  status: CalibrationStatus;
}

export interface PredictionUncertaintyResult {
  prediction_std_or_error_scale: number;
  prediction_range_low: number;
  prediction_range_high: number;
  uncertainty_method: UncertaintyMethod;
  diagnostics: {
    base_position_sigma: number;
    minutes_volatility_factor: number;
    sample_uncertainty_factor: number;
    points_scale_factor: number;
    fixture_count: number;
    is_bgw: boolean;
  };
}

export interface CalibratedExpectedPointsResult {
  player_id: number;
  raw_model_version: string;
  calibration_version: string;
  uncertainty_version: string;
  scoring_rules_version: string;

  raw_expected_points: DataValueDict;
  calibrated_expected_points: DataValueDict;
  expected_points_next_gameweek: DataValueDict; // Primary usable expected points (equals calibrated or raw)
  
  calibration_status: CalibrationStatus;
  calibration_method: CalibrationMethod;
  calibration_diagnostics: {
    applied_slope: number;
    applied_intercept: number;
    shrinkage_weight: number;
    status: CalibrationStatus;
    reason: string;
  };

  uncertainty: PredictionUncertaintyResult;
  prediction_confidence: DataValueDict;
  prediction_output: Record<string, any>;
  raw_result: PlayerExpectedPointsResult;
}

/**
 * Fits ordinary least squares linear regression with shrinkage toward identity (slope=1, intercept=0).
 */
export function fitLinearCalibration(
  dataset: Array<{ predicted: number; actual: number }>,
  gameweeksCount: number = 0,
  thresholds: CalibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS
): LinearCalibrationCoefficients {
  const n = dataset.length;

  if (n < thresholds.minSampleSize || gameweeksCount < thresholds.minCompletedGameweeks) {
    return {
      slope: 1.0,
      intercept: 0.0,
      raw_slope: 1.0,
      raw_intercept: 0.0,
      shrinkage_weight: 0.0,
      sample_size: n,
      gameweeks_count: gameweeksCount,
      status: CalibrationStatus.INSUFFICIENT_DATA,
      reason: `Insufficient sample size (${n} samples, ${gameweeksCount} GWs; required >= ${thresholds.minSampleSize} samples and >= ${thresholds.minCompletedGameweeks} GWs). Identity calibration maintained.`,
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (const row of dataset) {
    sumX += row.predicted;
    sumY += row.actual;
    sumXY += row.predicted * row.actual;
    sumX2 += row.predicted * row.predicted;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) {
    return {
      slope: 1.0,
      intercept: 0.0,
      raw_slope: 1.0,
      raw_intercept: 0.0,
      shrinkage_weight: 0.0,
      sample_size: n,
      gameweeks_count: gameweeksCount,
      status: CalibrationStatus.IDENTITY,
      reason: "Degenerate prediction variance. Identity calibration maintained.",
    };
  }

  const rawSlope = (n * sumXY - sumX * sumY) / denominator;
  const rawIntercept = (sumY - rawSlope * sumX) / n;

  // Shrinkage weight: w = N / (N + priorWeight)
  const shrinkageWeight = n / (n + thresholds.priorShrinkageWeight);
  const shrunkSlope = Math.round((shrinkageWeight * rawSlope + (1.0 - shrinkageWeight) * 1.0) * 10000) / 10000;
  const shrunkIntercept = Math.round((shrinkageWeight * rawIntercept + (1.0 - shrinkageWeight) * 0.0) * 10000) / 10000;

  return {
    slope: shrunkSlope,
    intercept: shrunkIntercept,
    raw_slope: Math.round(rawSlope * 10000) / 10000,
    raw_intercept: Math.round(rawIntercept * 10000) / 10000,
    shrinkage_weight: Math.round(shrinkageWeight * 10000) / 10000,
    sample_size: n,
    gameweeks_count: gameweeksCount,
    status: CalibrationStatus.CALIBRATED,
    reason: `Linear calibration fitted on ${n} samples across ${gameweeksCount} GWs with shrinkage weight ${Math.round(shrinkageWeight * 1000) / 1000}.`,
  };
}

/**
 * Calculates prediction uncertainty (std dev, lower and upper bounds)
 */
export function calculatePredictionUncertainty(options: {
  raw_expected_points: number;
  calibrated_expected_points: number;
  position_id: number;
  expected_minutes: number;
  probability_start: number;
  probability_appearance: number;
  probability_60_plus_minutes: number;
  playing_time_confidence: number;
  sample_matches: number;
  fixture_count?: number;
  is_bgw?: boolean;
}): PredictionUncertaintyResult {
  const {
    raw_expected_points,
    calibrated_expected_points,
    position_id,
    expected_minutes,
    probability_start,
    probability_appearance,
    probability_60_plus_minutes,
    playing_time_confidence,
    sample_matches,
    fixture_count = 1,
    is_bgw = false,
  } = options;

  // BGW (Blank Gameweek) Handling
  if (is_bgw || fixture_count === 0 || (raw_expected_points === 0 && probability_appearance === 0)) {
    return {
      prediction_std_or_error_scale: 0.0,
      prediction_range_low: 0.0,
      prediction_range_high: 0.0,
      uncertainty_method: UncertaintyMethod.POSITION_MINUTES_SCALED,
      diagnostics: {
        base_position_sigma: 0.0,
        minutes_volatility_factor: 0.0,
        sample_uncertainty_factor: 0.0,
        points_scale_factor: 0.0,
        fixture_count: 0,
        is_bgw: true,
      },
    };
  }

  // Base position dispersion parameter sigma_0:
  // GKP: 1.6, DEF: 1.9, MID: 2.3, FWD: 2.6
  let baseSigma = 2.0;
  if (position_id === 1) baseSigma = 1.6;
  else if (position_id === 2) baseSigma = 1.9;
  else if (position_id === 3) baseSigma = 2.3;
  else if (position_id === 4) baseSigma = 2.6;

  // Minutes volatility factor:
  // Solid starters have stable minutes -> factor ~1.0
  // Bench / rotation risks with high appearance chance but low start chance have wider outcome spread -> factor up to 1.35
  let minutesVolatilityFactor = 1.0;
  if (probability_appearance > 0.05) {
    const rotationRisk = Math.max(0, probability_appearance - probability_start);
    minutesVolatilityFactor = 1.0 + 0.35 * rotationRisk;
  } else {
    // Low probability players have lower absolute points spread
    minutesVolatilityFactor = Math.max(0.2, probability_appearance * 2.0);
  }

  // Sample maturity factor: small match history slightly widens uncertainty bounds
  const sampleUncertaintyFactor = 1.0 + 0.20 * Math.exp(-sample_matches / 4.0);

  // Expected points scaling factor: higher expected points carries larger absolute variance
  const pointsScaleFactor = 0.55 + 0.45 * Math.sqrt(Math.max(0.1, calibrated_expected_points) / 3.5);

  // DGW Multiplier: For 2 fixtures, variances add additively (sigma_DGW = sqrt(2) * sigma)
  const fixtureMultiplier = Math.sqrt(Math.max(1, fixture_count));

  // Compute final sigma (dispersion parameter)
  const totalSigma =
    baseSigma *
    fixtureMultiplier *
    minutesVolatilityFactor *
    sampleUncertaintyFactor *
    pointsScaleFactor;

  const roundedSigma = Math.round(totalSigma * 100) / 100;

  // Compute prediction interval bounds:
  // FPL outcomes are non-negative and right-skewed.
  // Lower bound: max(0, round(xPts - 1.28 * sigma))
  // Upper bound: round(xPts + 1.64 * sigma)
  const targetXpts = calibrated_expected_points;
  const rawLower = Math.max(0, targetXpts - 1.28 * roundedSigma);
  const rawUpper = Math.max(rawLower, targetXpts + 1.64 * roundedSigma);

  const roundedLower = Math.round(rawLower);
  const roundedUpper = Math.round(rawUpper);

  return {
    prediction_std_or_error_scale: roundedSigma,
    prediction_range_low: roundedLower,
    prediction_range_high: roundedUpper,
    uncertainty_method: UncertaintyMethod.POSITION_MINUTES_SCALED,
    diagnostics: {
      base_position_sigma: baseSigma,
      minutes_volatility_factor: Math.round(minutesVolatilityFactor * 1000) / 1000,
      sample_uncertainty_factor: Math.round(sampleUncertaintyFactor * 1000) / 1000,
      points_scale_factor: Math.round(pointsScaleFactor * 1000) / 1000,
      fixture_count,
      is_bgw: false,
    },
  };
}

/**
 * Builds calibrated Expected Points, Uncertainty, and Confidence from Phase 4 outputs.
 */
export function buildCalibratedExpectedPoints(options: {
  player: Record<string, any>;
  rawResult: PlayerExpectedPointsResult;
  minutesResult: PlayerMinutesModelResult;
  snapshot: PredictionSnapshot;
  calibrationCoeffs?: LinearCalibrationCoefficients | null;
  thresholds?: CalibrationThresholds;
}): CalibratedExpectedPointsResult {
  const {
    player,
    rawResult,
    minutesResult,
    snapshot,
    calibrationCoeffs = null,
    thresholds = DEFAULT_CALIBRATION_THRESHOLDS,
  } = options;

  const rawXpts = Number(rawResult.expected_points_next_gameweek.value);
  const rawValidity = rawResult.expected_points_next_gameweek.validity as DataValidity;
  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const predGw = snapshot.boundary.prediction_gameweek;

  let appliedSlope = 1.0;
  let appliedIntercept = 0.0;
  let appliedShrinkage = 0.0;
  let calStatus = CalibrationStatus.INSUFFICIENT_DATA;
  let calReason = "Default early-season identity calibration applied (insufficient empirical data).";
  let calMethod = CalibrationMethod.IDENTITY;

  let calibratedXptsValue: number | null = rawXpts;

  if (rawValidity === DataValidity.MISSING || rawValidity === DataValidity.NOT_APPLICABLE) {
    calibratedXptsValue = null;
    calStatus = CalibrationStatus.IDENTITY;
    calReason = "Not applicable or missing raw expected points.";
  } else if (rawValidity === DataValidity.OBSERVED_ZERO) {
    calibratedXptsValue = 0;
    calStatus = CalibrationStatus.IDENTITY;
    calReason = "Observed zero expected points maintained.";
  } else if (calibrationCoeffs && calibrationCoeffs.status === CalibrationStatus.CALIBRATED) {
    appliedSlope = calibrationCoeffs.slope;
    appliedIntercept = calibrationCoeffs.intercept;
    appliedShrinkage = calibrationCoeffs.shrinkage_weight;
    calStatus = CalibrationStatus.CALIBRATED;
    calMethod = CalibrationMethod.LINEAR;
    calReason = calibrationCoeffs.reason;

    // Apply linear transformation: y = max(0, intercept + slope * x)
    const transformed = Math.max(0, appliedIntercept + appliedSlope * rawXpts);
    calibratedXptsValue = Math.round(transformed * 100) / 100;
  }

  // Construct Calibrated Expected Points Envelope
  let calValidity: DataValidity = rawValidity;
  if (calibratedXptsValue === 0 && rawValidity === DataValidity.DERIVED) {
    calValidity = DataValidity.OBSERVED_ZERO;
  }

  const calibratedEnvelope = new DataValue({
    value: calibratedXptsValue,
    validity: calValidity,
    source: CALIBRATION_MODEL_VERSION,
    as_of_gameweek: cutoffGw,
    reason: calReason,
  });

  // Calculate Prediction Uncertainty
  const breakdown = rawResult.breakdown;
  const sampleMatches = breakdown?.shrinkage_diagnostics?.sample_matches ?? 0;
  const positionId = breakdown?.position_id ?? (player.element_type || 3);
  const fixtureCount = breakdown?.fixture_count ?? 1;
  const isBgw = breakdown?.gameweek_type === "blank" || fixtureCount === 0;

  const uncertainty = calculatePredictionUncertainty({
    raw_expected_points: rawXpts,
    calibrated_expected_points: calibratedXptsValue ?? 0,
    position_id: positionId,
    expected_minutes: Number(minutesResult.expected_minutes.value) || 0,
    probability_start: minutesResult.breakdown.probabilities.probability_start,
    probability_appearance: minutesResult.breakdown.probabilities.probability_appearance,
    probability_60_plus_minutes: minutesResult.breakdown.probabilities.probability_60_plus_minutes,
    playing_time_confidence: Number(minutesResult.playing_time_confidence.value) || 0,
    sample_matches: sampleMatches,
    fixture_count: fixtureCount,
    is_bgw: isBgw,
  });

  // Construct PredictionRange object for Phase 0 PredictionOutput
  let rangeValidity = DataValidity.DERIVED;
  if (isBgw || rawValidity === DataValidity.NOT_APPLICABLE) {
    rangeValidity = DataValidity.NOT_APPLICABLE;
  } else if (rawValidity === DataValidity.MISSING) {
    rangeValidity = DataValidity.MISSING;
  } else if (uncertainty.prediction_range_low === 0 && uncertainty.prediction_range_high === 0 && rawValidity === DataValidity.OBSERVED_ZERO) {
    rangeValidity = DataValidity.OBSERVED_ZERO;
  }

  const predictionRangeObj = new PredictionRange({
    lower: rangeValidity === DataValidity.MISSING || rangeValidity === DataValidity.NOT_APPLICABLE ? null : uncertainty.prediction_range_low,
    upper: rangeValidity === DataValidity.MISSING || rangeValidity === DataValidity.NOT_APPLICABLE ? null : uncertainty.prediction_range_high,
    validity: rangeValidity,
    reason: `Calculated via ${UNCERTAINTY_MODEL_VERSION} with std error scale ${uncertainty.prediction_std_or_error_scale}.`,
  });

  // Legacy score envelope
  const legacyScoreVal = player.expert_score !== undefined ? Number(player.expert_score) : null;
  const legacyScoreEnvelope = new DataValue({
    value: legacyScoreVal,
    validity: legacyScoreVal !== null ? DataValidity.DERIVED : DataValidity.MISSING,
    source: LEGACY_RANK_SCORE_SOURCE,
    as_of_gameweek: cutoffGw,
    reason: "Legacy relative ranking score; not expected FPL points.",
  });

  // Updated PredictionOutput contract with populated prediction_range
  const predictionOutputObj = new PredictionOutput({
    player_id: player.id,
    snapshot_id: snapshot.snapshot_id,
    last_finished_gameweek: snapshot.boundary.last_finished_gameweek,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    expected_points_next_gameweek: calibratedEnvelope,
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
      value: rawResult.expected_points_confidence.value,
      validity: rawResult.expected_points_confidence.validity as DataValidity,
      source: rawResult.expected_points_confidence.source,
      as_of_gameweek: rawResult.expected_points_confidence.as_of_gameweek,
      reason: rawResult.expected_points_confidence.reason,
    }),
    prediction_range: predictionRangeObj,
  });

  return {
    player_id: player.id,
    raw_model_version: EXPECTED_POINTS_MODEL_VERSION,
    calibration_version: CALIBRATION_MODEL_VERSION,
    uncertainty_version: UNCERTAINTY_MODEL_VERSION,
    scoring_rules_version: FPL_SCORING_RULES_VERSION,

    raw_expected_points: rawResult.expected_points_next_gameweek,
    calibrated_expected_points: calibratedEnvelope.toDict(),
    expected_points_next_gameweek: calibratedEnvelope.toDict(),

    calibration_status: calStatus,
    calibration_method: calMethod,
    calibration_diagnostics: {
      applied_slope: appliedSlope,
      applied_intercept: appliedIntercept,
      shrinkage_weight: appliedShrinkage,
      status: calStatus,
      reason: calReason,
    },

    uncertainty,
    prediction_confidence: rawResult.expected_points_confidence,
    prediction_output: predictionOutputObj.toDict(),
    raw_result: rawResult,
  };
}

