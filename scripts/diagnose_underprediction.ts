import {
  fetchBootstrapData,
  fetchFixtures,
  fetchPlayerSummary,
} from "../services/fpl_service.js";
import {
  GameweekBoundary,
  PredictionSnapshot,
  DataValidity,
} from "../services/prediction_contract.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import {
  buildPlayerExpectedMinutes,
  PlayerMinutesModelResult,
} from "../services/expected_minutes_model.js";
import {
  buildPlayerExpectedPoints,
  PlayerExpectedPointsResult,
} from "../services/expected_points_model.js";
import {
  buildCalibratedExpectedPoints,
  calculatePredictionUncertainty,
  DEFAULT_CALIBRATION_THRESHOLDS,
} from "../services/calibration_service.js";
import {
  calculateSpearmanCorrelation,
  calculateBrierScore,
  calculateMetricSummary,
} from "../services/backtest_service.js";

// Rate-limited batch fetcher
async function fetchPlayerSummariesBatched(
  playerIds: number[],
  batchSize = 25
): Promise<Record<number, any>> {
  const summaries: Record<number, any> = {};
  for (let i = 0; i < playerIds.length; i += batchSize) {
    const batch = playerIds.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const sum = await fetchPlayerSummary(id);
          return { id, sum };
        } catch (e) {
          return { id, sum: { history: [], fixtures: [] } };
        }
      })
    );
    for (const r of results) {
      summaries[r.id] = r.sum;
    }
  }
  return summaries;
}

interface DiagnosticRecord {
  player_id: number;
  web_name: string;
  team_id: number;
  position_id: number;
  target_gameweek: number;
  historical_cutoff_gameweek: number;

  // Predictions
  expected_minutes: number;
  prob_start: number;
  prob_appearance: number;
  prob_60_plus: number;
  playing_time_confidence: number;
  expected_points_confidence: number;

  raw_expected_points: number;
  expected_goals: number;
  expected_assists: number;
  prob_clean_sheet: number;
  prob_def_contrib: number;
  expected_bonus: number;
  expected_saves: number;

  // Uncertainty
  prediction_std: number;
  range_low: number;
  range_high: number;

  // Oracle-Minutes Counterfactual
  oracle_expected_points: number;
  oracle_expected_goals: number;
  oracle_expected_assists: number;
  oracle_prob_clean_sheet: number;
  oracle_prob_def_contrib: number;
  oracle_expected_bonus: number;
  oracle_expected_saves: number;

  // Actual Outcomes
  actual_minutes: number;
  actual_started: boolean;
  actual_appeared: boolean;
  actual_60_plus: boolean;
  actual_goals: number;
  actual_assists: number;
  actual_clean_sheet: boolean;
  actual_def_contrib: number;
  actual_bonus: number;
  actual_saves: number;
  actual_total_points: number;

  // Errors (Convention: error = predicted - actual, residual = actual - predicted)
  // We will track both explicitly
  minutes_pred_error: number; // predicted - actual
  minutes_residual: number;   // actual - predicted
  points_pred_error: number;  // predicted - actual
  points_residual: number;    // actual - predicted
  oracle_points_pred_error: number; // oracle_pred - actual
}

async function runDiagnostic() {
  console.log("===============================================================================");
  console.log("             PHASE 5: ROOT-CAUSE UNDERPREDICTION DIAGNOSTIC                    ");
  console.log("===============================================================================");

  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const targetPlayers = bootstrap.players.filter(
    (p: any) => p.minutes > 0 || p.selected_by_percent > 1.0 || [1, 8, 31, 212, 411, 426].includes(p.id)
  );
  console.log(`Fetched bootstrap data. Analyzing ${targetPlayers.length} active players across finished GW1 & GW2...`);

  const summaries = await fetchPlayerSummariesBatched(
    targetPlayers.map((p: any) => p.id),
    30
  );
  const historiesByPlayer: Record<number, Array<Record<string, any>>> = {};
  for (const [idStr, sum] of Object.entries(summaries)) {
    historiesByPlayer[Number(idStr)] = (sum as any).history || [];
  }

  const records: DiagnosticRecord[] = [];

  for (const targetGw of [1, 2]) {
    const cutoffGw = targetGw - 1;
    const snapshot = new PredictionSnapshot({
      snapshot_id: `diag_snap_gw${targetGw}_cutoff${cutoffGw}`,
      boundary: new GameweekBoundary({
        last_finished_gameweek: cutoffGw > 0 ? cutoffGw : null,
        prediction_gameweek: targetGw,
        historical_cutoff_gameweek: cutoffGw > 0 ? cutoffGw : null,
        in_progress_gameweek: null,
      }),
    });

    for (const player of targetPlayers) {
      const fullHistory = historiesByPlayer[player.id] || [];
      const cutoffSafeHistory = fullHistory.filter((m) => {
        const round = typeof m.round === "number" ? m.round : parseInt(m.round, 10);
        return round <= cutoffGw;
      });
      const targetMatch = fullHistory.find((m) => {
        const round = typeof m.round === "number" ? m.round : parseInt(m.round, 10);
        return round === targetGw;
      });

      if (!targetMatch) continue;

      // 1. Standard Cutoff-Safe Pipeline (Phase 2 -> Phase 3 -> Phase 4 -> Phase 5)
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      const minutesResult = buildPlayerExpectedMinutes({
        player,
        features,
        snapshot,
        history: cutoffSafeHistory,
      });

      const rawPointsResult = buildPlayerExpectedPoints({
        player,
        features,
        minutesResult,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      const calResult = buildCalibratedExpectedPoints({
        player,
        rawResult: rawPointsResult,
        minutesResult,
        snapshot,
        thresholds: DEFAULT_CALIBRATION_THRESHOLDS,
      });

      // 2. Oracle-Minutes Counterfactual (Diagnostic Only)
      // Inject actual minutes and appearance states into a synthetic MinutesResult
      const actualMinutes = targetMatch.minutes !== undefined ? Number(targetMatch.minutes) : 0;
      const actualStarted = targetMatch.starts !== undefined ? Number(targetMatch.starts) === 1 : actualMinutes > 60;
      const actualAppeared = actualMinutes > 0;
      const actual60Plus = actualMinutes >= 60;
      const actualGoals = targetMatch.goals_scored !== undefined ? Number(targetMatch.goals_scored) : 0;
      const actualAssists = targetMatch.assists !== undefined ? Number(targetMatch.assists) : 0;
      const actualCs = targetMatch.clean_sheets !== undefined ? Number(targetMatch.clean_sheets) > 0 : false;
      const actualBonus = targetMatch.bonus !== undefined ? Number(targetMatch.bonus) : 0;
      const actualSaves = targetMatch.saves !== undefined ? Number(targetMatch.saves) : 0;
      const actualTotalPoints = targetMatch.total_points !== undefined ? Number(targetMatch.total_points) : 0;

      const clearances = Number(targetMatch.clearances_blocks_interceptions || 0);
      const recoveries = Number(targetMatch.recoveries || 0);
      const posId = player.element_type || 3;
      let actualDefContrib = 0;
      if (posId === 2 && clearances >= 10) actualDefContrib = 2;
      else if ((posId === 3 || posId === 4) && (clearances + recoveries) >= 12) actualDefContrib = 2;

      // Build Oracle Minutes Result
      const oracleMinutesResult: PlayerMinutesModelResult = {
        player_id: player.id,
        model_version: "diagnostic_oracle.v1",
        expected_minutes: {
          value: actualMinutes,
          validity: DataValidity.DERIVED,
          source: "diagnostic_oracle",
          as_of_gameweek: cutoffGw,
          reason: "Oracle target minutes diagnostic",
        },
        probability_available: minutesResult.probability_available,
        probability_appearance: {
          value: actualAppeared ? 1.0 : 0.0,
          validity: DataValidity.DERIVED,
          source: "diagnostic_oracle",
          as_of_gameweek: cutoffGw,
          reason: "Oracle target appearance diagnostic",
        },
        probability_start: {
          value: actualStarted ? 1.0 : 0.0,
          validity: DataValidity.DERIVED,
          source: "diagnostic_oracle",
          as_of_gameweek: cutoffGw,
          reason: "Oracle target start diagnostic",
        },
        probability_60_plus_minutes: {
          value: actual60Plus ? 1.0 : 0.0,
          validity: DataValidity.DERIVED,
          source: "diagnostic_oracle",
          as_of_gameweek: cutoffGw,
          reason: "Oracle target 60+ diagnostic",
        },
        playing_time_confidence: minutesResult.playing_time_confidence,
        breakdown: {
          base_minutes: actualMinutes,
          availability_multiplier: 1.0,
          sub_hazard_decay: 1.0,
          tactical_factor: 1.0,
          probabilities: {
            probability_available: 1.0,
            probability_appearance: actualAppeared ? 1.0 : 0.0,
            probability_start: actualStarted ? 1.0 : 0.0,
            probability_60_plus_minutes: actual60Plus ? 1.0 : 0.0,
          },
          minutes_decomposition: {
            expected_minutes_when_started: actualStarted ? actualMinutes : 0,
            expected_minutes_as_substitute: actualStarted ? 0 : actualMinutes,
            start_contribution: actualStarted ? actualMinutes : 0,
            substitute_contribution: actualStarted ? 0 : actualMinutes,
            single_fixture_expected_minutes: actualMinutes,
            total_expected_minutes: actualMinutes,
          },
          per_fixture_breakdown: [
            {
              fixture_id: fixtures.find((f: any) => f.event === targetGw && (f.team_h === player.team || f.team_a === player.team))?.id || 0,
              opponent_team_id: 1,
              is_home: true,
              expected_minutes: actualMinutes,
              probability_start: actualStarted ? 1.0 : 0.0,
              probability_appearance: actualAppeared ? 1.0 : 0.0,
              probability_60_plus_minutes: actual60Plus ? 1.0 : 0.0,
            },
          ],
        },
        prediction_output: {},
      };

      const oraclePointsResult = buildPlayerExpectedPoints({
        player,
        features,
        minutesResult: oracleMinutesResult,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      const rawExpPts = Number(rawPointsResult.expected_points_next_gameweek.value) || 0;
      const oracleExpPts = Number(oraclePointsResult.expected_points_next_gameweek.value) || 0;
      const rawExpMins = Number(minutesResult.expected_minutes.value) || 0;

      records.push({
        player_id: player.id,
        web_name: player.web_name,
        team_id: player.team,
        position_id: posId,
        target_gameweek: targetGw,
        historical_cutoff_gameweek: cutoffGw,

        expected_minutes: rawExpMins,
        prob_start: minutesResult.breakdown.probabilities.probability_start,
        prob_appearance: minutesResult.breakdown.probabilities.probability_appearance,
        prob_60_plus: minutesResult.breakdown.probabilities.probability_60_plus_minutes,
        playing_time_confidence: Number(minutesResult.playing_time_confidence.value) || 0,
        expected_points_confidence: Number(rawPointsResult.expected_points_confidence.value) || 0,

        raw_expected_points: rawExpPts,
        expected_goals: rawPointsResult.breakdown.expected_goals,
        expected_assists: rawPointsResult.breakdown.expected_assists,
        prob_clean_sheet: rawPointsResult.breakdown.probability_clean_sheet,
        prob_def_contrib: rawPointsResult.breakdown.probability_defensive_contribution_points,
        expected_bonus: rawPointsResult.breakdown.expected_bonus_points,
        expected_saves: rawPointsResult.breakdown.expected_saves,

        prediction_std: calResult.uncertainty.prediction_std_or_error_scale,
        range_low: calResult.uncertainty.prediction_range_low,
        range_high: calResult.uncertainty.prediction_range_high,

        oracle_expected_points: oracleExpPts,
        oracle_expected_goals: oraclePointsResult.breakdown.expected_goals,
        oracle_expected_assists: oraclePointsResult.breakdown.expected_assists,
        oracle_prob_clean_sheet: oraclePointsResult.breakdown.probability_clean_sheet,
        oracle_prob_def_contrib: oraclePointsResult.breakdown.probability_defensive_contribution_points,
        oracle_expected_bonus: oraclePointsResult.breakdown.expected_bonus_points,
        oracle_expected_saves: oraclePointsResult.breakdown.expected_saves,

        actual_minutes: actualMinutes,
        actual_started: actualStarted,
        actual_appeared: actualAppeared,
        actual_60_plus: actual60Plus,
        actual_goals: actualGoals,
        actual_assists: actualAssists,
        actual_clean_sheet: actualCs,
        actual_def_contrib: actualDefContrib,
        actual_bonus: actualBonus,
        actual_saves: actualSaves,
        actual_total_points: actualTotalPoints,

        minutes_pred_error: Math.round((rawExpMins - actualMinutes) * 100) / 100,
        minutes_residual: Math.round((actualMinutes - rawExpMins) * 100) / 100,
        points_pred_error: Math.round((rawExpPts - actualTotalPoints) * 100) / 100,
        points_residual: Math.round((actualTotalPoints - rawExpPts) * 100) / 100,
        oracle_points_pred_error: Math.round((oracleExpPts - actualTotalPoints) * 100) / 100,
      });
    }
  }

  console.log(`\n===============================================================================`);
  console.log(`SIGN CONVENTION DEFINITION:`);
  console.log(`- Prediction Bias / Prediction Error = mean(predicted - actual)`);
  console.log(`  * If negative (< 0): Underprediction (model predicted lower than realised).`);
  console.log(`  * If positive (> 0): Overprediction (model predicted higher than realised).`);
  console.log(`- Residual = actual - predicted`);
  console.log(`===============================================================================\n`);

  // Helper metric calculator
  const calcStats = (recs: DiagnosticRecord[], predKey: keyof DiagnosticRecord, actKey: keyof DiagnosticRecord) => {
    const n = recs.length;
    if (n === 0) return { n: 0, mae: 0, rmse: 0, bias: 0, medAbs: 0, spearman: 0, meanPred: 0, meanAct: 0 };
    const preds = recs.map((r) => Number(r[predKey]));
    const acts = recs.map((r) => Number(r[actKey]));
    const meanPred = preds.reduce((a, b) => a + b, 0) / n;
    const meanAct = acts.reduce((a, b) => a + b, 0) / n;
    let sumAbs = 0;
    let sumSq = 0;
    let sumErr = 0;
    const absArr: number[] = [];
    for (let i = 0; i < n; i++) {
      const err = preds[i] - acts[i];
      const absErr = Math.abs(err);
      sumErr += err;
      sumAbs += absErr;
      sumSq += err * err;
      absArr.push(absErr);
    }
    absArr.sort((a, b) => a - b);
    const medAbs = n % 2 === 1 ? absArr[Math.floor(n / 2)] : (absArr[n / 2 - 1] + absArr[n / 2]) / 2;
    return {
      n,
      mae: Math.round((sumAbs / n) * 1000) / 1000,
      rmse: Math.round(Math.sqrt(sumSq / n) * 1000) / 1000,
      bias: Math.round((sumErr / n) * 1000) / 1000, // predicted - actual
      medAbs: Math.round(medAbs * 1000) / 1000,
      spearman: calculateSpearmanCorrelation(preds, acts),
      meanPred: Math.round(meanPred * 1000) / 1000,
      meanAct: Math.round(meanAct * 1000) / 1000,
    };
  };

  // 1. SPLIT BACKTEST BY TARGET GAMEWEEK (GW1 vs GW2)
  console.log("--- 1 & 2. TARGET GAMEWEEK SPLIT: GW1 (Preseason-Only) vs GW2 (Evidence-Available) ---");
  const gw1Recs = records.filter((r) => r.target_gameweek === 1);
  const gw2Recs = records.filter((r) => r.target_gameweek === 2);

  const gw1Pts = calcStats(gw1Recs, "raw_expected_points", "actual_total_points");
  const gw2Pts = calcStats(gw2Recs, "raw_expected_points", "actual_total_points");
  const allPts = calcStats(records, "raw_expected_points", "actual_total_points");

  const gw1Mins = calcStats(gw1Recs, "expected_minutes", "actual_minutes");
  const gw2Mins = calcStats(gw2Recs, "expected_minutes", "actual_minutes");
  const allMins = calcStats(records, "expected_minutes", "actual_minutes");

  const gw1AppBrier = calculateBrierScore(gw1Recs.map(r => r.prob_appearance), gw1Recs.map(r => r.actual_appeared));
  const gw2AppBrier = calculateBrierScore(gw2Recs.map(r => r.prob_appearance), gw2Recs.map(r => r.actual_appeared));
  const gw1StartBrier = calculateBrierScore(gw1Recs.map(r => r.prob_start), gw1Recs.map(r => r.actual_started));
  const gw2StartBrier = calculateBrierScore(gw2Recs.map(r => r.prob_start), gw2Recs.map(r => r.actual_started));
  const gw1SixtyBrier = calculateBrierScore(gw1Recs.map(r => r.prob_60_plus), gw1Recs.map(r => r.actual_60_plus));
  const gw2SixtyBrier = calculateBrierScore(gw2Recs.map(r => r.prob_60_plus), gw2Recs.map(r => r.actual_60_plus));

  console.log(`\nEXPECTED POINTS METRICS:`);
  console.log(`Metric                     | GW1 (Preseason Cutoff 0) | GW2 (GW1 Cutoff 1)     | Full (GW1 + GW2)`);
  console.log(`---------------------------+--------------------------+------------------------+------------------`);
  console.log(`Sample Size (N)            | ${gw1Pts.n.toString().padEnd(24)} | ${gw2Pts.n.toString().padEnd(22)} | ${allPts.n}`);
  console.log(`Mean Predicted Points      | ${gw1Pts.meanPred.toString().padEnd(24)} | ${gw2Pts.meanPred.toString().padEnd(22)} | ${allPts.meanPred}`);
  console.log(`Mean Actual Points         | ${gw1Pts.meanAct.toString().padEnd(24)} | ${gw2Pts.meanAct.toString().padEnd(22)} | ${allPts.meanAct}`);
  console.log(`Bias (Pred - Actual)       | ${gw1Pts.bias.toString().padEnd(24)} | ${gw2Pts.bias.toString().padEnd(22)} | ${allPts.bias}`);
  console.log(`MAE (Points)               | ${gw1Pts.mae.toString().padEnd(24)} | ${gw2Pts.mae.toString().padEnd(22)} | ${allPts.mae}`);
  console.log(`RMSE (Points)              | ${gw1Pts.rmse.toString().padEnd(24)} | ${gw2Pts.rmse.toString().padEnd(22)} | ${allPts.rmse}`);
  console.log(`Median Absolute Error      | ${gw1Pts.medAbs.toString().padEnd(24)} | ${gw2Pts.medAbs.toString().padEnd(22)} | ${allPts.medAbs}`);
  console.log(`Spearman Rank (rho)        | ${gw1Pts.spearman.toString().padEnd(24)} | ${gw2Pts.spearman.toString().padEnd(22)} | ${allPts.spearman}`);

  console.log(`\nPHASE 3 EXPECTED MINUTES METRICS:`);
  console.log(`Metric                     | GW1 (Preseason Cutoff 0) | GW2 (GW1 Cutoff 1)     | Full (GW1 + GW2)`);
  console.log(`---------------------------+--------------------------+------------------------+------------------`);
  console.log(`Mean Predicted Minutes     | ${gw1Mins.meanPred.toString().padEnd(24)} | ${gw2Mins.meanPred.toString().padEnd(22)} | ${allMins.meanPred}`);
  console.log(`Mean Actual Minutes        | ${gw1Mins.meanAct.toString().padEnd(24)} | ${gw2Mins.meanAct.toString().padEnd(22)} | ${allMins.meanAct}`);
  console.log(`Minutes Bias (Pred-Act)    | ${gw1Mins.bias.toString().padEnd(24)} | ${gw2Mins.bias.toString().padEnd(22)} | ${allMins.bias}`);
  console.log(`Minutes MAE                | ${gw1Mins.mae.toString().padEnd(24)} | ${gw2Mins.mae.toString().padEnd(22)} | ${allMins.mae}`);
  console.log(`Minutes RMSE               | ${gw1Mins.rmse.toString().padEnd(24)} | ${gw2Mins.rmse.toString().padEnd(22)} | ${allMins.rmse}`);
  console.log(`P(appearance) Brier Score  | ${gw1AppBrier.toString().padEnd(24)} | ${gw2AppBrier.toString().padEnd(22)} | ${calculateBrierScore(records.map(r => r.prob_appearance), records.map(r => r.actual_appeared))}`);
  console.log(`P(start) Brier Score       | ${gw1StartBrier.toString().padEnd(24)} | ${gw2StartBrier.toString().padEnd(22)} | ${calculateBrierScore(records.map(r => r.prob_start), records.map(r => r.actual_started))}`);
  console.log(`P(60+) Brier Score         | ${gw1SixtyBrier.toString().padEnd(24)} | ${gw2SixtyBrier.toString().padEnd(22)} | ${calculateBrierScore(records.map(r => r.prob_60_plus), records.map(r => r.actual_60_plus))}`);

  // 3. EXPECTED MINUTES ERROR SEGMENTATION
  console.log("\n--- 3. EXPECTED MINUTES ERROR SEGMENTATION ---");
  console.log("\nA. By Actual Minutes Played:");
  const actMinsBands = [
    { label: "0 mins", filter: (r: DiagnosticRecord) => r.actual_minutes === 0 },
    { label: "1-29 mins", filter: (r: DiagnosticRecord) => r.actual_minutes >= 1 && r.actual_minutes <= 29 },
    { label: "30-59 mins", filter: (r: DiagnosticRecord) => r.actual_minutes >= 30 && r.actual_minutes <= 59 },
    { label: "60-89 mins", filter: (r: DiagnosticRecord) => r.actual_minutes >= 60 && r.actual_minutes <= 89 },
    { label: "90+ mins", filter: (r: DiagnosticRecord) => r.actual_minutes >= 90 },
  ];

  console.log(`Actual Band    | N   | Mean Pred Mins | Mean Act Mins | Minutes Bias (Pred-Act) | Minutes MAE`);
  console.log(`---------------+-----+----------------+---------------+-------------------------+------------`);
  for (const b of actMinsBands) {
    const subset = records.filter(b.filter);
    const stats = calcStats(subset, "expected_minutes", "actual_minutes");
    console.log(
      `${b.label.padEnd(14)} | ${stats.n.toString().padEnd(3)} | ${stats.meanPred.toString().padEnd(14)} | ${stats.meanAct.toString().padEnd(13)} | ${stats.bias.toString().padEnd(23)} | ${stats.mae}`
    );
  }

  console.log("\nB. By Predicted P(start):");
  const predStartBands = [
    { label: "< 0.20", filter: (r: DiagnosticRecord) => r.prob_start < 0.20 },
    { label: "0.20 - 0.50", filter: (r: DiagnosticRecord) => r.prob_start >= 0.20 && r.prob_start < 0.50 },
    { label: "0.50 - 0.75", filter: (r: DiagnosticRecord) => r.prob_start >= 0.50 && r.prob_start < 0.75 },
    { label: ">= 0.75", filter: (r: DiagnosticRecord) => r.prob_start >= 0.75 },
  ];

  console.log(`P(start) Band  | N   | Mean P(start) | Actual Start Rate | Mean Pred Mins | Mean Act Mins | Mins Bias`);
  console.log(`---------------+-----+---------------+-------------------+----------------+---------------+----------`);
  for (const b of predStartBands) {
    const subset = records.filter(b.filter);
    const n = subset.length;
    if (n === 0) continue;
    const meanProbStart = subset.reduce((s, r) => s + r.prob_start, 0) / n;
    const actStartRate = subset.filter((r) => r.actual_started).length / n;
    const stats = calcStats(subset, "expected_minutes", "actual_minutes");
    console.log(
      `${b.label.padEnd(14)} | ${n.toString().padEnd(3)} | ${meanProbStart.toFixed(3).padEnd(13)} | ${(actStartRate * 100).toFixed(1)}%`.padEnd(37) +
        ` | ${stats.meanPred.toFixed(1).padEnd(14)} | ${stats.meanAct.toFixed(1).padEnd(13)} | ${stats.bias.toFixed(1)}`
    );
  }

  // 4. ROLE-CLASS ERROR (Cutoff-Safe Groupings)
  console.log("\n--- 4. ROLE-CLASS ERROR (Cutoff-Safe Prediction Groupings) ---");
  const roleGroups = [
    {
      label: "Strong Starter (P(start) >= 0.75)",
      filter: (r: DiagnosticRecord) => r.prob_start >= 0.75,
    },
    {
      label: "Uncertain Starter (0.40 <= P(start) < 0.75)",
      filter: (r: DiagnosticRecord) => r.prob_start >= 0.40 && r.prob_start < 0.75,
    },
    {
      label: "Sub/Rotation (P(start) < 0.40 & P(app) >= 0.30)",
      filter: (r: DiagnosticRecord) => r.prob_start < 0.40 && r.prob_appearance >= 0.30,
    },
    {
      label: "Low Appearance (P(app) < 0.30)",
      filter: (r: DiagnosticRecord) => r.prob_appearance < 0.30,
    },
  ];

  console.log(`Role Group                                 | N   | Mean Pred Mins | Mean Act Mins | Mins Bias | Mins MAE | Start Rate`);
  console.log(`-------------------------------------------+-----+----------------+---------------+-----------+----------+-----------`);
  for (const g of roleGroups) {
    const subset = records.filter(g.filter);
    const stats = calcStats(subset, "expected_minutes", "actual_minutes");
    const startRate = subset.length > 0 ? (subset.filter((r) => r.actual_started).length / subset.length) * 100 : 0;
    console.log(
      `${g.label.padEnd(42)} | ${stats.n.toString().padEnd(3)} | ${stats.meanPred.toFixed(1).padEnd(14)} | ${stats.meanAct.toFixed(1).padEnd(13)} | ${stats.bias.toFixed(1).padEnd(9)} | ${stats.mae.toFixed(1).padEnd(8)} | ${startRate.toFixed(1)}%`
    );
  }

  // 5. XPTS ERROR CONDITIONAL ON MINUTES ERROR
  console.log("\n--- 5. XPTS ERROR CONDITIONAL ON MINUTES ERROR ---");
  // Correlation between minutes_pred_error and points_pred_error
  const minsErrors = records.map((r) => r.minutes_pred_error);
  const ptsErrors = records.map((r) => r.points_pred_error);
  const minPtsRho = calculateSpearmanCorrelation(minsErrors, ptsErrors);

  const within10 = records.filter((r) => Math.abs(r.minutes_pred_error) <= 10);
  const underBy20 = records.filter((r) => r.minutes_pred_error < -20); // predicted < actual - 20 (underpredicted mins)
  const overBy20 = records.filter((r) => r.minutes_pred_error > 20);   // predicted > actual + 20 (overpredicted mins)

  const within10Stats = calcStats(within10, "raw_expected_points", "actual_total_points");
  const under20Stats = calcStats(underBy20, "raw_expected_points", "actual_total_points");
  const over20Stats = calcStats(overBy20, "raw_expected_points", "actual_total_points");

  console.log(`- Rank Correlation between Minutes Error (Pred-Act) & Points Error (Pred-Act): rho = ${minPtsRho}`);
  console.log(`- Segment | Minutes Pred within +-10 mins: N = ${within10.length}, Points Bias = ${within10Stats.bias}, Points MAE = ${within10Stats.mae}, Points RMSE = ${within10Stats.rmse}`);
  console.log(`- Segment | Minutes Underpredicted by >20 mins: N = ${underBy20.length}, Points Bias = ${under20Stats.bias}, Points MAE = ${under20Stats.mae}, Points RMSE = ${under20Stats.rmse}`);
  console.log(`- Segment | Minutes Overpredicted by >20 mins: N = ${overBy20.length}, Points Bias = ${over20Stats.bias}, Points MAE = ${over20Stats.mae}, Points RMSE = ${over20Stats.rmse}`);

  // 6. COUNTERFACTUAL ACTUAL-MINUTES DIAGNOSTIC (ORACLE MINUTES)
  console.log("\n--- 6. COUNTERFACTUAL ACTUAL-MINUTES DIAGNOSTIC ---");
  const rawModelStats = calcStats(records, "raw_expected_points", "actual_total_points");
  const oracleModelStats = calcStats(records, "oracle_expected_points", "actual_total_points");

  console.log(`Model Pipeline                      | N   | Mean Pred | Mean Act | Bias (Pred-Act) | MAE   | RMSE  | Spearman`);
  console.log(`------------------------------------+-----+-----------+----------+-----------------+-------+-------+---------`);
  console.log(
    `Raw Phase 4 (Phase 3 Pred Minutes)  | ${rawModelStats.n.toString().padEnd(3)} | ${rawModelStats.meanPred.toFixed(2).padEnd(9)} | ${rawModelStats.meanAct.toFixed(2).padEnd(8)} | ${rawModelStats.bias.toFixed(3).padEnd(15)} | ${rawModelStats.mae.toFixed(3).padEnd(5)} | ${rawModelStats.rmse.toFixed(3).padEnd(5)} | ${rawModelStats.spearman.toFixed(3)}`
  );
  console.log(
    `Oracle Minutes (Actual Minutes In)  | ${oracleModelStats.n.toString().padEnd(3)} | ${oracleModelStats.meanPred.toFixed(2).padEnd(9)} | ${oracleModelStats.meanAct.toFixed(2).padEnd(8)} | ${oracleModelStats.bias.toFixed(3).padEnd(15)} | ${oracleModelStats.mae.toFixed(3).padEnd(5)} | ${oracleModelStats.rmse.toFixed(3).padEnd(5)} | ${oracleModelStats.spearman.toFixed(3)}`
  );

  console.log(`\nDiagnostic Findings:`);
  console.log(`- When controlling 100% for playing time (Oracle Minutes):`);
  console.log(`  * Bias changes from ${rawModelStats.bias} pts to ${oracleModelStats.bias} pts (a reduction of ${(Math.abs(rawModelStats.bias) - Math.abs(oracleModelStats.bias)).toFixed(3)} pts or ${((1 - Math.abs(oracleModelStats.bias) / Math.abs(rawModelStats.bias)) * 100).toFixed(1)}% of total bias).`);
  console.log(`  * MAE changes from ${rawModelStats.mae} to ${oracleModelStats.mae}.`);
  console.log(`  * Spearman rank correlation improves from ${rawModelStats.spearman} to ${oracleModelStats.spearman}.`);

  // 7. EVENT MODEL ERROR WITH MINUTES CONTROLLED (ORACLE MINUTES)
  console.log("\n--- 7. EVENT MODEL ERROR WITH MINUTES CONTROLLED (ORACLE MINUTES) ---");
  const gkpOracle = calcStats(records.filter((r) => r.position_id === 1), "oracle_expected_points", "actual_total_points");
  const defOracle = calcStats(records.filter((r) => r.position_id === 2), "oracle_expected_points", "actual_total_points");
  const midOracle = calcStats(records.filter((r) => r.position_id === 3), "oracle_expected_points", "actual_total_points");
  const fwdOracle = calcStats(records.filter((r) => r.position_id === 4), "oracle_expected_points", "actual_total_points");

  console.log(`Position | N   | Raw Bias | Oracle Bias | Oracle MAE | Oracle RMSE | Oracle Spearman`);
  console.log(`---------+-----+----------+-------------+------------+-------------+----------------`);
  console.log(`GKP      | ${gkpOracle.n.toString().padEnd(3)} | -0.391   | ${gkpOracle.bias.toFixed(3).padEnd(11)} | ${gkpOracle.mae.toFixed(3).padEnd(10)} | ${gkpOracle.rmse.toFixed(3).padEnd(11)} | ${gkpOracle.spearman.toFixed(3)}`);
  console.log(`DEF      | ${defOracle.n.toString().padEnd(3)} | -0.884   | ${defOracle.bias.toFixed(3).padEnd(11)} | ${defOracle.mae.toFixed(3).padEnd(10)} | ${defOracle.rmse.toFixed(3).padEnd(11)} | ${defOracle.spearman.toFixed(3)}`);
  console.log(`MID      | ${midOracle.n.toString().padEnd(3)} | -0.910   | ${midOracle.bias.toFixed(3).padEnd(11)} | ${midOracle.mae.toFixed(3).padEnd(10)} | ${midOracle.rmse.toFixed(3).padEnd(11)} | ${midOracle.spearman.toFixed(3)}`);
  console.log(`FWD      | ${fwdOracle.n.toString().padEnd(3)} | -0.568   | ${fwdOracle.bias.toFixed(3).padEnd(11)} | ${fwdOracle.mae.toFixed(3).padEnd(10)} | ${fwdOracle.rmse.toFixed(3).padEnd(11)} | ${fwdOracle.spearman.toFixed(3)}`);

  let oGoalsErr = 0;
  let oAssistsErr = 0;
  let oBonusErr = 0;
  let oSavesErr = 0;
  const n = records.length;
  for (const r of records) {
    oGoalsErr += r.oracle_expected_goals - r.actual_goals;
    oAssistsErr += r.oracle_expected_assists - r.actual_assists;
    oBonusErr += r.oracle_expected_bonus - r.actual_bonus;
    oSavesErr += r.oracle_expected_saves - r.actual_saves;
  }
  const oCsBrier = calculateBrierScore(records.map(r => r.oracle_prob_clean_sheet), records.map(r => r.actual_clean_sheet));
  const oDcBrier = calculateBrierScore(records.map(r => r.oracle_prob_def_contrib), records.map(r => r.actual_def_contrib > 0 ? 1 : 0));

  console.log(`\nComponent Diagnostics with Oracle Minutes:`);
  console.log(`  - Expected Goals Bias: ${(oGoalsErr / n).toFixed(4)} goals`);
  console.log(`  - Expected Assists Bias: ${(oAssistsErr / n).toFixed(4)} assists`);
  console.log(`  - Expected Bonus Bias: ${(oBonusErr / n).toFixed(4)} bonus pts`);
  console.log(`  - Clean Sheet Brier Score: ${oCsBrier.toFixed(4)}`);
  console.log(`  - Defensive Contribution Brier Score: ${oDcBrier.toFixed(4)}`);
  console.log(`  - Expected Saves Bias: ${(oSavesErr / n).toFixed(4)} save pts`);

  // 8. STARTER-SPECIFIC AUDIT
  console.log("\n--- 8. STARTER-SPECIFIC AUDIT (High Predicted P(start)) ---");
  const pStart75 = records.filter((r) => r.prob_start >= 0.75);
  const pStart90 = records.filter((r) => r.prob_start >= 0.90);

  const stats75Mins = calcStats(pStart75, "expected_minutes", "actual_minutes");
  const stats75Pts = calcStats(pStart75, "raw_expected_points", "actual_total_points");
  const stats90Mins = calcStats(pStart90, "expected_minutes", "actual_minutes");
  const stats90Pts = calcStats(pStart90, "raw_expected_points", "actual_total_points");

  console.log(`Filter             | N   | Mean Pred Mins | Mean Act Mins | Mins Bias | Mean Raw xPts | Mean Act Pts | xPts Bias`);
  console.log(`-------------------+-----+----------------+---------------+-----------+---------------+--------------+----------`);
  console.log(
    `P(start) >= 0.75   | ${pStart75.length.toString().padEnd(3)} | ${stats75Mins.meanPred.toFixed(1).padEnd(14)} | ${stats75Mins.meanAct.toFixed(1).padEnd(13)} | ${stats75Mins.bias.toFixed(1).padEnd(9)} | ${stats75Pts.meanPred.toFixed(2).padEnd(13)} | ${stats75Pts.meanAct.toFixed(2).padEnd(12)} | ${stats75Pts.bias.toFixed(2)}`
  );
  console.log(
    `P(start) >= 0.90   | ${pStart90.length.toString().padEnd(3)} | ${stats90Mins.meanPred.toFixed(1).padEnd(14)} | ${stats90Mins.meanAct.toFixed(1).padEnd(13)} | ${stats90Mins.bias.toFixed(1).padEnd(9)} | ${stats90Pts.meanPred.toFixed(2).padEnd(13)} | ${stats90Pts.meanAct.toFixed(2).padEnd(12)} | ${stats90Pts.bias.toFixed(2)}`
  );

  // 9. BENCH / NON-APPEARANCE AUDIT
  console.log("\n--- 9. BENCH / NON-APPEARANCE AUDIT (Low Predicted P(app)) ---");
  const pApp25 = records.filter((r) => r.prob_appearance <= 0.25);
  const meanPredApp = pApp25.length > 0 ? pApp25.reduce((s, r) => s + r.prob_appearance, 0) / pApp25.length : 0;
  const actAppRate = pApp25.length > 0 ? pApp25.filter((r) => r.actual_appeared).length / pApp25.length : 0;
  const pApp25Mins = calcStats(pApp25, "expected_minutes", "actual_minutes");

  console.log(`- Low Appearance Filter: P(appearance) <= 0.25`);
  console.log(`  * Sample Size: N = ${pApp25.length}`);
  console.log(`  * Predicted Mean Appearance Probability: ${(meanPredApp * 100).toFixed(1)}%`);
  console.log(`  * Actual Appearance Rate: ${(actAppRate * 100).toFixed(1)}%`);
  console.log(`  * Predicted Mean Expected Minutes: ${pApp25Mins.meanPred.toFixed(1)} mins`);
  console.log(`  * Actual Mean Minutes: ${pApp25Mins.meanAct.toFixed(1)} mins`);
  console.log(`  * Minutes Bias: ${pApp25Mins.bias.toFixed(1)} mins`);

  // 10. CONFIDENCE VALIDATION
  console.log("\n--- 10. CONFIDENCE VALIDATION ---");
  // Check confidence quantiles
  const confSorted = [...records].sort((a, b) => a.expected_points_confidence - b.expected_points_confidence);
  const q1 = confSorted.slice(0, Math.floor(n / 3));
  const q2 = confSorted.slice(Math.floor(n / 3), Math.floor((2 * n) / 3));
  const q3 = confSorted.slice(Math.floor((2 * n) / 3));

  const q1Stats = calcStats(q1, "raw_expected_points", "actual_total_points");
  const q2Stats = calcStats(q2, "raw_expected_points", "actual_total_points");
  const q3Stats = calcStats(q3, "raw_expected_points", "actual_total_points");

  console.log(`Confidence Quantile | N   | Mean Confidence | MAE   | RMSE  | Bias`);
  console.log(`--------------------+-----+-----------------+-------+-------+------`);
  console.log(`Low (Q1)            | ${q1.length.toString().padEnd(3)} | ${(q1.reduce((s, r) => s + r.expected_points_confidence, 0) / q1.length).toFixed(3).padEnd(15)} | ${q1Stats.mae.toFixed(3).padEnd(5)} | ${q1Stats.rmse.toFixed(3).padEnd(5)} | ${q1Stats.bias.toFixed(3)}`);
  console.log(`Mid (Q2)            | ${q2.length.toString().padEnd(3)} | ${(q2.reduce((s, r) => s + r.expected_points_confidence, 0) / q2.length).toFixed(3).padEnd(15)} | ${q2Stats.mae.toFixed(3).padEnd(5)} | ${q2Stats.rmse.toFixed(3).padEnd(5)} | ${q2Stats.bias.toFixed(3)}`);
  console.log(`High (Q3)           | ${q3.length.toString().padEnd(3)} | ${(q3.reduce((s, r) => s + r.expected_points_confidence, 0) / q3.length).toFixed(3).padEnd(15)} | ${q3Stats.mae.toFixed(3).padEnd(5)} | ${q3Stats.rmse.toFixed(3).padEnd(5)} | ${q3Stats.bias.toFixed(3)}`);
  console.log(`- Correlation between Confidence and Absolute Prediction Error: rho = ${calculateSpearmanCorrelation(records.map(r => r.expected_points_confidence), records.map(r => Math.abs(r.points_pred_error)))}`);

  // 11. UNCERTAINTY COVERAGE
  console.log("\n--- 11. UNCERTAINTY COVERAGE ---");
  let insideCount = 0;
  let belowCount = 0;
  let aboveCount = 0;
  let widthSum = 0;

  for (const r of records) {
    const width = r.range_high - r.range_low;
    widthSum += width;
    if (r.actual_total_points < r.range_low) {
      belowCount++;
    } else if (r.actual_total_points > r.range_high) {
      aboveCount++;
    } else {
      insideCount++;
    }
  }

  const insidePct = (insideCount / n) * 100;
  const belowPct = (belowCount / n) * 100;
  const abovePct = (aboveCount / n) * 100;
  const meanWidth = widthSum / n;

  console.log(`- Total Predictions Evaluated: N = ${n}`);
  console.log(`- Intended Nominal Prediction Interval: ~85% (80–90% empirical target)`);
  console.log(`- Percentage of Actual Outcomes INSIDE Predicted Range: ${insidePct.toFixed(1)}%`);
  console.log(`- Percentage of Actual Outcomes BELOW Range: ${belowPct.toFixed(1)}%`);
  console.log(`- Percentage of Actual Outcomes ABOVE Range: ${abovePct.toFixed(1)}%`);
  console.log(`- Mean Interval Width: ${meanWidth.toFixed(2)} points`);

  // Breakdown by position
  console.log(`\nCoverage by Position:`);
  for (const posId of [1, 2, 3, 4]) {
    const posRecs = records.filter((r) => r.position_id === posId);
    const pN = posRecs.length;
    const pInside = posRecs.filter((r) => r.actual_total_points >= r.range_low && r.actual_total_points <= r.range_high).length;
    const pWidth = posRecs.reduce((s, r) => s + (r.range_high - r.range_low), 0) / pN;
    const posName = posId === 1 ? "GKP" : posId === 2 ? "DEF" : posId === 3 ? "MID" : "FWD";
    console.log(`  - ${posName} (N=${pN}): Inside = ${((pInside / pN) * 100).toFixed(1)}%, Mean Width = ${pWidth.toFixed(2)} pts`);
  }
}

runDiagnostic().catch(console.error);
