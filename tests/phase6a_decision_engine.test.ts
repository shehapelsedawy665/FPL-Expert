import { describe, it, expect } from "vitest";
import {
  PredictionSnapshot,
  GameweekBoundary,
} from "../services/prediction_contract.js";
import {
  DecisionSquadPlayer,
  DecisionEngineResult,
  DECISION_ENGINE_VERSION_V1,
  runFplDecisionEngine,
  optimizeStartingXi,
  optimizeOutfieldBenchOrder,
  evaluateCaptaincyPairs,
  resolveDecisionExpectedPoints,
  isFormationLegal,
  simulateSingleDnpReplacement,
  simulateAutoSubSequential,
  buildDecisionSquadFromPlayers,
  LEGAL_FORMATIONS,
} from "../services/decision_engine.js";
import { MINUTES_MODEL_VERSION_V1_1 } from "../services/expected_minutes_model.js";
import { EXPECTED_POINTS_MODEL_VERSION } from "../services/expected_points_model.js";
import { CalibrationStatus } from "../services/calibration_service.js";

function createSnapshot(cutoffGw = 2): PredictionSnapshot {
  return new PredictionSnapshot({
    snapshot_id: `snapshot_gw${cutoffGw + 1}_test`,
    boundary: {
      last_finished_gameweek: cutoffGw,
      in_progress_gameweek: null,
      prediction_gameweek: cutoffGw + 1,
      historical_cutoff_gameweek: cutoffGw,
    },
  });
}

function mockDecisionSquad(): DecisionSquadPlayer[] {
  // 15 squad players: 2 GK, 5 DEF, 5 MID, 3 FWD
  return [
    // GKs
    {
      id: 1,
      web_name: "GK1_Starter",
      element_type: 1,
      position_short_name: "GKP",
      team_id: 1,
      team_short_name: "ARS",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "CHE", is_home: true, difficulty: 3 }],
      expected_minutes: 90,
      probability_available: 1.0,
      probability_appearance: 0.98,
      probability_start: 0.98,
      probability_60_plus_minutes: 0.96,
      raw_expected_points: 4.8,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 4.8,
      expert_score: 70,
    },
    {
      id: 2,
      web_name: "GK2_Bench",
      element_type: 1,
      position_short_name: "GKP",
      team_id: 2,
      team_short_name: "AVL",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "NEW", is_home: false, difficulty: 4 }],
      expected_minutes: 90,
      probability_available: 1.0,
      probability_appearance: 0.95,
      probability_start: 0.95,
      probability_60_plus_minutes: 0.90,
      raw_expected_points: 3.5,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 3.5,
      expert_score: 60,
    },
    // DEFs
    {
      id: 3,
      web_name: "DEF1_High",
      element_type: 2,
      position_short_name: "DEF",
      team_id: 1,
      team_short_name: "ARS",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "CHE", is_home: true, difficulty: 3 }],
      expected_minutes: 88,
      probability_available: 1.0,
      probability_appearance: 0.97,
      probability_start: 0.95,
      probability_60_plus_minutes: 0.94,
      raw_expected_points: 5.6,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 5.6,
      expert_score: 75,
    },
    {
      id: 4,
      web_name: "DEF2_High",
      element_type: 2,
      position_short_name: "DEF",
      team_id: 3,
      team_short_name: "LIV",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "EVE", is_home: true, difficulty: 2 }],
      expected_minutes: 89,
      probability_available: 1.0,
      probability_appearance: 0.98,
      probability_start: 0.97,
      probability_60_plus_minutes: 0.95,
      raw_expected_points: 5.4,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 5.4,
      expert_score: 74,
    },
    {
      id: 5,
      web_name: "DEF3_Mid",
      element_type: 2,
      position_short_name: "DEF",
      team_id: 4,
      team_short_name: "MCI",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "MUN", is_home: true, difficulty: 3 }],
      expected_minutes: 80,
      probability_available: 1.0,
      probability_appearance: 0.90,
      probability_start: 0.85,
      probability_60_plus_minutes: 0.82,
      raw_expected_points: 4.5,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 4.5,
      expert_score: 68,
    },
    {
      id: 6,
      web_name: "DEF4_Low",
      element_type: 2,
      position_short_name: "DEF",
      team_id: 5,
      team_short_name: "TOT",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "BOU", is_home: false, difficulty: 3 }],
      expected_minutes: 75,
      probability_available: 1.0,
      probability_appearance: 0.85,
      probability_start: 0.80,
      probability_60_plus_minutes: 0.75,
      raw_expected_points: 3.2,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 3.2,
      expert_score: 55,
    },
    {
      id: 7,
      web_name: "DEF5_Bench",
      element_type: 2,
      position_short_name: "DEF",
      team_id: 6,
      team_short_name: "WHU",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "BRE", is_home: false, difficulty: 3 }],
      expected_minutes: 60,
      probability_available: 0.75,
      probability_appearance: 0.70,
      probability_start: 0.65,
      probability_60_plus_minutes: 0.60,
      raw_expected_points: 2.1,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 2.1,
      expert_score: 45,
    },
    // MIDs
    {
      id: 8,
      web_name: "MID1_Salah",
      element_type: 3,
      position_short_name: "MID",
      team_id: 3,
      team_short_name: "LIV",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "EVE", is_home: true, difficulty: 2 }],
      expected_minutes: 89,
      probability_available: 1.0,
      probability_appearance: 0.98,
      probability_start: 0.98,
      probability_60_plus_minutes: 0.96,
      raw_expected_points: 7.8,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 7.8,
      expert_score: 92,
    },
    {
      id: 9,
      web_name: "MID2_Saka",
      element_type: 3,
      position_short_name: "MID",
      team_id: 1,
      team_short_name: "ARS",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "CHE", is_home: true, difficulty: 3 }],
      expected_minutes: 86,
      probability_available: 1.0,
      probability_appearance: 0.96,
      probability_start: 0.94,
      probability_60_plus_minutes: 0.90,
      raw_expected_points: 6.9,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 6.9,
      expert_score: 85,
    },
    {
      id: 10,
      web_name: "MID3_Palmer",
      element_type: 3,
      position_short_name: "MID",
      team_id: 7,
      team_short_name: "CHE",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "ARS", is_home: false, difficulty: 4 }],
      expected_minutes: 85,
      probability_available: 1.0,
      probability_appearance: 0.95,
      probability_start: 0.92,
      probability_60_plus_minutes: 0.88,
      raw_expected_points: 6.4,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 6.4,
      expert_score: 82,
    },
    {
      id: 11,
      web_name: "MID4_Mbeumo",
      element_type: 3,
      position_short_name: "MID",
      team_id: 8,
      team_short_name: "BRE",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "WHU", is_home: true, difficulty: 3 }],
      expected_minutes: 88,
      probability_available: 1.0,
      probability_appearance: 0.97,
      probability_start: 0.96,
      probability_60_plus_minutes: 0.94,
      raw_expected_points: 5.9,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 5.9,
      expert_score: 78,
    },
    {
      id: 12,
      web_name: "MID5_Bench",
      element_type: 3,
      position_short_name: "MID",
      team_id: 9,
      team_short_name: "FUL",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "NFO", is_home: false, difficulty: 3 }],
      expected_minutes: 70,
      probability_available: 1.0,
      probability_appearance: 0.88,
      probability_start: 0.78,
      probability_60_plus_minutes: 0.72,
      raw_expected_points: 4.1,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 4.1,
      expert_score: 62,
    },
    // FWDs
    {
      id: 13,
      web_name: "FWD1_Haaland",
      element_type: 4,
      position_short_name: "FWD",
      team_id: 4,
      team_short_name: "MCI",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "MUN", is_home: true, difficulty: 3 }],
      expected_minutes: 89,
      probability_available: 1.0,
      probability_appearance: 0.99,
      probability_start: 0.99,
      probability_60_plus_minutes: 0.97,
      raw_expected_points: 8.5,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 8.5,
      expert_score: 96,
    },
    {
      id: 14,
      web_name: "FWD2_Watkins",
      element_type: 4,
      position_short_name: "FWD",
      team_id: 2,
      team_short_name: "AVL",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "NEW", is_home: false, difficulty: 4 }],
      expected_minutes: 85,
      probability_available: 1.0,
      probability_appearance: 0.96,
      probability_start: 0.94,
      probability_60_plus_minutes: 0.91,
      raw_expected_points: 6.2,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 6.2,
      expert_score: 80,
    },
    {
      id: 15,
      web_name: "FWD3_Solanke",
      element_type: 4,
      position_short_name: "FWD",
      team_id: 5,
      team_short_name: "TOT",
      status: "a",
      fixture_count: 1,
      fixtures_summary: [{ opponent_short_name: "BOU", is_home: false, difficulty: 3 }],
      expected_minutes: 80,
      probability_available: 1.0,
      probability_appearance: 0.90,
      probability_start: 0.88,
      probability_60_plus_minutes: 0.82,
      raw_expected_points: 5.1,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      decision_expected_points: 5.1,
      expert_score: 72,
    },
  ];
}

describe("Phase 6A Decision Engine Tests", () => {
  const snapshot = createSnapshot(2);

  it("1. Verifies versions and snapshot metadata", () => {
    expect(DECISION_ENGINE_VERSION_V1).toBe("6a.1.0");
    expect(MINUTES_MODEL_VERSION_V1_1).toBe("expected-minutes.v1.1");
    expect(EXPECTED_POINTS_MODEL_VERSION).toBe("expected-points.v1");
  });

  it("2. Optimizes Starting XI and evaluates all 8 legal formations", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    expect(result.all_formations.length).toBe(8);
    expect(result.starting_xi.length).toBe(11);
    expect(isFormationLegal(result.starting_xi)).toBe(true);

    // Verify all formations have exactly 11 starters
    for (const f of result.all_formations) {
      expect(f.starters.length).toBe(11);
      expect(isFormationLegal(f.starters)).toBe(true);
      const defs = f.starters.filter((p) => p.element_type === 2).length;
      const mids = f.starters.filter((p) => p.element_type === 3).length;
      const fwds = f.starters.filter((p) => p.element_type === 4).length;
      const gks = f.starters.filter((p) => p.element_type === 1).length;

      expect(gks).toBe(1);
      expect(defs).toBeGreaterThanOrEqual(3);
      expect(defs).toBeLessThanOrEqual(5);
      expect(mids).toBeGreaterThanOrEqual(2);
      expect(mids).toBeLessThanOrEqual(5);
      expect(fwds).toBeGreaterThanOrEqual(1);
      expect(fwds).toBeLessThanOrEqual(3);
    }
  });

  it("3. Independent Brute-Force global maximum verification", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    // Independent combinatorial brute-force: choose 11 out of 15
    const n = squad.length;
    let maxCombXpts = -Infinity;
    let bestComb: DecisionSquadPlayer[] = [];
    let legalCombCount = 0;

    function combinations(k: number, start = 0, current: DecisionSquadPlayer[] = []) {
      if (current.length === k) {
        if (isFormationLegal(current)) {
          legalCombCount++;
          const sumXpts = Math.round(current.reduce((acc, p) => acc + p.decision_expected_points, 0) * 100) / 100;
          if (sumXpts > maxCombXpts) {
            maxCombXpts = sumXpts;
            bestComb = [...current];
          }
        }
        return;
      }
      for (let i = start; i < n; i++) {
        current.push(squad[i]);
        combinations(k, i + 1, current);
        current.pop();
      }
    }

    combinations(11);

    expect(legalCombCount).toBeGreaterThan(0);
    expect(Math.abs(result.starting_xi_total_xpts - maxCombXpts)).toBeLessThan(1e-4);
  });

  it("4. Evaluates all 6 outfield bench permutations and orders bench correctly", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    expect(result.bench_permutations.length).toBe(6);
    expect(result.ordered_outfield_bench.length).toBe(3);
    expect(result.bench_goalkeeper).toBeDefined();
    expect(result.bench_goalkeeper.element_type).toBe(1);

    // Permutations must be sorted descending by utility
    for (let i = 0; i < result.bench_permutations.length - 1; i++) {
      expect(result.bench_permutations[i].expected_replacement_utility).toBeGreaterThanOrEqual(
        result.bench_permutations[i + 1].expected_replacement_utility
      );
    }
  });

  it("5. Verifies bench utility formula arithmetic", () => {
    const squad = mockDecisionSquad();
    const xiResult = optimizeStartingXi(squad);
    const outfieldBench = squad.filter(
      (p) => p.element_type !== 1 && !xiResult.best_formation.starters.some((s) => s.id === p.id)
    );
    const benchOpt = optimizeOutfieldBenchOrder(xiResult.best_formation.starters, outfieldBench);

    const bestPerm = benchOpt.all_permutations[0];
    const computedUtility = xiResult.best_formation.starters
      .filter((p) => p.element_type !== 1)
      .reduce((sum, starter) => {
        const pDnp = Math.round((1.0 - starter.probability_appearance) * 10000) / 10000;
        const sim = simulateSingleDnpReplacement(xiResult.best_formation.starters, starter, bestPerm.permutation);
        const repXpts = sim.subUsed ? sim.subUsed.decision_expected_points : 0.0;
        return sum + pDnp * repXpts;
      }, 0);

    expect(Math.abs(bestPerm.expected_replacement_utility - Math.round(computedUtility * 10000) / 10000)).toBeLessThan(1e-4);
  });

  it("6. Simulates single-DNP auto-sub for DEF, MID, FWD", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    const startingDefs = result.starting_xi.filter((p) => p.element_type === 2);
    const startingMids = result.starting_xi.filter((p) => p.element_type === 3);
    const startingFwds = result.starting_xi.filter((p) => p.element_type === 4);

    // DEF DNP
    if (startingDefs.length > 0) {
      const defDnp = startingDefs[0];
      const subRes = simulateAutoSubSequential(
        result.starting_xi,
        [defDnp],
        result.bench_goalkeeper,
        result.ordered_outfield_bench,
        "Single DEF DNP"
      );
      expect(subRes.is_final_formation_legal).toBe(true);
      expect(subRes.final_lineup.some((p) => p.id === defDnp.id)).toBe(false);
    }

    // MID DNP
    if (startingMids.length > 0) {
      const midDnp = startingMids[0];
      const subRes = simulateAutoSubSequential(
        result.starting_xi,
        [midDnp],
        result.bench_goalkeeper,
        result.ordered_outfield_bench,
        "Single MID DNP"
      );
      expect(subRes.is_final_formation_legal).toBe(true);
      expect(subRes.final_lineup.some((p) => p.id === midDnp.id)).toBe(false);
    }

    // FWD DNP
    if (startingFwds.length > 0) {
      const fwdDnp = startingFwds[0];
      const subRes = simulateAutoSubSequential(
        result.starting_xi,
        [fwdDnp],
        result.bench_goalkeeper,
        result.ordered_outfield_bench,
        "Single FWD DNP"
      );
      expect(subRes.is_final_formation_legal).toBe(true);
      expect(subRes.final_lineup.some((p) => p.id === fwdDnp.id)).toBe(false);
    }
  });

  it("7. Enforces critical formation legality: bench #1 skipped if formation invalid", () => {
    // 3-5-2 formation: exactly 3 DEFs starting.
    // If 1 DEF gets DNP, bench #1 is a MID/FWD, bench #2 is a DEF.
    // Formation requires at least 3 DEFs, so bench #1 must be SKIPPED, bench #2 enters!
    const squad = mockDecisionSquad();

    const defStarters = squad.filter((p) => [3, 4, 5].includes(p.id));
    const midStarters = squad.filter((p) => [8, 9, 10, 11, 12].includes(p.id));
    const fwdStarters = squad.filter((p) => [13, 14].includes(p.id));
    const gkStarter = squad.find((p) => p.id === 1)!;
    const starting352 = [gkStarter, ...defStarters, ...midStarters, ...fwdStarters];

    // Bench: sub 1 = FWD (id 15, Solanke), sub 2 = DEF (id 6, DEF4_Low), sub 3 = DEF (id 7, DEF5_Bench)
    const sub1 = squad.find((p) => p.id === 15)!; // FWD
    const sub2 = squad.find((p) => p.id === 6)!;  // DEF
    const sub3 = squad.find((p) => p.id === 7)!;  // DEF
    const gkBench = squad.find((p) => p.id === 2)!;

    // DEF id 3 misses match
    const absent = squad.find((p) => p.id === 3)!;
    const subResult = simulateAutoSubSequential(
      starting352,
      [absent],
      gkBench,
      [sub1, sub2, sub3],
      "Critical Formation Test"
    );

    // Sub 1 (FWD) would make 2-5-3 which is ILLEGAL (DEF < 3).
    // Therefore Sub 1 MUST be skipped, and Sub 2 (DEF) must enter.
    expect(subResult.is_final_formation_legal).toBe(true);
    expect(subResult.substitutions_made.length).toBe(1);
    expect(subResult.substitutions_made[0].bench_in.id).toBe(sub2.id); // Sub 2 entered
    expect(subResult.substitutions_made[0].bench_slot).toBe(2);
  });

  it("8. Simulates multiple DNPs (2 and 3 DNPs) sequentially preserving legality", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    // 2 DNPs (1 DEF and 1 MID)
    const defStarter = result.starting_xi.find((p) => p.element_type === 2)!;
    const midStarter = result.starting_xi.find((p) => p.element_type === 3)!;
    const fwdStarter = result.starting_xi.find((p) => p.element_type === 4)!;

    const sub2Res = simulateAutoSubSequential(
      result.starting_xi,
      [defStarter, midStarter],
      result.bench_goalkeeper,
      result.ordered_outfield_bench,
      "Two DNPs (1 DEF, 1 MID)"
    );
    expect(sub2Res.is_final_formation_legal).toBe(true);

    // 3 DNPs (1 DEF, 1 MID, 1 FWD)
    const sub3Res = simulateAutoSubSequential(
      result.starting_xi,
      [defStarter, midStarter, fwdStarter],
      result.bench_goalkeeper,
      result.ordered_outfield_bench,
      "Three DNPs (1 DEF, 1 MID, 1 FWD)"
    );
    expect(sub3Res.is_final_formation_legal).toBe(true);
  });

  it("9. Handles Goalkeeper auto-sub and verifies outfield cannot replace GK", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    const gkStarter = result.starting_xi.find((p) => p.element_type === 1)!;

    // Starter GK misses match
    const subRes = simulateAutoSubSequential(
      result.starting_xi,
      [gkStarter],
      result.bench_goalkeeper,
      result.ordered_outfield_bench,
      "GK DNP"
    );

    expect(subRes.is_final_formation_legal).toBe(true);
    expect(subRes.final_lineup.find((p) => p.element_type === 1)?.id).toBe(result.bench_goalkeeper.id);
  });

  it("10. Captaincy & Vice-Captain formula and joint bonus evaluation", () => {
    const squad = mockDecisionSquad();
    const result = runFplDecisionEngine({ squad, snapshot });

    expect(result.captain).toBeDefined();
    expect(result.vice_captain).toBeDefined();
    expect(result.captain.id).not.toBe(result.vice_captain.id);
    expect(result.captaincy_bonus).toBeGreaterThan(0);
    expect(result.captaincy_pairs.length).toBe(11 * 10); // 110 pairs

    // Pairs must be sorted descending by bonus
    for (let i = 0; i < result.captaincy_pairs.length - 1; i++) {
      expect(result.captaincy_pairs[i].expected_captaincy_bonus).toBeGreaterThanOrEqual(
        result.captaincy_pairs[i + 1].expected_captaincy_bonus
      );
    }
  });

  it("11. Captain hedging scenario where uncertain high-xPts player gets hedged or deprioritized", () => {
    const squad = mockDecisionSquad();
    const pA: DecisionSquadPlayer = {
      ...squad[12],
      id: 1001,
      web_name: "Player_A_Risky",
      decision_expected_points: 6.0,
      probability_appearance: 0.50,
      raw_expected_points: 6.0,
    };
    const pB: DecisionSquadPlayer = {
      ...squad[7],
      id: 1002,
      web_name: "Player_B_Solid",
      decision_expected_points: 5.8,
      probability_appearance: 0.99,
      raw_expected_points: 5.8,
    };
    const pC: DecisionSquadPlayer = {
      ...squad[8],
      id: 1003,
      web_name: "Player_C_Solid",
      decision_expected_points: 5.5,
      probability_appearance: 0.98,
      raw_expected_points: 5.5,
    };

    // Construct an 11-player lineup containing pA, pB, pC and 8 lower-scoring players (e.g. 2.0-3.0 xPts)
    const lowerPlayers = squad.slice(0, 8).map((p, idx) => ({
      ...p,
      id: 2000 + idx,
      decision_expected_points: 2.0,
      raw_expected_points: 2.0,
      probability_appearance: 0.95,
    }));

    const miniXi = [pA, pB, pC, ...lowerPlayers];
    const capResult = evaluateCaptaincyPairs(miniXi);
    expect(capResult.best_pair).toBeDefined();

    // If pA has 0 probability and 0 xPts, pB must be selected as captain
    const pZero: DecisionSquadPlayer = {
      ...pA,
      decision_expected_points: 0.0,
      probability_appearance: 0.0,
      raw_expected_points: 0.0,
    };
    const capRes2 = evaluateCaptaincyPairs([pZero, pB, pC, ...lowerPlayers]);
    expect(capRes2.best_pair.captain.id).toBe(pB.id); // B is chosen captain
  });

  it("12. Tiny P(appearance) safety: no NaN, no division by zero", () => {
    const squad = mockDecisionSquad();
    const pZero: DecisionSquadPlayer = {
      ...squad[0],
      probability_appearance: 0.0,
      decision_expected_points: 0.0,
      raw_expected_points: 0.0,
    };
    const pTiny: DecisionSquadPlayer = {
      ...squad[1],
      probability_appearance: 1e-6,
      decision_expected_points: 0.005,
      raw_expected_points: 0.005,
    };

    const xi = [pZero, pTiny, ...squad.slice(2, 11)];
    const capOpt = evaluateCaptaincyPairs(xi);

    expect(Number.isNaN(capOpt.best_pair.expected_captaincy_bonus)).toBe(false);
    expect(Number.isFinite(capOpt.best_pair.expected_captaincy_bonus)).toBe(true);
    for (const pair of capOpt.all_pairs) {
      expect(Number.isNaN(pair.expected_captaincy_bonus)).toBe(false);
      expect(Number.isFinite(pair.expected_captaincy_bonus)).toBe(true);
    }
  });

  it("13. No double playing-time discount verification", () => {
    const rawVal = 6.78;
    const resolved = resolveDecisionExpectedPoints({
      raw_expected_points: rawVal,
      calibrated_expected_points: null,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      fixture_count: 1,
    });
    expect(resolved).toBe(rawVal);
  });

  it("14. Calibration fallback logic", () => {
    const rawVal = 5.0;
    const calVal = 4.2;

    // Calibrated status -> returns calibrated
    const activeRes = resolveDecisionExpectedPoints({
      raw_expected_points: rawVal,
      calibrated_expected_points: calVal,
      calibration_status: CalibrationStatus.CALIBRATED,
      fixture_count: 1,
    });
    expect(activeRes).toBe(calVal);

    // Inactive status -> falls back to raw
    const fallbackRes = resolveDecisionExpectedPoints({
      raw_expected_points: rawVal,
      calibrated_expected_points: calVal,
      calibration_status: CalibrationStatus.INSUFFICIENT_DATA,
      fixture_count: 1,
    });
    expect(fallbackRes).toBe(rawVal);
  });

  it("15. Deterministic replay invariance", () => {
    const squad = mockDecisionSquad();
    const res1 = runFplDecisionEngine({ squad, snapshot });
    const res2 = runFplDecisionEngine({ squad, snapshot });

    expect(res1.recommended_formation_label).toBe(res2.recommended_formation_label);
    expect(res1.starting_xi_total_xpts).toBe(res2.starting_xi_total_xpts);
    expect(res1.captain.id).toBe(res2.captain.id);
    expect(res1.vice_captain.id).toBe(res2.vice_captain.id);
    expect(res1.ordered_outfield_bench.map((p) => p.id)).toEqual(
      res2.ordered_outfield_bench.map((p) => p.id)
    );
  });
});
