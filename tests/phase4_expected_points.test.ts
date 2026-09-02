import { describe, it, expect } from "vitest";
import {
  DataValidity,
  PredictionSnapshot,
  makePredictionSnapshot,
} from "../services/prediction_contract.js";
import {
  buildPlayerPredictionFeatures,
} from "../services/prediction_features.js";
import {
  buildPlayerExpectedMinutes,
} from "../services/expected_minutes_model.js";
import {
  FPL_SCORING_RULES_VERSION,
  EXPECTED_POINTS_MODEL_VERSION,
  OFFICIAL_FPL_SCORING_RULES_2026_27,
  buildPlayerExpectedPoints,
  expectedSavePointsFromPoisson,
  expectedGoalsConcededDeductionFromPoisson,
  calculateFixtureModifiers,
} from "../services/expected_points_model.js";

// Helper to create synthetic standard snapshot
function createSnapshot(cutoffGw: number = 2, inProgressGw: number | null = null): PredictionSnapshot {
  return new PredictionSnapshot({
    snapshot_id: "test_snapshot_gw3",
    boundary: {
      last_finished_gameweek: cutoffGw,
      in_progress_gameweek: inProgressGw,
      prediction_gameweek: inProgressGw ? inProgressGw + 1 : cutoffGw + 1,
      historical_cutoff_gameweek: cutoffGw,
    },
  });
}

// Helper to mock player
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
    penalties_order: null,
    direct_freekicks_order: null,
    corners_and_indirect_freekicks_order: null,
    expert_score: 75.0,
    future_fpl_score: 72.0,
    current_form_score: 70.0,
    minutes_security: 85.0,
    ...overrides,
  };
}

// Helper to mock history rows
function mockHistory(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  return rows.map((r, idx) => ({
    round: idx + 1,
    minutes: 90,
    starts: 1,
    goals_scored: 0,
    assists: 0,
    clean_sheets: 0,
    goals_conceded: 1,
    saves: 0,
    yellow_cards: 0,
    red_cards: 0,
    own_goals: 0,
    penalties_saved: 0,
    penalties_missed: 0,
    bonus: 0,
    bps: 15,
    expected_goals: "0.20",
    expected_assists: "0.15",
    expected_goals_conceded: "1.10",
    ...r,
  }));
}

// Helper to mock fixtures
function mockFixtures(fixtures: Array<Record<string, any>>): Array<Record<string, any>> {
  return fixtures.map((f, idx) => ({
    id: idx + 1,
    event: f.event ?? 3,
    team_h: f.team_h ?? 1,
    team_a: f.team_a ?? 2,
    team_h_difficulty: f.team_h_difficulty ?? 3,
    team_a_difficulty: f.team_a_difficulty ?? 3,
    finished: f.finished ?? false,
    kickoff_time: "2026-09-15T14:00:00Z",
    ...f,
  }));
}

describe("Phase 4: Official-FPL Expected Points Model v1", () => {
  // ==========================================================================
  // SECTION 1: OFFICIAL SCORING RULES AUDIT (2026/27)
  // ==========================================================================
  describe("1. Official Scoring Rules 2026/27 Audit", () => {
    it("verifies appearance point rules", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.appearance_under_60).toBe(1);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.appearance_60_plus).toBe(2);
    });

    it("verifies position-specific goal scoring points", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goal_by_position[1]).toBe(10); // GKP
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goal_by_position[2]).toBe(6);  // DEF
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goal_by_position[3]).toBe(5);  // MID
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goal_by_position[4]).toBe(4);  // FWD
    });

    it("verifies assist points across all positions", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.assist).toBe(3);
    });

    it("verifies clean sheet scoring by position", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.clean_sheet_by_position[1]).toBe(4); // GKP
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.clean_sheet_by_position[2]).toBe(4); // DEF
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.clean_sheet_by_position[3]).toBe(1); // MID
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.clean_sheet_by_position[4]).toBe(0); // FWD
    });

    it("verifies goalkeeper save and penalty save rules", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.save_points_per_block).toBe(1);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.saves_per_block_threshold).toBe(3);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.penalty_save).toBe(5);
    });

    it("verifies goals conceded deduction rules", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goals_conceded_deduction_per_block).toBe(-1);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goals_conceded_block_threshold).toBe(2);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.goals_conceded_deduction_positions).toEqual([1, 2]);
    });

    it("verifies penalty miss and disciplinary deductions", () => {
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.penalty_miss).toBe(-2);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.yellow_card).toBe(-1);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.red_card).toBe(-3);
      expect(OFFICIAL_FPL_SCORING_RULES_2026_27.own_goal).toBe(-2);
    });
  });

  // ==========================================================================
  // SECTION 2: SYNTHETIC MODEL TESTS (20 CORE CRITERIA)
  // ==========================================================================
  describe("2. Synthetic Expected Points Model Criteria", () => {
    const snapshot = createSnapshot(2);
    const fixtures = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);

    function runPipeline(player: Record<string, any>, historyRows: Array<Record<string, any>> = [], fixList = fixtures) {
      const hist = mockHistory(historyRows);
      const feat = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history: hist,
        allFixtures: fixList,
      });
      const mins = buildPlayerExpectedMinutes({
        player,
        features: feat,
        snapshot,
        history: hist,
      });
      const ep = buildPlayerExpectedPoints({
        player,
        features: feat,
        minutesResult: mins,
        snapshot,
        history: hist,
        allFixtures: fixList,
      });
      return { feat, mins, ep };
    }

    // 1. Zero-minute player
    it("1. zero-minute player produces 0 expected points", () => {
      const player = mockPlayer({ status: "a" });
      // 0 minutes in all matches
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 0, starts: 0 },
        { round: 2, minutes: 0, starts: 0 },
      ]);
      expect(ep.breakdown.expected_minutes).toBeLessThan(10);
      expect(ep.expected_points_next_gameweek.value).toBeLessThan(1.0);
    });

    // 2. Regular starter
    it("2. regular starter produces realistic positive expected points", () => {
      const player = mockPlayer({ element_type: 4 }); // FWD
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.60", expected_assists: "0.20" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.80", expected_assists: "0.10" },
      ]);
      expect(ep.breakdown.expected_minutes).toBeGreaterThan(70);
      expect(ep.breakdown.expected_appearance_points).toBeGreaterThan(1.5);
      expect(ep.breakdown.expected_goal_points).toBeGreaterThan(1.0);
      expect(ep.expected_points_next_gameweek.value).toBeGreaterThan(3.5);
    });

    // 3. Substitute cameo player
    it("3. substitute player produces lower points reflecting cameo playing time", () => {
      const player = mockPlayer({ element_type: 3 });
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 15, starts: 0 },
        { round: 2, minutes: 20, starts: 0 },
      ]);
      expect(ep.breakdown.expected_minutes).toBeLessThan(30);
      expect(ep.breakdown.expected_appearance_points).toBeLessThan(1.2);
    });

    // 4. Unavailable player
    it("4. unavailable player produces 0 expected points and observed_zero validity", () => {
      const player = mockPlayer({ status: "i", chance_of_playing_next_round: 0 });
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1 },
        { round: 2, minutes: 90, starts: 1 },
      ]);
      expect(ep.breakdown.expected_minutes).toBe(0.0);
      expect(ep.expected_points_next_gameweek.value).toBe(0.0);
      expect(ep.expected_points_next_gameweek.validity).toBe(DataValidity.OBSERVED_ZERO);
    });

    // 5. High xG vs Low xG with identical minutes
    it("5. high xG player yields strictly higher expected goal points than low xG player", () => {
      const pHigh = mockPlayer({ id: 101, element_type: 4 });
      const pLow = mockPlayer({ id: 102, element_type: 4 });

      const resHigh = runPipeline(pHigh, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "1.20", expected_assists: "0.10" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "1.00", expected_assists: "0.10" },
      ]);
      const resLow = runPipeline(pLow, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.05", expected_assists: "0.10" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.05", expected_assists: "0.10" },
      ]);

      expect(resHigh.ep.breakdown.expected_goals).toBeGreaterThan(resLow.ep.breakdown.expected_goals);
      expect(resHigh.ep.breakdown.expected_goal_points).toBeGreaterThan(resLow.ep.breakdown.expected_goal_points);
      expect(resHigh.ep.expected_points_next_gameweek.value).toBeGreaterThan(resLow.ep.expected_points_next_gameweek.value);
    });

    // 6. High xA vs Low xA with identical minutes
    it("6. high xA player yields strictly higher expected assist points than low xA player", () => {
      const pHigh = mockPlayer({ id: 201, element_type: 3 });
      const pLow = mockPlayer({ id: 202, element_type: 3 });

      const resHigh = runPipeline(pHigh, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.10", expected_assists: "0.80" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.10", expected_assists: "0.90" },
      ]);
      const resLow = runPipeline(pLow, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.10", expected_assists: "0.02" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.10", expected_assists: "0.03" },
      ]);

      expect(resHigh.ep.breakdown.expected_assists).toBeGreaterThan(resLow.ep.breakdown.expected_assists);
      expect(resHigh.ep.breakdown.expected_assist_points).toBeGreaterThan(resLow.ep.breakdown.expected_assist_points);
    });

    // 7. Strong defensive fixture (FDR 2) vs Weak defensive fixture (FDR 5)
    it("7. easy fixture (FDR 2) produces higher clean sheet and lower goals conceded deduction than hard fixture (FDR 5)", () => {
      const pEasy = mockPlayer({ id: 301, element_type: 2 });
      const pHard = mockPlayer({ id: 302, element_type: 2 });

      const fixEasy = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2 }]);
      const fixHard = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 5 }]);

      const resEasy = runPipeline(pEasy, [
        { round: 1, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
        { round: 2, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
      ], fixEasy);

      const resHard = runPipeline(pHard, [
        { round: 1, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
        { round: 2, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
      ], fixHard);

      expect(resEasy.ep.breakdown.probability_clean_sheet).toBeGreaterThan(resHard.ep.breakdown.probability_clean_sheet);
      expect(resEasy.ep.breakdown.expected_clean_sheet_points).toBeGreaterThan(resHard.ep.breakdown.expected_clean_sheet_points);
      // Deduction is negative, so less severe deduction means a value closer to 0 (greater algebraically)
      expect(resEasy.ep.breakdown.expected_goals_conceded_deduction).toBeGreaterThanOrEqual(resHard.ep.breakdown.expected_goals_conceded_deduction);
    });

    // 8. Goalkeeper save-heavy profile
    it("8. goalkeeper save points are derived using discrete Poisson expectation", () => {
      const pGk = mockPlayer({ id: 401, element_type: 1 });
      const { ep } = runPipeline(pGk, [
        { round: 1, minutes: 90, starts: 1, saves: 6 },
        { round: 2, minutes: 90, starts: 1, saves: 7 },
      ]);
      expect(ep.breakdown.expected_saves).toBeGreaterThan(3.5);
      expect(ep.breakdown.expected_save_points).toBeGreaterThan(0.7);
    });

    // 9. Clean-sheet probability ordering
    it("9. clean-sheet probability scales monotonically with historical team performance", () => {
      const pClean = mockPlayer({ id: 501, element_type: 2 });
      const pLeaky = mockPlayer({ id: 502, element_type: 2 });

      const resClean = runPipeline(pClean, [
        { round: 1, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
        { round: 2, minutes: 90, starts: 1, clean_sheets: 1, goals_conceded: 0 },
      ]);
      const resLeaky = runPipeline(pLeaky, [
        { round: 1, minutes: 90, starts: 1, clean_sheets: 0, goals_conceded: 3 },
        { round: 2, minutes: 90, starts: 1, clean_sheets: 0, goals_conceded: 4 },
      ]);

      expect(resClean.ep.breakdown.probability_clean_sheet).toBeGreaterThan(resLeaky.ep.breakdown.probability_clean_sheet);
    });

    // 10. Early-season shrinkage
    it("10. early-season shrinkage pulls small sample event rates toward position priors", () => {
      const p1 = mockPlayer({ id: 601, element_type: 4 }); // 1 match sample
      const p10 = mockPlayer({ id: 602, element_type: 4 }); // 10 match sample

      // Both observed xG/90 = 2.0 (an extreme outlier)
      const res1 = runPipeline(p1, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "2.00" },
      ]);
      const res10 = runPipeline(p10, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 3, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 4, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 5, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 6, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 7, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 8, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 9, minutes: 90, starts: 1, expected_goals: "2.00" },
        { round: 10, minutes: 90, starts: 1, expected_goals: "2.00" },
      ]);

      // p1 shrunk rate should be much closer to prior (0.38) than p10
      expect(res1.ep.breakdown.shrinkage_diagnostics.shrunk_xg_per90).toBeLessThan(res10.ep.breakdown.shrinkage_diagnostics.shrunk_xg_per90);
      expect(res1.ep.breakdown.shrinkage_diagnostics.shrunk_xg_per90).toBeLessThan(1.0); // shrunk down from 2.0
    });

    // 11. Rare event shrinkage
    it("11. rare event (red card in GW1) is strongly shrunk and does not explode deduction", () => {
      const pRed = mockPlayer({ id: 701, element_type: 3 });
      const { ep } = runPipeline(pRed, [
        { round: 1, minutes: 60, starts: 1, red_cards: 1 },
      ]);
      // deduction should be small fraction of a point, not -3.0
      expect(ep.breakdown.expected_red_card_deduction).toBeGreaterThan(-0.30);
    });

    // 12. Blank Gameweek (BGW = 0 EP)
    it("12. BGW produces 0 expected points and NOT_APPLICABLE validity", () => {
      const player = mockPlayer();
      const bgwFixtures = mockFixtures([]); // No fixtures in prediction GW
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1 },
        { round: 2, minutes: 90, starts: 1 },
      ], bgwFixtures);

      expect(ep.breakdown.fixture_count).toBe(0);
      expect(ep.expected_points_next_gameweek.value).toBeNull();
      expect(ep.expected_points_next_gameweek.validity).toBe(DataValidity.NOT_APPLICABLE);
      expect(ep.breakdown.expected_points_next_gameweek).toBe(0.0);
    });

    // 13. Double Gameweek (DGW additive EP)
    it("13. DGW calculates both fixtures independently and sums them additively", () => {
      const player = mockPlayer({ element_type: 4 });
      const dgwFixtures = mockFixtures([
        { id: 10, event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2 },
        { id: 11, event: 3, team_h: 1, team_a: 3, team_h_difficulty: 4 },
      ]);

      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.50" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.50" },
      ], dgwFixtures);

      expect(ep.breakdown.fixture_count).toBe(2);
      expect(ep.breakdown.fixtures.length).toBe(2);
      const sumOfFixtures = ep.breakdown.fixtures[0].fixture_expected_points + ep.breakdown.fixtures[1].fixture_expected_points;
      expect(Math.abs(ep.breakdown.expected_points_next_gameweek - sumOfFixtures)).toBeLessThan(0.05);
    });

    // 14. Negative deduction component
    it("14. card and goals conceded deductions are negative values", () => {
      const player = mockPlayer({ element_type: 2 });
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, yellow_cards: 1, goals_conceded: 2 },
        { round: 2, minutes: 90, starts: 1, yellow_cards: 1, goals_conceded: 2 },
      ]);
      expect(ep.breakdown.expected_yellow_card_deduction).toBeLessThan(0);
      expect(ep.breakdown.expected_goals_conceded_deduction).toBeLessThan(0);
    });

    // 15. EP not clamped to 0
    it("15. expected points identity preserves un-clamped mathematical sum", () => {
      const player = mockPlayer({ element_type: 2 });
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1 },
      ]);
      // The identity is an open algebraic sum
      const b = ep.breakdown.fixtures[0];
      const manualSum = b.expected_appearance_points +
        b.expected_goal_points +
        b.expected_assist_points +
        b.expected_clean_sheet_points +
        b.expected_save_points +
        b.expected_penalty_save_points +
        b.expected_defensive_contribution_points +
        b.expected_bonus_points +
        b.expected_goals_conceded_deduction +
        b.expected_penalty_miss_deduction +
        b.expected_yellow_card_deduction +
        b.expected_red_card_deduction +
        b.expected_own_goal_deduction;

      expect(Math.abs(b.fixture_expected_points - manualSum)).toBeLessThan(0.001);
    });

    // 16. Deterministic snapshot replay
    it("16. deterministic replay returns identical results across repeated executions", () => {
      const player = mockPlayer();
      const res1 = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.40" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.30" },
      ]);
      const res2 = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.40" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.30" },
      ]);

      expect(res1.ep.expected_points_next_gameweek.value).toBe(res2.ep.expected_points_next_gameweek.value);
      expect(res1.ep.breakdown.expected_goals).toBe(res2.ep.breakdown.expected_goals);
    });

    // 17. Route parity
    it("17. prediction output schema matches PredictionOutput contract", () => {
      const player = mockPlayer();
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1 },
      ]);
      const out = ep.prediction_output;
      expect(out.expected_points_next_gameweek.source).toBe(EXPECTED_POINTS_MODEL_VERSION);
      expect(out.expected_points_next_gameweek.validity).toBe(DataValidity.DERIVED);
      expect(out.prediction_confidence.source).toBe(EXPECTED_POINTS_MODEL_VERSION);
    });

    // 18. No in-progress GW leakage
    it("18. matches after cutoff gameweek are strictly excluded", () => {
      const player = mockPlayer();
      // Round 3 is in-progress or after cutoff 2
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, expected_goals: "0.50" },
        { round: 2, minutes: 90, starts: 1, goals_scored: 1, expected_goals: "0.50" },
        { round: 3, minutes: 90, starts: 1, goals_scored: 5, expected_goals: "4.00" }, // LEAK CANDIDATE
      ]);

      expect(ep.breakdown.shrinkage_diagnostics.sample_matches).toBe(2);
      expect(ep.breakdown.shrinkage_diagnostics.sample_minutes).toBe(180);
    });

    // 19. Legacy score invariance
    it("19. legacy Expert Score and Future FPL Score are not modified by expected points calculation", () => {
      const player = mockPlayer({ expert_score: 68.8, future_fpl_score: 71.8 });
      const { ep } = runPipeline(player, [
        { round: 1, minutes: 90, starts: 1 },
      ]);
      expect(player.expert_score).toBe(68.8);
      expect(player.future_fpl_score).toBe(71.8);
      expect(ep.prediction_output.expert_rank_score.value).toBe(68.8);
    });

    // 20. Expected Points independent from Expert Score changes
    it("20. Expected Points is completely invariant to artificial modifications of legacy Expert Score", () => {
      const p1 = mockPlayer({ id: 999, expert_score: 20.0, future_fpl_score: 15.0 });
      const p2 = mockPlayer({ id: 999, expert_score: 95.0, future_fpl_score: 98.0 });

      const res1 = runPipeline(p1, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.50" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.50" },
      ]);
      const res2 = runPipeline(p2, [
        { round: 1, minutes: 90, starts: 1, expected_goals: "0.50" },
        { round: 2, minutes: 90, starts: 1, expected_goals: "0.50" },
      ]);

      expect(res1.ep.expected_points_next_gameweek.value).toBe(res2.ep.expected_points_next_gameweek.value);
      expect(res1.ep.breakdown.expected_goals).toBe(res2.ep.breakdown.expected_goals);
      expect(res1.ep.breakdown.expected_bonus_points).toBe(res2.ep.breakdown.expected_bonus_points);
    });
  });
});
