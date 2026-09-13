import {
  GameweekBoundary,
  PredictionSnapshot,
  DataValidity,
} from "./prediction_contract.js";
import {
  buildPlayerPredictionFeatures,
  CanonicalPlayerFeatures,
} from "./prediction_features.js";
import {
  buildPlayerExpectedMinutes,
  PlayerMinutesModelResult,
} from "./expected_minutes_model.js";
import {
  buildPlayerExpectedPoints,
  PlayerExpectedPointsResult,
} from "./expected_points_model.js";
import {
  buildCalibratedExpectedPoints,
  CalibratedExpectedPointsResult,
  LinearCalibrationCoefficients,
  fitLinearCalibration,
  CalibrationThresholds,
  DEFAULT_CALIBRATION_THRESHOLDS,
} from "./calibration_service.js";

export interface BacktestRecord {
  player_id: number;
  web_name: string;
  team_id: number;
  position_id: number;
  target_gameweek: number;
  historical_cutoff_gameweek: number;

  // Phase 3 predictions
  expected_minutes: number;
  probability_start: number;
  probability_appearance: number;
  probability_60_plus_minutes: number;
  playing_time_confidence: number;

  // Phase 4 predictions
  raw_expected_points: number;
  expected_goals: number;
  expected_assists: number;
  probability_clean_sheet: number;
  probability_defensive_contribution: number;
  expected_bonus: number;
  expected_saves: number;
  expected_points_confidence: number;

  // Phase 5 predictions
  calibrated_expected_points: number;
  prediction_std: number;
  prediction_range_low: number;
  prediction_range_high: number;

  // Realised outcomes in target_gameweek
  actual_minutes: number;
  actual_started: boolean;
  actual_appeared: boolean;
  actual_60_plus: boolean;
  actual_goals: number;
  actual_assists: number;
  actual_clean_sheet: boolean;
  actual_defensive_contribution: number;
  actual_bonus: number;
  actual_saves: number;
  actual_yellow_cards: number;
  actual_red_cards: number;
  actual_own_goals: number;
  actual_penalties_missed: number;
  actual_total_points: number;
}

export interface MetricSummary {
  sample_size: number;
  mae: number;
  rmse: number;
  mean_error: number; // Bias = mean(predicted - actual)
  median_absolute_error: number;
  spearman_rho: number;
}

export interface CalibrationBinSummary {
  bin_label: string;
  min_xpts: number;
  max_xpts: number;
  sample_count: number;
  mean_predicted: number;
  mean_actual: number;
  bias: number;
}

export interface ConfidenceBucketSummary {
  confidence_bucket: string;
  min_confidence: number;
  max_confidence: number;
  sample_count: number;
  mean_confidence: number;
  mae: number;
  rmse: number;
}

export interface BacktestMetrics {
  sample_size: number;
  overall_raw_metrics: MetricSummary;
  overall_calibrated_metrics: MetricSummary;

  top_10_mean_predicted: number;
  top_10_mean_actual: number;
  top_20_mean_predicted: number;
  top_20_mean_actual: number;

  by_position: {
    gkp: MetricSummary;
    def: MetricSummary;
    mid: MetricSummary;
    fwd: MetricSummary;
  };

  by_minutes_band: {
    band_0_15: MetricSummary;
    band_15_60: MetricSummary;
    band_60_90: MetricSummary;
  };

  calibration_bins: CalibrationBinSummary[];

  phase3_metrics: {
    minutes_mae: number;
    minutes_rmse: number;
    minutes_bias: number;
    appearance_brier: number;
    start_brier: number;
    sixty_plus_brier: number;
  };

  component_diagnostics: {
    goals_error_mean: number;
    assists_error_mean: number;
    clean_sheet_brier: number;
    def_contrib_brier: number;
    bonus_error_mean: number;
    saves_error_mean: number;
  };

  confidence_error_analysis: ConfidenceBucketSummary[];
}

/**
 * Computes Spearman Rank Correlation Coefficient between two numeric series.
 */
export function calculateSpearmanCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0.0;

  const n = x.length;

  const getRanks = (arr: number[]): number[] => {
    const indexed = arr.map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => a.val - b.val);

    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j < n - 1 && indexed[j + 1].val === indexed[j].val) {
        j++;
      }
      const rank = 1 + (i + j) / 2.0;
      for (let k = i; k <= j; k++) {
        ranks[indexed[k].idx] = rank;
      }
      i = j + 1;
    }
    return ranks;
  };

  const rx = getRanks(x);
  const ry = getRanks(y);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const diff = rx[i] - ry[i];
    sumD2 += diff * diff;
  }

  const rho = 1.0 - (6.0 * sumD2) / (n * (n * n - 1));
  return Math.round(rho * 1000) / 1000;
}

/**
 * Computes Brier Score: 1/N * sum((probability - actual)^2)
 */
export function calculateBrierScore(probabilities: number[], actuals: (number | boolean)[]): number {
  if (probabilities.length === 0 || probabilities.length !== actuals.length) return 0.0;
  const n = probabilities.length;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const act = typeof actuals[i] === "boolean" ? (actuals[i] ? 1.0 : 0.0) : Number(actuals[i]);
    const err = probabilities[i] - act;
    sumSq += err * err;
  }
  return Math.round((sumSq / n) * 10000) / 10000;
}

/**
 * Computes a standard MetricSummary for a predicted series vs actual points.
 */
export function calculateMetricSummary(predicted: number[], actual: number[]): MetricSummary {
  const n = predicted.length;
  if (n === 0) {
    return {
      sample_size: 0,
      mae: 0.0,
      rmse: 0.0,
      mean_error: 0.0,
      median_absolute_error: 0.0,
      spearman_rho: 0.0,
    };
  }

  let sumAbsErr = 0;
  let sumSqErr = 0;
  let sumErr = 0;
  const absErrors: number[] = [];

  for (let i = 0; i < n; i++) {
    const err = predicted[i] - actual[i];
    const absErr = Math.abs(err);
    sumErr += err;
    sumAbsErr += absErr;
    sumSqErr += err * err;
    absErrors.push(absErr);
  }

  absErrors.sort((a, b) => a - b);
  const medianAbsErr =
    n % 2 === 1
      ? absErrors[Math.floor(n / 2)]
      : (absErrors[n / 2 - 1] + absErrors[n / 2]) / 2.0;

  return {
    sample_size: n,
    mae: Math.round((sumAbsErr / n) * 1000) / 1000,
    rmse: Math.round(Math.sqrt(sumSqErr / n) * 1000) / 1000,
    mean_error: Math.round((sumErr / n) * 1000) / 1000,
    median_absolute_error: Math.round(medianAbsErr * 1000) / 1000,
    spearman_rho: calculateSpearmanCorrelation(predicted, actual),
  };
}

/**
 * Calculates full BacktestMetrics across a dataset of BacktestRecord rows.
 */
export function calculateBacktestMetrics(records: BacktestRecord[]): BacktestMetrics {
  const n = records.length;
  if (n === 0) {
    const emptySummary: MetricSummary = {
      sample_size: 0,
      mae: 0,
      rmse: 0,
      mean_error: 0,
      median_absolute_error: 0,
      spearman_rho: 0,
    };
    return {
      sample_size: 0,
      overall_raw_metrics: emptySummary,
      overall_calibrated_metrics: emptySummary,
      top_10_mean_predicted: 0,
      top_10_mean_actual: 0,
      top_20_mean_predicted: 0,
      top_20_mean_actual: 0,
      by_position: { gkp: emptySummary, def: emptySummary, mid: emptySummary, fwd: emptySummary },
      by_minutes_band: { band_0_15: emptySummary, band_15_60: emptySummary, band_60_90: emptySummary },
      calibration_bins: [],
      phase3_metrics: {
        minutes_mae: 0,
        minutes_rmse: 0,
        minutes_bias: 0,
        appearance_brier: 0,
        start_brier: 0,
        sixty_plus_brier: 0,
      },
      component_diagnostics: {
        goals_error_mean: 0,
        assists_error_mean: 0,
        clean_sheet_brier: 0,
        def_contrib_brier: 0,
        bonus_error_mean: 0,
        saves_error_mean: 0,
      },
      confidence_error_analysis: [],
    };
  }

  const rawPreds = records.map((r) => r.raw_expected_points);
  const calPreds = records.map((r) => r.calibrated_expected_points);
  const actualPoints = records.map((r) => r.actual_total_points);

  const overallRaw = calculateMetricSummary(rawPreds, actualPoints);
  const overallCal = calculateMetricSummary(calPreds, actualPoints);

  // Top 10 and Top 20 predicted metrics
  const sortedByRaw = [...records].sort((a, b) => b.raw_expected_points - a.raw_expected_points);
  const top10 = sortedByRaw.slice(0, Math.min(10, n));
  const top20 = sortedByRaw.slice(0, Math.min(20, n));

  const top10PredMean =
    top10.reduce((sum, r) => sum + r.raw_expected_points, 0) / Math.max(1, top10.length);
  const top10ActMean =
    top10.reduce((sum, r) => sum + r.actual_total_points, 0) / Math.max(1, top10.length);
  const top20PredMean =
    top20.reduce((sum, r) => sum + r.raw_expected_points, 0) / Math.max(1, top20.length);
  const top20ActMean =
    top20.reduce((sum, r) => sum + r.actual_total_points, 0) / Math.max(1, top20.length);

  // Segmentation by Position
  const gkpRecs = records.filter((r) => r.position_id === 1);
  const defRecs = records.filter((r) => r.position_id === 2);
  const midRecs = records.filter((r) => r.position_id === 3);
  const fwdRecs = records.filter((r) => r.position_id === 4);

  const posSummaries = {
    gkp: calculateMetricSummary(
      gkpRecs.map((r) => r.raw_expected_points),
      gkpRecs.map((r) => r.actual_total_points)
    ),
    def: calculateMetricSummary(
      defRecs.map((r) => r.raw_expected_points),
      defRecs.map((r) => r.actual_total_points)
    ),
    mid: calculateMetricSummary(
      midRecs.map((r) => r.raw_expected_points),
      midRecs.map((r) => r.actual_total_points)
    ),
    fwd: calculateMetricSummary(
      fwdRecs.map((r) => r.raw_expected_points),
      fwdRecs.map((r) => r.actual_total_points)
    ),
  };

  // Segmentation by Expected Minutes Bands
  const band0_15 = records.filter((r) => r.expected_minutes < 15);
  const band15_60 = records.filter((r) => r.expected_minutes >= 15 && r.expected_minutes < 60);
  const band60_90 = records.filter((r) => r.expected_minutes >= 60);

  const minutesBandSummaries = {
    band_0_15: calculateMetricSummary(
      band0_15.map((r) => r.raw_expected_points),
      band0_15.map((r) => r.actual_total_points)
    ),
    band_15_60: calculateMetricSummary(
      band15_60.map((r) => r.raw_expected_points),
      band15_60.map((r) => r.actual_total_points)
    ),
    band_60_90: calculateMetricSummary(
      band60_90.map((r) => r.raw_expected_points),
      band60_90.map((r) => r.actual_total_points)
    ),
  };

  // Calibration Bins: 0-1, 1-2, 2-3, 3-4, 4-5, 5-6, 6+
  const binDefs = [
    { label: "0-1 xPts", min: 0, max: 1 },
    { label: "1-2 xPts", min: 1, max: 2 },
    { label: "2-3 xPts", min: 2, max: 3 },
    { label: "3-4 xPts", min: 3, max: 4 },
    { label: "4-5 xPts", min: 4, max: 5 },
    { label: "5-6 xPts", min: 5, max: 6 },
    { label: "6+ xPts", min: 6, max: 999 },
  ];

  const calBins: CalibrationBinSummary[] = binDefs.map((b) => {
    const inBin = records.filter((r) =>
      b.max === 999
        ? r.raw_expected_points >= b.min
        : r.raw_expected_points >= b.min && r.raw_expected_points < b.max
    );
    const count = inBin.length;
    if (count === 0) {
      return {
        bin_label: b.label,
        min_xpts: b.min,
        max_xpts: b.max,
        sample_count: 0,
        mean_predicted: 0,
        mean_actual: 0,
        bias: 0,
      };
    }
    const meanPred = inBin.reduce((s, r) => s + r.raw_expected_points, 0) / count;
    const meanAct = inBin.reduce((s, r) => s + r.actual_total_points, 0) / count;
    return {
      bin_label: b.label,
      min_xpts: b.min,
      max_xpts: b.max,
      sample_count: count,
      mean_predicted: Math.round(meanPred * 100) / 100,
      mean_actual: Math.round(meanAct * 100) / 100,
      bias: Math.round((meanPred - meanAct) * 100) / 100,
    };
  });

  // Phase 3 Metrics: Expected Minutes & Probabilities
  let minAbsErr = 0;
  let minSqErr = 0;
  let minErr = 0;
  for (const r of records) {
    const err = r.expected_minutes - r.actual_minutes;
    minErr += err;
    minAbsErr += Math.abs(err);
    minSqErr += err * err;
  }
  const minMae = Math.round((minAbsErr / n) * 100) / 100;
  const minRmse = Math.round(Math.sqrt(minSqErr / n) * 100) / 100;
  const minBias = Math.round((minErr / n) * 100) / 100;

  const appBrier = calculateBrierScore(
    records.map((r) => r.probability_appearance),
    records.map((r) => r.actual_appeared)
  );
  const startBrier = calculateBrierScore(
    records.map((r) => r.probability_start),
    records.map((r) => r.actual_started)
  );
  const sixtyBrier = calculateBrierScore(
    records.map((r) => r.probability_60_plus_minutes),
    records.map((r) => r.actual_60_plus)
  );

  // Component-level diagnostics
  let goalsErrSum = 0;
  let assistsErrSum = 0;
  let bonusErrSum = 0;
  let savesErrSum = 0;
  for (const r of records) {
    goalsErrSum += r.expected_goals - r.actual_goals;
    assistsErrSum += r.expected_assists - r.actual_assists;
    bonusErrSum += r.expected_bonus - r.actual_bonus;
    savesErrSum += r.expected_saves - r.actual_saves;
  }

  const csBrier = calculateBrierScore(
    records.map((r) => r.probability_clean_sheet),
    records.map((r) => r.actual_clean_sheet)
  );
  const dcBrier = calculateBrierScore(
    records.map((r) => r.probability_defensive_contribution),
    records.map((r) => (r.actual_defensive_contribution > 0 ? 1 : 0))
  );

  // Confidence error analysis
  const confBuckets = [
    { label: "0.0 - 0.25", min: 0.0, max: 0.25 },
    { label: "0.25 - 0.50", min: 0.25, max: 0.5 },
    { label: "0.50 - 0.75", min: 0.5, max: 0.75 },
    { label: "0.75 - 1.00", min: 0.75, max: 1.01 },
  ];

  const confAnalysis: ConfidenceBucketSummary[] = confBuckets.map((cb) => {
    const inBucket = records.filter(
      (r) => r.expected_points_confidence >= cb.min && r.expected_points_confidence < cb.max
    );
    const count = inBucket.length;
    if (count === 0) {
      return {
        confidence_bucket: cb.label,
        min_confidence: cb.min,
        max_confidence: cb.max,
        sample_count: 0,
        mean_confidence: 0,
        mae: 0,
        rmse: 0,
      };
    }
    const meanConf = inBucket.reduce((s, r) => s + r.expected_points_confidence, 0) / count;
    let absErr = 0;
    let sqErr = 0;
    for (const r of inBucket) {
      const err = r.raw_expected_points - r.actual_total_points;
      absErr += Math.abs(err);
      sqErr += err * err;
    }
    return {
      confidence_bucket: cb.label,
      min_confidence: cb.min,
      max_confidence: cb.max,
      sample_count: count,
      mean_confidence: Math.round(meanConf * 1000) / 1000,
      mae: Math.round((absErr / count) * 1000) / 1000,
      rmse: Math.round(Math.sqrt(sqErr / count) * 1000) / 1000,
    };
  });

  return {
    sample_size: n,
    overall_raw_metrics: overallRaw,
    overall_calibrated_metrics: overallCal,
    top_10_mean_predicted: Math.round(top10PredMean * 100) / 100,
    top_10_mean_actual: Math.round(top10ActMean * 100) / 100,
    top_20_mean_predicted: Math.round(top20PredMean * 100) / 100,
    top_20_mean_actual: Math.round(top20ActMean * 100) / 100,
    by_position: posSummaries,
    by_minutes_band: minutesBandSummaries,
    calibration_bins: calBins,
    phase3_metrics: {
      minutes_mae: minMae,
      minutes_rmse: minRmse,
      minutes_bias: minBias,
      appearance_brier: appBrier,
      start_brier: startBrier,
      sixty_plus_brier: sixtyBrier,
    },
    component_diagnostics: {
      goals_error_mean: Math.round((goalsErrSum / n) * 1000) / 1000,
      assists_error_mean: Math.round((assistsErrSum / n) * 1000) / 1000,
      clean_sheet_brier: csBrier,
      def_contrib_brier: dcBrier,
      bonus_error_mean: Math.round((bonusErrSum / n) * 1000) / 1000,
      saves_error_mean: Math.round((savesErrSum / n) * 1000) / 1000,
    },
    confidence_error_analysis: confAnalysis,
  };
}

/**
 * Executes a walk-forward historical backtest across a set of target gameweeks.
 * Enforces STRICT leakage safety: for target GW T, historical snapshot cutoff is T - 1.
 */
export function runWalkForwardBacktest(options: {
  targetGameweeks: number[];
  players: Array<Record<string, any>>;
  playerHistories: Record<number, Array<Record<string, any>>>;
  allFixtures: Array<Record<string, any>>;
  allTeams?: Array<Record<string, any>> | null;
  calibrationThresholds?: CalibrationThresholds;
}): {
  records: BacktestRecord[];
  metrics: BacktestMetrics;
  recordsByGameweek: Record<number, BacktestRecord[]>;
  metricsByGameweek: Record<number, BacktestMetrics>;
} {
  const {
    targetGameweeks,
    players,
    playerHistories,
    allFixtures,
    allTeams = null,
    calibrationThresholds = DEFAULT_CALIBRATION_THRESHOLDS,
  } = options;

  const allRecords: BacktestRecord[] = [];
  const recordsByGameweek: Record<number, BacktestRecord[]> = {};
  const metricsByGameweek: Record<number, BacktestMetrics> = {};

  const sortedGws = [...targetGameweeks].sort((a, b) => a - b);

  for (const targetGw of sortedGws) {
    const cutoffGw = targetGw - 1;
    const gwRecords: BacktestRecord[] = [];

    // Construct cutoff-safe snapshot for targetGw
    const snapshot = new PredictionSnapshot({
      snapshot_id: `backtest_snap_gw${targetGw}_cutoff${cutoffGw}`,
      boundary: new GameweekBoundary({
        last_finished_gameweek: cutoffGw > 0 ? cutoffGw : null,
        prediction_gameweek: targetGw,
        historical_cutoff_gameweek: cutoffGw > 0 ? cutoffGw : null,
        in_progress_gameweek: null,
      }),
    });

    for (const player of players) {
      const fullHistory = playerHistories[player.id] || [];

      // STRICT LEAKAGE PREVENTION: slice history <= cutoffGw
      const cutoffSafeHistory = fullHistory.filter((m) => {
        const round = typeof m.round === "number" ? m.round : parseInt(m.round, 10);
        return round <= cutoffGw;
      });

      // Target match outcome (realised result in targetGw)
      const targetMatch = fullHistory.find((m) => {
        const round = typeof m.round === "number" ? m.round : parseInt(m.round, 10);
        return round === targetGw;
      });

      if (!targetMatch) {
        // Player had no fixture or data recorded in target gameweek
        continue;
      }

      // Execute Phase 2 Canonical Features
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures,
        allTeams,
      });

      // Execute Phase 3 Expected Minutes
      const minutesResult = buildPlayerExpectedMinutes({
        player,
        features,
        snapshot,
        history: cutoffSafeHistory,
      });

      // Execute Phase 4 Raw Expected Points
      const rawPointsResult = buildPlayerExpectedPoints({
        player,
        features,
        minutesResult,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures,
        allTeams,
      });

      // Execute Phase 5 Calibrated Expected Points & Uncertainty
      const calibratedResult = buildCalibratedExpectedPoints({
        player,
        rawResult: rawPointsResult,
        minutesResult,
        snapshot,
        thresholds: calibrationThresholds,
      });

      // Extract realised match values
      const actualMinutes = targetMatch.minutes !== undefined ? Number(targetMatch.minutes) : 0;
      const actualGoals = targetMatch.goals_scored !== undefined ? Number(targetMatch.goals_scored) : 0;
      const actualAssists = targetMatch.assists !== undefined ? Number(targetMatch.assists) : 0;
      const actualCs = targetMatch.clean_sheets !== undefined ? Number(targetMatch.clean_sheets) > 0 : false;
      const actualBonus = targetMatch.bonus !== undefined ? Number(targetMatch.bonus) : 0;
      const actualSaves = targetMatch.saves !== undefined ? Number(targetMatch.saves) : 0;
      const actualYellow = targetMatch.yellow_cards !== undefined ? Number(targetMatch.yellow_cards) : 0;
      const actualRed = targetMatch.red_cards !== undefined ? Number(targetMatch.red_cards) : 0;
      const actualOg = targetMatch.own_goals !== undefined ? Number(targetMatch.own_goals) : 0;
      const actualPenMiss = targetMatch.penalties_missed !== undefined ? Number(targetMatch.penalties_missed) : 0;
      const actualTotalPoints = targetMatch.total_points !== undefined ? Number(targetMatch.total_points) : 0;

      // Defensive contribution return check (2026/27 rules)
      const clearances = Number(targetMatch.clearances_blocks_interceptions || 0);
      const recoveries = Number(targetMatch.recoveries || 0);
      const posId = player.element_type || 3;
      let actualDefContrib = 0;
      if (posId === 2 && clearances >= 10) actualDefContrib = 2;
      else if ((posId === 3 || posId === 4) && (clearances + recoveries) >= 12) actualDefContrib = 2;

      const breakdown = rawPointsResult.breakdown;

      const record: BacktestRecord = {
        player_id: player.id,
        web_name: player.web_name || `Player_${player.id}`,
        team_id: player.team || 1,
        position_id: posId,
        target_gameweek: targetGw,
        historical_cutoff_gameweek: cutoffGw,

        expected_minutes: Number(minutesResult.expected_minutes.value) || 0,
        probability_start: minutesResult.breakdown.probabilities.probability_start,
        probability_appearance: minutesResult.breakdown.probabilities.probability_appearance,
        probability_60_plus_minutes: minutesResult.breakdown.probabilities.probability_60_plus_minutes,
        playing_time_confidence: Number(minutesResult.playing_time_confidence.value) || 0,

        raw_expected_points: Number(rawPointsResult.expected_points_next_gameweek.value) || 0,
        expected_goals: breakdown.expected_goals,
        expected_assists: breakdown.expected_assists,
        probability_clean_sheet: breakdown.probability_clean_sheet,
        probability_defensive_contribution: breakdown.probability_defensive_contribution_points,
        expected_bonus: breakdown.expected_bonus_points,
        expected_saves: breakdown.expected_saves,
        expected_points_confidence: Number(rawPointsResult.expected_points_confidence.value) || 0,

        calibrated_expected_points: Number(calibratedResult.calibrated_expected_points.value) || 0,
        prediction_std: calibratedResult.uncertainty.prediction_std_or_error_scale,
        prediction_range_low: calibratedResult.uncertainty.prediction_range_low,
        prediction_range_high: calibratedResult.uncertainty.prediction_range_high,

        actual_minutes: actualMinutes,
        actual_started: targetMatch.starts !== undefined ? Number(targetMatch.starts) === 1 : actualMinutes > 60,
        actual_appeared: actualMinutes > 0,
        actual_60_plus: actualMinutes >= 60,
        actual_goals: actualGoals,
        actual_assists: actualAssists,
        actual_clean_sheet: actualCs,
        actual_defensive_contribution: actualDefContrib,
        actual_bonus: actualBonus,
        actual_saves: actualSaves,
        actual_yellow_cards: actualYellow,
        actual_red_cards: actualRed,
        actual_own_goals: actualOg,
        actual_penalties_missed: actualPenMiss,
        actual_total_points: actualTotalPoints,
      };

      gwRecords.push(record);
      allRecords.push(record);
    }

    recordsByGameweek[targetGw] = gwRecords;
    metricsByGameweek[targetGw] = calculateBacktestMetrics(gwRecords);
  }

  const overallMetrics = calculateBacktestMetrics(allRecords);

  return {
    records: allRecords,
    metrics: overallMetrics,
    recordsByGameweek,
    metricsByGameweek,
  };
}
