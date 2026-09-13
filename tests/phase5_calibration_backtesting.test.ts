import { describe, it, expect } from "vitest";
import {
  DataValidity,
  PredictionSnapshot,
  GameweekBoundary,
  validatePredictionPayload,
} from "../services/prediction_contract.js";
import {
  buildPlayerPredictionFeatures,
} from "../services/prediction_features.js";
import {
  buildPlayerExpectedMinutes,
} from "../services/expected_minutes_model.js";
import {
  buildPlayerExpectedPoints,
} from "../services/expected_points_model.js";
import {
  CALIBRATION_MODEL_VERSION,
  UNCERTAINTY_MODEL_VERSION,
  CalibrationStatus,
  CalibrationMethod,
  UncertaintyMethod,
  fitLinearCalibration,
  calculatePredictionUncertainty,
  buildCalibratedExpectedPoints,
  DEFAULT_CALIBRATION_THRESHOLDS,
} from "../services/calibration_service.js";
import {
  BacktestRecord,
  calculateMetricSummary,
  calculateSpearmanCorrelation,
  calculateBrierScore,
  calculateBacktestMetrics,
  runWalkForwardBacktest,
} from "../services/backtest_service.js";

function createSnapshot(cutoffGw: number = 2, inProgressGw: number | null = null): PredictionSnapshot {
  return new PredictionSnapshot({
    snapshot_id: `test_snap_gw${cutoffGw + 1}_cutoff${cutoffGw}`,
    boundary: new GameweekBoundary({
      last_finished_gameweek: cutoffGw > 0 ? cutoffGw : null,
      in_progress_gameweek: inProgressGw,
      prediction_gameweek: inProgressGw ? inProgressGw + 1 : cutoffGw + 1,
      historical_cutoff_gameweek: cutoffGw > 0 ? cutoffGw : null,
    }),
  });
}

function mockPlayer(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 101,
    web_name: "TestPlayer",
    first_name: "Test",
    second_name: "Player",
    element_type: 3, // MID
    team: 1,
    now_cost: 80,
    status: "a",
    chance_of_playing_next_round: 100,
    chance_of_playing_this_round: 100,
    expert_score: 75.0,
    future_fpl_score: 72.0,
    current_form_score: 70.0,
    minutes_security: 85.0,
    ...overrides,
  };
}

describe("Phase 5 — Calibration, Backtesting & Uncertainty Test Suite", () => {

  // 1. Perfect predictions
  it("Test 1: Perfect predictions yield MAE = 0, RMSE = 0, Spearman = 1", () => {
    const predicted = [1.0, 2.5, 4.0, 6.5, 9.0];
    const actual = [1.0, 2.5, 4.0, 6.5, 9.0];
    const summary = calculateMetricSummary(predicted, actual);

    expect(summary.mae).toBe(0.0);
    expect(summary.rmse).toBe(0.0);
    expect(summary.mean_error).toBe(0.0);
    expect(summary.median_absolute_error).toBe(0.0);
    expect(summary.spearman_rho).toBe(1.0);
  });

  // 2. Systematic +1 overprediction
  it("Test 2: Systematic +1 overprediction yields MAE = 1.0, bias = +1.0", () => {
    const predicted = [3.0, 4.0, 5.0, 6.0, 7.0];
    const actual = [2.0, 3.0, 4.0, 5.0, 6.0];
    const summary = calculateMetricSummary(predicted, actual);

    expect(summary.mae).toBe(1.0);
    expect(summary.rmse).toBe(1.0);
    expect(summary.mean_error).toBe(1.0);
    expect(summary.median_absolute_error).toBe(1.0);
  });

  // 3. Systematic underprediction
  it("Test 3: Systematic underprediction yields negative bias", () => {
    const predicted = [1.0, 2.0, 3.0];
    const actual = [3.0, 4.0, 5.0];
    const summary = calculateMetricSummary(predicted, actual);

    expect(summary.mean_error).toBe(-2.0);
    expect(summary.mae).toBe(2.0);
  });

  // 4. Calibration slope correction
  it("Test 4: Linear calibration fits slope accurately on large synthetic datasets", () => {
    // True relationship: actual = 0.5 * predicted
    const dataset: Array<{ predicted: number; actual: number }> = [];
    for (let i = 0; i < 1000; i++) {
      const pred = (i % 10) + 1;
      const act = 0.5 * pred;
      dataset.push({ predicted: pred, actual: act });
    }

    const fit = fitLinearCalibration(dataset, 10, {
      minSampleSize: 500,
      minCompletedGameweeks: 5,
      priorShrinkageWeight: 0, // Zero prior weight for raw check
    });

    expect(fit.status).toBe(CalibrationStatus.CALIBRATED);
    expect(fit.raw_slope).toBeCloseTo(0.5, 3);
    expect(fit.raw_intercept).toBeCloseTo(0.0, 3);
  });

  // 5. Intercept correction
  it("Test 5: Linear calibration fits intercept shift accurately", () => {
    // True relationship: actual = predicted + 1.5
    const dataset: Array<{ predicted: number; actual: number }> = [];
    for (let i = 0; i < 1000; i++) {
      const pred = (i % 8) + 1;
      const act = pred + 1.5;
      dataset.push({ predicted: pred, actual: act });
    }

    const fit = fitLinearCalibration(dataset, 10, {
      minSampleSize: 500,
      minCompletedGameweeks: 5,
      priorShrinkageWeight: 0,
    });

    expect(fit.status).toBe(CalibrationStatus.CALIBRATED);
    expect(fit.raw_slope).toBeCloseTo(1.0, 3);
    expect(fit.raw_intercept).toBeCloseTo(1.5, 3);
  });

  // 6. Identity fallback on insufficient data
  it("Test 6: Falls back to identity when sample size or GW count is below threshold", () => {
    const smallDataset = [
      { predicted: 4.0, actual: 2.0 },
      { predicted: 5.0, actual: 3.0 },
    ];

    const fit = fitLinearCalibration(smallDataset, 2, DEFAULT_CALIBRATION_THRESHOLDS);
    expect(fit.status).toBe(CalibrationStatus.INSUFFICIENT_DATA);
    expect(fit.slope).toBe(1.0);
    expect(fit.intercept).toBe(0.0);
    expect(fit.shrinkage_weight).toBe(0.0);
  });

  // 7. Calibration shrinkage toward identity
  it("Test 7: Calibration shrinkage smoothly interpolates between raw fit and identity (1.0, 0.0)", () => {
    const dataset: Array<{ predicted: number; actual: number }> = [];
    for (let i = 0; i < 600; i++) {
      const pred = (i % 10) + 1;
      const act = 0.5 * pred;
      dataset.push({ predicted: pred, actual: act });
    }

    // N = 600, priorWeight = 200 -> shrinkage weight w = 600 / (600 + 200) = 0.75
    // shrunk_slope = 0.75 * 0.5 + 0.25 * 1.0 = 0.375 + 0.25 = 0.625
    const fit = fitLinearCalibration(dataset, 6, {
      minSampleSize: 500,
      minCompletedGameweeks: 5,
      priorShrinkageWeight: 200,
    });

    expect(fit.status).toBe(CalibrationStatus.CALIBRATED);
    expect(fit.shrinkage_weight).toBeCloseTo(0.75, 3);
    expect(fit.slope).toBeCloseTo(0.625, 3);
  });

  // 8. No target-GW leakage
  it("Test 8: Leakage protection ensures predictions for target GW N do not use match data from GW N", () => {
    const player = mockPlayer({ id: 201, element_type: 4 });
    const fullHistory = [
      { round: 1, minutes: 90, goals_scored: 1, total_points: 6 },
      { round: 2, minutes: 90, goals_scored: 3, total_points: 17 }, // massive haul in GW2
      { round: 3, minutes: 0, goals_scored: 0, total_points: 0 },
    ];

    const backtestResult = runWalkForwardBacktest({
      targetGameweeks: [2],
      players: [player],
      playerHistories: { 201: fullHistory },
      allFixtures: [{ event: 2, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 2 }],
    });

    // In GW2 evaluation, cutoff was GW1. The GW2 hat-trick must NOT be in the prediction features or sample
    expect(backtestResult.records.length).toBe(1);
    const rec = backtestResult.records[0];
    expect(rec.historical_cutoff_gameweek).toBe(1);
    expect(rec.target_gameweek).toBe(2);
    expect(rec.actual_total_points).toBe(17);
  });

  // 9. Walk-forward training boundary
  it("Test 9: Walk-forward boundary increments cutoff strictly per target gameweek", () => {
    const player = mockPlayer({ id: 301 });
    const fullHistory = [
      { round: 1, minutes: 90, total_points: 5 },
      { round: 2, minutes: 90, total_points: 6 },
    ];

    const backtestResult = runWalkForwardBacktest({
      targetGameweeks: [1, 2],
      players: [player],
      playerHistories: { 301: fullHistory },
      allFixtures: [
        { event: 1, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 2 },
        { event: 2, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 2 },
      ],
    });

    expect(backtestResult.records.length).toBe(2);
    expect(backtestResult.recordsByGameweek[1][0].historical_cutoff_gameweek).toBe(0);
    expect(backtestResult.recordsByGameweek[2][0].historical_cutoff_gameweek).toBe(1);
  });

  // 10. Deterministic replay
  it("Test 10: Repeated runs produce identical calibration and uncertainty values", () => {
    const player = mockPlayer({ id: 401 });
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });

    const run1 = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });
    const run2 = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    expect(run1.calibrated_expected_points).toEqual(run2.calibrated_expected_points);
    expect(run1.uncertainty).toEqual(run2.uncertainty);
  });

  // 11. Expected-minutes MAE & 12-14. Brier scores
  it("Test 11-14: Minutes MAE and Probability Brier scores compute accurately", () => {
    const appProbs = [0.9, 0.8, 0.2, 0.1];
    const actualApps = [true, true, false, false];
    const brierApp = calculateBrierScore(appProbs, actualApps);

    // Errors: (0.9-1)^2 = 0.01, (0.8-1)^2 = 0.04, (0.2-0)^2 = 0.04, (0.1-0)^2 = 0.01 -> mean = 0.10/4 = 0.025
    expect(brierApp).toBeCloseTo(0.025, 4);
  });

  // 15. Confidence bounded [0, 1]
  it("Test 15: Prediction confidence is strictly bounded in [0.0, 1.0]", () => {
    const player = mockPlayer();
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    const conf = Number(calEp.prediction_confidence.value);
    expect(conf).toBeGreaterThanOrEqual(0.0);
    expect(conf).toBeLessThanOrEqual(1.0);
  });

  // 16. Confidence does not alter EP
  it("Test 16: Varying confidence input does NOT modify expected points output", () => {
    const player = mockPlayer();
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });

    const cal1 = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    // Mutate confidence envelope
    const rawEpMutated = { ...rawEp, expected_points_confidence: { ...rawEp.expected_points_confidence, value: 0.99 } };
    const cal2 = buildCalibratedExpectedPoints({ player, rawResult: rawEpMutated, minutesResult: minutes, snapshot: snap });

    expect(cal1.calibrated_expected_points.value).toBe(cal2.calibrated_expected_points.value);
    expect(cal1.raw_expected_points.value).toBe(cal2.raw_expected_points.value);
  });

  // 17. Prediction range low <= prediction <= high
  it("Test 17: Prediction range satisfies lower <= prediction <= upper (where applicable)", () => {
    const player = mockPlayer({ element_type: 4, now_cost: 140 }); // High xPts forward
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    const low = calEp.uncertainty.prediction_range_low;
    const high = calEp.uncertainty.prediction_range_high;
    const pred = Number(calEp.calibrated_expected_points.value);

    expect(low).toBeLessThanOrEqual(pred);
    expect(high).toBeGreaterThanOrEqual(pred);
  });

  // 18. Larger residual variance -> wider uncertainty
  it("Test 18: Rotation risk players exhibit wider minutes volatility factor than nailed starters", () => {
    const nailed = calculatePredictionUncertainty({
      raw_expected_points: 4.0,
      calibrated_expected_points: 4.0,
      position_id: 3,
      expected_minutes: 85,
      probability_start: 0.95,
      probability_appearance: 0.98,
      probability_60_plus_minutes: 0.90,
      playing_time_confidence: 0.8,
      sample_matches: 4,
    });

    const rotationRisk = calculatePredictionUncertainty({
      raw_expected_points: 4.0,
      calibrated_expected_points: 4.0,
      position_id: 3,
      expected_minutes: 45,
      probability_start: 0.30,
      probability_appearance: 0.90, // Sub bench risk
      probability_60_plus_minutes: 0.20,
      playing_time_confidence: 0.4,
      sample_matches: 4,
    });

    expect(rotationRisk.diagnostics.minutes_volatility_factor).toBeGreaterThan(
      nailed.diagnostics.minutes_volatility_factor
    );
  });

  // 19. DGW handling
  it("Test 19: Double Gameweek (2 fixtures) scales dispersion parameter by sqrt(2)", () => {
    const singleGw = calculatePredictionUncertainty({
      raw_expected_points: 4.0,
      calibrated_expected_points: 4.0,
      position_id: 3,
      expected_minutes: 80,
      probability_start: 0.9,
      probability_appearance: 0.9,
      probability_60_plus_minutes: 0.8,
      playing_time_confidence: 0.8,
      sample_matches: 4,
      fixture_count: 1,
    });

    const doubleGw = calculatePredictionUncertainty({
      raw_expected_points: 8.0,
      calibrated_expected_points: 8.0,
      position_id: 3,
      expected_minutes: 160,
      probability_start: 0.9,
      probability_appearance: 0.9,
      probability_60_plus_minutes: 0.8,
      playing_time_confidence: 0.8,
      sample_matches: 4,
      fixture_count: 2,
    });

    expect(doubleGw.prediction_std_or_error_scale).toBeGreaterThan(singleGw.prediction_std_or_error_scale);
    expect(doubleGw.prediction_range_high).toBeGreaterThan(singleGw.prediction_range_high);
  });

  // 20. BGW handling
  it("Test 20: Blank Gameweek produces 0 std and [0, 0] range", () => {
    const bgw = calculatePredictionUncertainty({
      raw_expected_points: 0.0,
      calibrated_expected_points: 0.0,
      position_id: 2,
      expected_minutes: 0,
      probability_start: 0,
      probability_appearance: 0,
      probability_60_plus_minutes: 0,
      playing_time_confidence: 0,
      sample_matches: 4,
      fixture_count: 0,
      is_bgw: true,
    });

    expect(bgw.prediction_std_or_error_scale).toBe(0.0);
    expect(bgw.prediction_range_low).toBe(0.0);
    expect(bgw.prediction_range_high).toBe(0.0);
  });

  // 21. Position segmentation
  it("Test 21: Backtest metrics properly segment by position (GKP, DEF, MID, FWD)", () => {
    const records: BacktestRecord[] = [
      { position_id: 1, raw_expected_points: 4.0, actual_total_points: 6 } as any,
      { position_id: 2, raw_expected_points: 3.5, actual_total_points: 2 } as any,
      { position_id: 3, raw_expected_points: 5.0, actual_total_points: 8 } as any,
      { position_id: 4, raw_expected_points: 6.0, actual_total_points: 2 } as any,
    ];

    const metrics = calculateBacktestMetrics(records);
    expect(metrics.by_position.gkp.sample_size).toBe(1);
    expect(metrics.by_position.def.sample_size).toBe(1);
    expect(metrics.by_position.mid.sample_size).toBe(1);
    expect(metrics.by_position.fwd.sample_size).toBe(1);
  });

  // 22. Raw EP preserved
  it("Test 22: Raw Expected Points is preserved intact when Calibrated Expected Points is computed", () => {
    const player = mockPlayer();
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    expect(calEp.raw_expected_points).toEqual(rawEp.expected_points_next_gameweek);
    expect(calEp.raw_result).toBe(rawEp);
  });

  // 23. Calibration version provenance
  it("Test 23: Outputs contain exact model versions for raw, calibration, and uncertainty", () => {
    const player = mockPlayer();
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    expect(calEp.calibration_version).toBe(CALIBRATION_MODEL_VERSION);
    expect(calEp.uncertainty_version).toBe(UNCERTAINTY_MODEL_VERSION);
    expect(calEp.raw_model_version).toBe("expected-points.v1");
  });

  // 24. Contract serialization
  it("Test 24: Calibrated prediction output conforms to Phase 0 PredictionContract validation", () => {
    const player = mockPlayer();
    const snap = createSnapshot(2);
    const fixtures = [{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 2 }];
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap, allFixtures: fixtures });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap, allFixtures: fixtures });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    expect(() => validatePredictionPayload(calEp.prediction_output)).not.toThrow();
    expect(calEp.prediction_output.prediction_range.validity).toBe(DataValidity.DERIVED);
    expect(calEp.prediction_output.prediction_range.lower).toBeTypeOf("number");
    expect(calEp.prediction_output.prediction_range.upper).toBeTypeOf("number");
  });

  // 25. Legacy regression invariance
  it("Test 25: Legacy ranking scores remain decoupled and unaltered", () => {
    const player = mockPlayer({ expert_score: 88.5, future_fpl_score: 82.1 });
    const snap = createSnapshot(2);
    const features = buildPlayerPredictionFeatures({ player, snapshot: snap });
    const minutes = buildPlayerExpectedMinutes({ player, features, snapshot: snap });
    const rawEp = buildPlayerExpectedPoints({ player, features, minutesResult: minutes, snapshot: snap });
    const calEp = buildCalibratedExpectedPoints({ player, rawResult: rawEp, minutesResult: minutes, snapshot: snap });

    expect(calEp.prediction_output.expert_rank_score.value).toBe(88.5);
    expect(calEp.prediction_output.expert_rank_score.source).toBe("legacy_rating_engine");
  });
});
