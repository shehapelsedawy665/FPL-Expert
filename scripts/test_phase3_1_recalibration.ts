import {
  fetchBootstrapData,
  fetchFixtures,
  fetchPlayerSummary,
} from "../services/fpl_service.js";
import {
  GameweekBoundary,
  PredictionSnapshot,
  DataValidity,
  DataValue,
} from "../services/prediction_contract.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import {
  buildPlayerExpectedMinutes,
  deriveSupportingHistoryEvidence,
  POSITION_PRIORS_V1,
  POSITION_PRIORS_V1_1,
  MINUTES_MODEL_VERSION_V1,
  MINUTES_MODEL_VERSION_V1_1,
} from "../services/expected_minutes_model.js";
import {
  buildPlayerExpectedPoints,
} from "../services/expected_points_model.js";
import {
  calculateSpearmanCorrelation,
  calculateBrierScore,
} from "../services/backtest_service.js";

function calcStats(preds: number[], acts: number[]) {
  const n = preds.length;
  if (n === 0) return { n: 0, mae: 0, rmse: 0, bias: 0, spearman: 0 };
  let sumAbs = 0;
  let sumSq = 0;
  let sumErr = 0;
  for (let i = 0; i < n; i++) {
    const err = preds[i] - acts[i];
    sumErr += err;
    sumAbs += Math.abs(err);
    sumSq += err * err;
  }
  return {
    n,
    mae: Math.round((sumAbs / n) * 1000) / 1000,
    rmse: Math.round(Math.sqrt(sumSq / n) * 1000) / 1000,
    bias: Math.round((sumErr / n) * 1000) / 1000,
    spearman: calculateSpearmanCorrelation(preds, acts),
  };
}

async function fetchPlayerSummariesBatched(playerIds: number[], batchSize = 30) {
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

async function runSyntheticRoleTests() {
  console.log("\n===============================================================================");
  console.log("             PHASE 3.1 SYNTHETIC ROLE-DISCRIMINATION TEST SUITE                ");
  console.log("===============================================================================");

  const fakePlayer = (posId: number, status = "a") => ({
    id: 999,
    web_name: "Test Player",
    element_type: posId,
    status,
  });

  const makeSnapshot = (cutoffGw: number | null, predGw: number) =>
    new PredictionSnapshot({
      snapshot_id: `snap_test_${predGw}`,
      boundary: new GameweekBoundary({
        last_finished_gameweek: cutoffGw,
        prediction_gameweek: predGw,
        historical_cutoff_gameweek: cutoffGw,
        in_progress_gameweek: null,
      }),
    });

  const dummyFeatures = (posId: number, fixtureCount = 1) => ({
    team_position: {
      player_position: new DataValue({
        value: posId,
        validity: DataValidity.OBSERVED,
        source: "test",
        as_of_gameweek: 1,
      }),
    },
    availability: {
      chance_of_playing_next_round: new DataValue({
        value: null,
        validity: DataValidity.MISSING,
        source: "test",
        as_of_gameweek: 1,
      }),
    },
    fixtures: {
      prediction_gw_fixture_count: fixtureCount,
      gameweek_type: fixtureCount === 1 ? "SINGLE" : fixtureCount === 2 ? "DOUBLE" : "BLANK",
      prediction_gw_fixtures: Array.from({ length: fixtureCount }).map((_, i) => ({
        fixture_id: 100 + i,
        opponent_team_id: 2,
        is_home: true,
      })),
    },
  } as any);

  // Scenario 1: Undisputed Starter (5/5 90 min starts)
  const starterHist = [
    { round: 1, minutes: 90, starts: 1 },
    { round: 2, minutes: 90, starts: 1 },
    { round: 3, minutes: 90, starts: 1 },
    { round: 4, minutes: 90, starts: 1 },
    { round: 5, minutes: 90, starts: 1 },
  ];
  const snap5 = makeSnapshot(5, 6);
  const starterRes = buildPlayerExpectedMinutes({
    player: fakePlayer(3),
    features: dummyFeatures(3),
    snapshot: snap5,
    history: starterHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n1. Undisputed Midfielder Starter (5 starts, 90 mins each):");
  console.log(`   - Exp Minutes: ${starterRes.expected_minutes.value} (Target: >= 78)`);
  console.log(`   - P(start): ${starterRes.probability_start.value} (Target: >= 0.90)`);
  console.log(`   - P(60+): ${starterRes.probability_60_plus_minutes.value}`);
  console.log(`   - Confidence: ${starterRes.playing_time_confidence.value}`);
  if (Number(starterRes.expected_minutes.value) < 78 || Number(starterRes.probability_start.value) < 0.90) {
    throw new Error("FAIL: Starter underpredicted in synthetic test");
  }

  // Scenario 2: Starting Goalkeeper (1 start, 90 mins in GW1 -> GW2)
  const gkpHist = [{ round: 1, minutes: 90, starts: 1 }];
  const snap1 = makeSnapshot(1, 2);
  const gkpRes = buildPlayerExpectedMinutes({
    player: fakePlayer(1),
    features: dummyFeatures(1),
    snapshot: snap1,
    history: gkpHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n2. Goalkeeper Starter (1 start, 90 mins in GW1 -> GW2):");
  console.log(`   - Exp Minutes: ${gkpRes.expected_minutes.value} (Target: >= 80)`);
  console.log(`   - P(start): ${gkpRes.probability_start.value} (Target: >= 0.88)`);
  if (Number(gkpRes.expected_minutes.value) < 80) {
    throw new Error("FAIL: Goalkeeper starter underpredicted in synthetic test");
  }

  // Scenario 3: Established Super-sub (5 apps, 0 starts, 20 mins each)
  const subHist = [
    { round: 1, minutes: 20, starts: 0 },
    { round: 2, minutes: 20, starts: 0 },
    { round: 3, minutes: 20, starts: 0 },
    { round: 4, minutes: 20, starts: 0 },
    { round: 5, minutes: 20, starts: 0 },
  ];
  const subRes = buildPlayerExpectedMinutes({
    player: fakePlayer(4),
    features: dummyFeatures(4),
    snapshot: snap5,
    history: subHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n3. Established Forward Super-Sub (5 appearances, 0 starts, 20 mins each):");
  console.log(`   - Exp Minutes: ${subRes.expected_minutes.value} (Target: 12 - 25)`);
  console.log(`   - P(start): ${subRes.probability_start.value} (Target: <= 0.10)`);
  console.log(`   - P(app): ${subRes.probability_appearance.value} (Target: >= 0.70)`);
  if (Number(subRes.probability_start.value) > 0.10 || Number(subRes.probability_appearance.value) < 0.70) {
    throw new Error("FAIL: Super-sub misclassified in synthetic test");
  }

  // Scenario 4: Unused Bench Player (5 GWs, 0 mins each)
  const benchHist = [
    { round: 1, minutes: 0, starts: 0 },
    { round: 2, minutes: 0, starts: 0 },
    { round: 3, minutes: 0, starts: 0 },
    { round: 4, minutes: 0, starts: 0 },
    { round: 5, minutes: 0, starts: 0 },
  ];
  const benchRes = buildPlayerExpectedMinutes({
    player: fakePlayer(2),
    features: dummyFeatures(2),
    snapshot: snap5,
    history: benchHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n4. Unused Defender (5 GWs, 0 minutes):");
  console.log(`   - Exp Minutes: ${benchRes.expected_minutes.value} (Target: <= 2.0)`);
  console.log(`   - P(app): ${benchRes.probability_appearance.value} (Target: <= 0.05)`);
  console.log(`   - P(start): ${benchRes.probability_start.value} (Target: <= 0.03)`);
  if (Number(benchRes.expected_minutes.value) > 2.0 || Number(benchRes.probability_appearance.value) > 0.05) {
    throw new Error("FAIL: Unused bench player overpredicted in synthetic test");
  }

  // Scenario 5: Cold Start / Preseason (0 history)
  const coldRes = buildPlayerExpectedMinutes({
    player: fakePlayer(3),
    features: dummyFeatures(3),
    snapshot: makeSnapshot(null, 1),
    history: [],
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n5. Cold Start / Preseason (0 history):");
  console.log(`   - Exp Minutes: ${coldRes.expected_minutes.value}`);
  console.log(`   - P(avail): ${coldRes.probability_available.value}`);
  console.log(`   - P(app): ${coldRes.probability_appearance.value}`);
  console.log(`   - P(start): ${coldRes.probability_start.value}`);
  console.log(`   - Confidence Validity: ${coldRes.playing_time_confidence.validity} (Target: MISSING)`);
  if (coldRes.playing_time_confidence.validity !== DataValidity.MISSING) {
    throw new Error("FAIL: Cold-start confidence must be DataValidity.MISSING");
  }

  // Scenario 6: DGW & BGW Invariance
  const dgwRes = buildPlayerExpectedMinutes({
    player: fakePlayer(3),
    features: dummyFeatures(3, 2),
    snapshot: snap5,
    history: starterHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });
  const bgwRes = buildPlayerExpectedMinutes({
    player: fakePlayer(3),
    features: dummyFeatures(3, 0),
    snapshot: snap5,
    history: starterHist,
    modelVersion: MINUTES_MODEL_VERSION_V1_1,
  });

  console.log("\n6. Gameweek Structure Handling (DGW / BGW):");
  console.log(`   - Single GW Exp Mins: ${starterRes.expected_minutes.value}`);
  console.log(`   - DGW Exp Mins: ${dgwRes.expected_minutes.value} (Should equal 2x Single GW)`);
  console.log(`   - BGW Exp Mins: ${bgwRes.expected_minutes.value} (Target: null / NOT_APPLICABLE)`);
  console.log(`   - BGW Validity: ${bgwRes.expected_minutes.validity}`);

  if (Math.abs(Number(dgwRes.expected_minutes.value) - 2 * Number(starterRes.expected_minutes.value)) > 0.2) {
    throw new Error("FAIL: DGW expected minutes scaling failed");
  }
  if (bgwRes.expected_minutes.validity !== DataValidity.NOT_APPLICABLE) {
    throw new Error("FAIL: BGW expected minutes validity must be NOT_APPLICABLE");
  }

  console.log("\n>>> ALL SYNTHETIC ROLE-DISCRIMINATION TESTS PASSED! <<<");
}

async function runBacktestValidation() {
  console.log("\n===============================================================================");
  console.log("             PHASE 3.1 REAL-DATA WALK-FORWARD BACKTEST VALIDATION              ");
  console.log("===============================================================================");

  const [bootstrap, fixtures] = await Promise.all([
    fetchBootstrapData(),
    fetchFixtures(),
  ]);

  const targetPlayers = bootstrap.players.filter(
    (p: any) => p.minutes > 0 || p.selected_by_percent > 1.0 || [1, 8, 31, 212, 411, 426].includes(p.id)
  );

  const summaries = await fetchPlayerSummariesBatched(
    targetPlayers.map((p: any) => p.id),
    30
  );
  const historiesByPlayer: Record<number, Array<Record<string, any>>> = {};
  for (const [idStr, sum] of Object.entries(summaries)) {
    historiesByPlayer[Number(idStr)] = (sum as any).history || [];
  }

  const gw1v1: any[] = [];
  const gw1v1_1: any[] = [];
  const gw2v1: any[] = [];
  const gw2v1_1: any[] = [];

  for (const targetGw of [1, 2]) {
    const cutoffGw = targetGw - 1;
    const snapshot = new PredictionSnapshot({
      snapshot_id: `cmp_snap_gw${targetGw}_cutoff${cutoffGw}`,
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

      const actualMinutes = targetMatch.minutes !== undefined ? Number(targetMatch.minutes) : 0;
      const actualStarted = targetMatch.starts !== undefined ? Number(targetMatch.starts) === 1 : actualMinutes > 60;
      const actualAppeared = actualMinutes > 0;
      const actual60Plus = actualMinutes >= 60;
      const actualTotalPoints = targetMatch.total_points !== undefined ? Number(targetMatch.total_points) : 0;

      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      // 1. Phase 3.0 (v1)
      const m1 = buildPlayerExpectedMinutes({
        player,
        features,
        snapshot,
        history: cutoffSafeHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1,
      });
      const p1 = buildPlayerExpectedPoints({
        player,
        features,
        minutesResult: m1,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      // 2. Phase 3.1 (v1.1)
      const m1_1 = buildPlayerExpectedMinutes({
        player,
        features,
        snapshot,
        history: cutoffSafeHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      });
      const p1_1 = buildPlayerExpectedPoints({
        player,
        features,
        minutesResult: m1_1,
        snapshot,
        history: cutoffSafeHistory,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
      });

      // Strict Invariant Check for every single prediction
      const pAvail = Number(m1_1.probability_available.value) || 0;
      const pApp = Number(m1_1.probability_appearance.value) || 0;
      const pStart = Number(m1_1.probability_start.value) || 0;
      const p60 = Number(m1_1.probability_60_plus_minutes.value) || 0;

      if (p60 > pStart + 1e-6 || pStart > pApp + 1e-6 || pApp > pAvail + 1e-6) {
        throw new Error(`FAIL: Invariant violation for player ${player.id}: 60+(${p60}) <= start(${pStart}) <= app(${pApp}) <= avail(${pAvail})`);
      }

      const row1 = {
        player_id: player.id,
        web_name: player.web_name,
        target_gw: targetGw,
        exp_mins: Number(m1.expected_minutes.value) || 0,
        prob_app: Number(m1.probability_appearance.value) || 0,
        prob_start: Number(m1.probability_start.value) || 0,
        prob_60: Number(m1.probability_60_plus_minutes.value) || 0,
        xpts: Number(p1.expected_points_next_gameweek.value) || 0,
        actual_mins: actualMinutes,
        actual_started: actualStarted,
        actual_appeared: actualAppeared,
        actual_60: actual60Plus,
        actual_pts: actualTotalPoints,
      };

      const row1_1 = {
        player_id: player.id,
        web_name: player.web_name,
        target_gw: targetGw,
        exp_mins: Number(m1_1.expected_minutes.value) || 0,
        prob_app: Number(m1_1.probability_appearance.value) || 0,
        prob_start: Number(m1_1.probability_start.value) || 0,
        prob_60: Number(m1_1.probability_60_plus_minutes.value) || 0,
        xpts: Number(p1_1.expected_points_next_gameweek.value) || 0,
        actual_mins: actualMinutes,
        actual_started: actualStarted,
        actual_appeared: actualAppeared,
        actual_60: actual60Plus,
        actual_pts: actualTotalPoints,
      };

      if (targetGw === 1) {
        gw1v1.push(row1);
        gw1v1_1.push(row1_1);
      } else {
        gw2v1.push(row1);
        gw2v1_1.push(row1_1);
      }
    }
  }

  const allV1 = [...gw1v1, ...gw2v1];
  const allV1_1 = [...gw1v1_1, ...gw2v1_1];

  const reportSet = (name: string, set30: any[], set31: any[]) => {
    console.log(`\n--- ${name} (N = ${set30.length}) ---`);

    const mins30 = calcStats(set30.map(r => r.exp_mins), set30.map(r => r.actual_mins));
    const mins31 = calcStats(set31.map(r => r.exp_mins), set31.map(r => r.actual_mins));

    const appBrier30 = calculateBrierScore(set30.map(r => r.prob_app), set30.map(r => r.actual_appeared));
    const appBrier31 = calculateBrierScore(set31.map(r => r.prob_app), set31.map(r => r.actual_appeared));

    const startBrier30 = calculateBrierScore(set30.map(r => r.prob_start), set30.map(r => r.actual_started));
    const startBrier31 = calculateBrierScore(set31.map(r => r.prob_start), set31.map(r => r.actual_started));

    const sixtyBrier30 = calculateBrierScore(set30.map(r => r.prob_60), set30.map(r => r.actual_60));
    const sixtyBrier31 = calculateBrierScore(set31.map(r => r.prob_60), set31.map(r => r.actual_60));

    const pts30 = calcStats(set30.map(r => r.xpts), set30.map(r => r.actual_pts));
    const pts31 = calcStats(set31.map(r => r.xpts), set31.map(r => r.actual_pts));

    console.log(`Metric                     | Phase 3.0 (v1)     | Phase 3.1 (v1.1)    | Delta (v1.1 - v1)`);
    console.log(`---------------------------+--------------------+---------------------+------------------`);
    console.log(`Minutes MAE                | ${mins30.mae.toString().padEnd(18)} | ${mins31.mae.toString().padEnd(19)} | ${(mins31.mae - mins30.mae).toFixed(3)}`);
    console.log(`Minutes RMSE               | ${mins30.rmse.toString().padEnd(18)} | ${mins31.rmse.toString().padEnd(19)} | ${(mins31.rmse - mins30.rmse).toFixed(3)}`);
    console.log(`Minutes Bias (Pred - Act)  | ${mins30.bias.toString().padEnd(18)} | ${mins31.bias.toString().padEnd(19)} | ${(mins31.bias - mins30.bias).toFixed(3)}`);
    console.log(`P(appearance) Brier Score  | ${appBrier30.toString().padEnd(18)} | ${appBrier31.toString().padEnd(19)} | ${(appBrier31 - appBrier30).toFixed(4)}`);
    console.log(`P(start) Brier Score       | ${startBrier30.toString().padEnd(18)} | ${startBrier31.toString().padEnd(19)} | ${(startBrier31 - startBrier30).toFixed(4)}`);
    console.log(`P(60+) Brier Score         | ${sixtyBrier30.toString().padEnd(18)} | ${sixtyBrier31.toString().padEnd(19)} | ${(sixtyBrier31 - sixtyBrier30).toFixed(4)}`);
    console.log(`---------------------------+--------------------+---------------------+------------------`);
    console.log(`Downstream xPts MAE        | ${pts30.mae.toString().padEnd(18)} | ${pts31.mae.toString().padEnd(19)} | ${(pts31.mae - pts30.mae).toFixed(3)}`);
    console.log(`Downstream xPts RMSE       | ${pts30.rmse.toString().padEnd(18)} | ${pts31.rmse.toString().padEnd(19)} | ${(pts31.rmse - pts30.rmse).toFixed(3)}`);
    console.log(`Downstream xPts Bias       | ${pts30.bias.toString().padEnd(18)} | ${pts31.bias.toString().padEnd(19)} | ${(pts31.bias - pts30.bias).toFixed(3)}`);
    console.log(`Downstream xPts Spearman   | ${pts30.spearman.toString().padEnd(18)} | ${pts31.spearman.toString().padEnd(19)} | ${(pts31.spearman - pts30.spearman).toFixed(3)}`);

    return { mins30, mins31, pts30, pts31 };
  };

  reportSet("FULL WALK-FORWARD (GW1 + GW2)", allV1, allV1_1);
  reportSet("GW1 (PRESEASON COLD START)", gw1v1, gw1v1_1);
  const gw2Res = reportSet("GW2 (EVIDENCE AVAILABLE)", gw2v1, gw2v1_1);

  // Verification of key acceptance criteria:
  if (gw2Res.mins31.mae >= gw2Res.mins30.mae) {
    throw new Error("FAIL: Phase 3.1 did not reduce Minutes MAE on GW2");
  }
  if (Math.abs(gw2Res.mins31.bias) >= Math.abs(gw2Res.mins30.bias)) {
    throw new Error("FAIL: Phase 3.1 did not reduce Minutes Bias on GW2");
  }

  console.log("\n>>> ALL WALK-FORWARD REAL DATA VALIDATIONS PASSED! <<<");
}

async function main() {
  await runSyntheticRoleTests();
  await runBacktestValidation();
}

main().catch((err) => {
  console.error("Test Suite Failed:", err);
  process.exit(1);
});
