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

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
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

// Build Reliability Bins
function computeReliabilityBins(preds: number[], acts: boolean[], binEdges = [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
  const bins = [];
  for (let b = 0; b < binEdges.length - 1; b++) {
    const low = binEdges[b];
    const high = binEdges[b + 1];
    const binPreds: number[] = [];
    const binActs: number[] = [];
    for (let i = 0; i < preds.length; i++) {
      const p = preds[i];
      if ((b === 0 && p >= low && p <= high) || (b > 0 && p > low && p <= high)) {
        binPreds.push(p);
        binActs.push(acts[i] ? 1 : 0);
      }
    }
    const count = binPreds.length;
    const meanPred = count > 0 ? roundTo(binPreds.reduce((a, b) => a + b, 0) / count, 4) : 0;
    const meanAct = count > 0 ? roundTo(binActs.reduce((a, b) => a + b, 0) / count, 4) : 0;
    bins.push({
      range: `[${low.toFixed(1)}, ${high.toFixed(1)}]`,
      count,
      mean_predicted: meanPred,
      realized_rate: meanAct,
      gap: roundTo(meanPred - meanAct, 4),
    });
  }
  return bins;
}

async function main() {
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

  // Model versions to compare
  const versions = [
    { label: "Phase 3.0 (v1.0 Baseline)", version: MINUTES_MODEL_VERSION_V1 },
    { label: "Phase 3.1 Closure (v1.1 Recalibrated)", version: MINUTES_MODEL_VERSION_V1_1 },
  ];

  type EvaluationRecord = {
    gw: number;
    player: any;
    features: any;
    expMinutes: number;
    actualMinutes: number;
    probApp: number;
    actualApp: boolean;
    probStart: number;
    actualStart: boolean;
    prob60: number;
    actual60: boolean;
    xPts: number;
    actualPts: number;
    roleSegment: string;
  };

  const recordsByVersion: Record<string, EvaluationRecord[]> = {};

  for (const v of versions) {
    recordsByVersion[v.version] = [];

    for (const targetGw of [1, 2]) {
      const cutoffGw = targetGw - 1;
      const snapshot = new PredictionSnapshot({
        snapshot_id: `snap_gw${targetGw}`,
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
        const actual60 = actualMinutes >= 60;
        const actualTotalPoints = targetMatch.total_points !== undefined ? Number(targetMatch.total_points) : 0;

        const features = buildPlayerPredictionFeatures({
          player,
          snapshot,
          history: cutoffSafeHistory,
          allFixtures: fixtures,
          allTeams: bootstrap.teams,
        });

        const minsRes = buildPlayerExpectedMinutes({
          player,
          features,
          snapshot,
          history: cutoffSafeHistory,
          modelVersion: v.version,
        });

        const ptsRes = buildPlayerExpectedPoints({
          player,
          features,
          minutesResult: minsRes,
          snapshot,
          history: cutoffSafeHistory,
          allFixtures: fixtures,
          allTeams: bootstrap.teams,
        });

        const expMins = Number(minsRes.expected_minutes.value) || 0;
        const probApp = Number(minsRes.probability_appearance.value) || 0;
        const probStart = Number(minsRes.probability_start.value) || 0;
        const prob60 = Number(minsRes.probability_60_plus_minutes.value) || 0;
        const xPts = Number(ptsRes.expected_points_next_gameweek.value) || 0;

        // Determine role segment
        let roleSegment = "Unknown (0 GWs)";
        if (cutoffSafeHistory.length > 0) {
          const lastMatch = cutoffSafeHistory[cutoffSafeHistory.length - 1];
          const lastMins = Number(lastMatch.minutes) || 0;
          const lastStarts = lastMatch.starts !== undefined ? Number(lastMatch.starts) === 1 : lastMins > 60;
          if (lastStarts && lastMins >= 60) {
            roleSegment = "Strong Starter";
          } else if (lastStarts && lastMins < 60) {
            roleSegment = "Uncertain Starter";
          } else if (!lastStarts && lastMins > 0) {
            roleSegment = "Sub / Rotation";
          } else {
            roleSegment = "Low Appearance / Bench";
          }
        }

        recordsByVersion[v.version].push({
          gw: targetGw,
          player,
          features,
          expMinutes: expMins,
          actualMinutes,
          probApp,
          actualApp: actualAppeared,
          probStart,
          actualStart: actualStarted,
          prob60,
          actual60,
          xPts,
          actualPts: actualTotalPoints,
          roleSegment,
        });
      }
    }
  }

  console.log("\n==========================================================================================");
  console.log("             COMPREHENSIVE BACKTEST COMPARISON: PHASE 3.0 vs PHASE 3.1 CLOSURE            ");
  console.log("==========================================================================================");

  for (const gwSelect of [1, 2, "FULL"] as const) {
    console.log(`\n------------------------------------------------------------------------------------------`);
    console.log(`EVALUATION DATASET: ${gwSelect === "FULL" ? "FULL WALK-FORWARD (GW1 + GW2)" : `GAMEWEEK ${gwSelect}`}`);
    console.log(`------------------------------------------------------------------------------------------`);

    for (const v of versions) {
      const allRecs = recordsByVersion[v.version];
      const recs = gwSelect === "FULL" ? allRecs : allRecs.filter((r) => r.gw === gwSelect);

      const minsStats = calcStats(
        recs.map((r) => r.expMinutes),
        recs.map((r) => r.actualMinutes)
      );
      const ptsStats = calcStats(
        recs.map((r) => r.xPts),
        recs.map((r) => r.actualPts)
      );

      const appBrier = calculateBrierScore(
        recs.map((r) => r.probApp),
        recs.map((r) => r.actualApp)
      );
      const startBrier = calculateBrierScore(
        recs.map((r) => r.probStart),
        recs.map((r) => r.actualStart)
      );
      const brier60 = calculateBrierScore(
        recs.map((r) => r.prob60),
        recs.map((r) => r.actual60)
      );

      console.log(`\n  [${v.label}] (N = ${recs.length})`);
      console.log(`  Minutes Metrics:`);
      console.log(`    MAE:  ${minsStats.mae} mins`);
      console.log(`    RMSE: ${minsStats.rmse} mins`);
      console.log(`    Bias: ${minsStats.bias > 0 ? "+" : ""}${minsStats.bias} mins (predicted - actual)`);
      console.log(`  Probability Brier Scores (lower is better):`);
      console.log(`    P(appearance): ${appBrier}`);
      console.log(`    P(start):      ${startBrier}`);
      console.log(`    P(60+ mins):   ${brier60}`);
      console.log(`  Downstream Phase 4 Expected Points (xPts):`);
      console.log(`    MAE:      ${ptsStats.mae} pts`);
      console.log(`    RMSE:     ${ptsStats.rmse} pts`);
      console.log(`    Bias:     ${ptsStats.bias > 0 ? "+" : ""}${ptsStats.bias} pts (predicted - actual)`);
      console.log(`    Spearman: ${ptsStats.spearman}`);
    }
  }

  // Segment Breakdown for GW2
  console.log("\n==========================================================================================");
  console.log("                   GW2 ROLE SEGMENT BREAKDOWN (PHASE 3.0 vs PHASE 3.1 CLOSURE)            ");
  console.log("==========================================================================================");

  const gw2P30 = recordsByVersion[MINUTES_MODEL_VERSION_V1].filter((r) => r.gw === 2);
  const gw2P31 = recordsByVersion[MINUTES_MODEL_VERSION_V1_1].filter((r) => r.gw === 2);

  const segments = ["Strong Starter", "Uncertain Starter", "Sub / Rotation", "Low Appearance / Bench"];

  for (const seg of segments) {
    const p30Seg = gw2P30.filter((r) => r.roleSegment === seg);
    const p31Seg = gw2P31.filter((r) => r.roleSegment === seg);
    const n = p30Seg.length;
    if (n === 0) continue;

    const actualAppRate = roundTo(p30Seg.filter((r) => r.actualApp).length / n, 3);
    const actualStartRate = roundTo(p30Seg.filter((r) => r.actualStart).length / n, 3);
    const actualMinsMean = roundTo(p30Seg.reduce((a, b) => a + b.actualMinutes, 0) / n, 1);

    const p30MeanApp = roundTo(p30Seg.reduce((a, b) => a + b.probApp, 0) / n, 3);
    const p30MeanStart = roundTo(p30Seg.reduce((a, b) => a + b.probStart, 0) / n, 3);
    const p30MeanMins = roundTo(p30Seg.reduce((a, b) => a + b.expMinutes, 0) / n, 1);
    const p30MinsMAE = calcStats(p30Seg.map((r) => r.expMinutes), p30Seg.map((r) => r.actualMinutes)).mae;

    const p31MeanApp = roundTo(p31Seg.reduce((a, b) => a + b.probApp, 0) / n, 3);
    const p31MeanStart = roundTo(p31Seg.reduce((a, b) => a + b.probStart, 0) / n, 3);
    const p31MeanMins = roundTo(p31Seg.reduce((a, b) => a + b.expMinutes, 0) / n, 1);
    const p31MinsMAE = calcStats(p31Seg.map((r) => r.expMinutes), p31Seg.map((r) => r.actualMinutes)).mae;

    console.log(`\nSegment: [${seg}] (N = ${n})`);
    console.log(`  Actuals: App Rate = ${actualAppRate} | Start Rate = ${actualStartRate} | Mean Minutes = ${actualMinsMean}`);
    console.log(`  Phase 3.0: P(app) = ${p30MeanApp} | P(start) = ${p30MeanStart} | ExpMins = ${p30MeanMins} | Minutes MAE = ${p30MinsMAE}`);
    console.log(`  Phase 3.1: P(app) = ${p31MeanApp} | P(start) = ${p31MeanStart} | ExpMins = ${p31MeanMins} | Minutes MAE = ${p31MinsMAE}`);
  }

  // Reliability Bins for GW2
  console.log("\n==========================================================================================");
  console.log("                   GW2 PROBABILITY RELIABILITY BINS (PHASE 3.1 CLOSURE)                   ");
  console.log("==========================================================================================");

  console.log("\n1. P(appearance) Calibration Bins:");
  const appBins = computeReliabilityBins(gw2P31.map((r) => r.probApp), gw2P31.map((r) => r.actualApp));
  console.table(appBins);

  console.log("\n2. P(start) Calibration Bins:");
  const startBins = computeReliabilityBins(gw2P31.map((r) => r.probStart), gw2P31.map((r) => r.actualStart));
  console.table(startBins);

  console.log("\n3. P(60+ mins) Calibration Bins:");
  const bins60 = computeReliabilityBins(gw2P31.map((r) => r.prob60), gw2P31.map((r) => r.actual60));
  console.table(bins60);

  // Six Named Players Trace
  console.log("\n==========================================================================================");
  console.log("                LIVE SIX-PLAYER TRACE (PHASE 3.0 vs PHASE 3.1 CLOSURE)                     ");
  console.log("==========================================================================================");

  const tracePlayerIds = [
    { id: 1, name: "David Raya (GKP, Arsenal)" },
    { id: 8, name: "Riccardo Calafiori (DEF, Arsenal)" },
    { id: 31, name: "Ezri Konsa (DEF, Aston Villa)" },
    { id: 212, name: "Will Hughes (MID, Crystal Palace)" },
    { id: 411, name: "Erling Haaland (FWD, Man City)" },
    { id: 426, name: "Bruno Fernandes (MID, Man Utd)" },
  ];

  for (const tp of tracePlayerIds) {
    console.log(`\nPlayer: ${tp.name} (ID: ${tp.id})`);
    for (const gw of [1, 2]) {
      const p30Rec = recordsByVersion[MINUTES_MODEL_VERSION_V1].find((r) => r.player.id === tp.id && r.gw === gw);
      const p31Rec = recordsByVersion[MINUTES_MODEL_VERSION_V1_1].find((r) => r.player.id === tp.id && r.gw === gw);
      if (!p30Rec || !p31Rec) continue;

      console.log(`  GW${gw}: Realized Minutes = ${p31Rec.actualMinutes}, Started = ${p31Rec.actualStart}, Points = ${p31Rec.actualPts}`);
      console.log(`    Phase 3.0: P(avail)=${p30Rec.features.availability.chance_of_playing_next_round.value ?? "0.95"} | P(start)=${p30Rec.probStart} | P(app)=${p30Rec.probApp} | P(60+)=${p30Rec.prob60} | ExpMins=${p30Rec.expMinutes} | xPts=${p30Rec.xPts}`);
      console.log(`    Phase 3.1: P(avail)=${p31Rec.features.availability.chance_of_playing_next_round.value ?? "0.95"} | P(start)=${p31Rec.probStart} | P(app)=${p31Rec.probApp} | P(60+)=${p31Rec.prob60} | ExpMins=${p31Rec.expMinutes} | xPts=${p31Rec.xPts}`);
    }
  }

  // Synthetic Trajectory Sweeps
  console.log("\n==========================================================================================");
  console.log("                     SYNTHETIC APPEARANCE & START ROLE CURVES                             ");
  console.log("==========================================================================================");

  const fakePlayer = (posId: number) => ({ id: 999, web_name: "Synth Player", element_type: posId, status: "a" });
  const dummyFeatures = {
    team_position: { player_position: new DataValue({ value: 3, validity: DataValidity.OBSERVED, source: "test", as_of_gameweek: 1 }) },
    availability: { chance_of_playing_next_round: new DataValue({ value: null, validity: DataValidity.MISSING, source: "test", as_of_gameweek: 1 }) },
    fixtures: { prediction_gw_fixture_count: 1, gameweek_type: "SINGLE", prediction_gw_fixtures: [{ fixture_id: 1, opponent_team_id: 2, is_home: true }] },
  } as any;

  console.log("\n1. Consecutive Zero-Minute Fixtures (Outfielder on Bench/Reserve):");
  for (const zeros of [1, 2, 3, 4, 5, 8]) {
    const hist = Array.from({ length: zeros }).map((_, i) => ({ round: i + 1, minutes: 0, starts: 0 }));
    const snap = new PredictionSnapshot({
      snapshot_id: `snap_${zeros}`,
      boundary: new GameweekBoundary({ last_finished_gameweek: zeros, prediction_gameweek: zeros + 1, historical_cutoff_gameweek: zeros, in_progress_gameweek: null }),
    });

    const res30 = buildPlayerExpectedMinutes({ player: fakePlayer(3), features: dummyFeatures, snapshot: snap, history: hist, modelVersion: MINUTES_MODEL_VERSION_V1 });
    const res31 = buildPlayerExpectedMinutes({ player: fakePlayer(3), features: dummyFeatures, snapshot: snap, history: hist, modelVersion: MINUTES_MODEL_VERSION_V1_1 });

    console.log(`  ${zeros} Zero-min match(es) (${zeros}/${zeros} zeros):`);
    console.log(`    Phase 3.0: P(start)=${res30.probability_start.value} | P(app)=${res30.probability_appearance.value} | ExpMins=${res30.expected_minutes.value}`);
    console.log(`    Phase 3.1: P(start)=${res31.probability_start.value} | P(app)=${res31.probability_appearance.value} | ExpMins=${res31.expected_minutes.value}`);
  }

  console.log("\n2. Consecutive Substitute Appearances (e.g. 20 mins off bench, 0 starts):");
  for (const subs of [1, 2, 3, 4, 8]) {
    const hist = Array.from({ length: subs }).map((_, i) => ({ round: i + 1, minutes: 20, starts: 0 }));
    const snap = new PredictionSnapshot({
      snapshot_id: `snap_sub_${subs}`,
      boundary: new GameweekBoundary({ last_finished_gameweek: subs, prediction_gameweek: subs + 1, historical_cutoff_gameweek: subs, in_progress_gameweek: null }),
    });

    const res30 = buildPlayerExpectedMinutes({ player: fakePlayer(3), features: dummyFeatures, snapshot: snap, history: hist, modelVersion: MINUTES_MODEL_VERSION_V1 });
    const res31 = buildPlayerExpectedMinutes({ player: fakePlayer(3), features: dummyFeatures, snapshot: snap, history: hist, modelVersion: MINUTES_MODEL_VERSION_V1_1 });

    console.log(`  ${subs} Sub appearance(s) (${subs}/${subs} subs):`);
    console.log(`    Phase 3.0: P(start)=${res30.probability_start.value} | P(app)=${res30.probability_appearance.value} | ExpMins=${res30.expected_minutes.value}`);
    console.log(`    Phase 3.1: P(start)=${res31.probability_start.value} | P(app)=${res31.probability_appearance.value} | ExpMins=${res31.expected_minutes.value}`);
  }
}

main();
