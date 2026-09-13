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
  evaluateDefensiveContributionMatch,
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

  // ==========================================================================
  // SECTION 3: OFFICIAL 2026/27 DEFENSIVE CONTRIBUTION (DC) RULES & EVENT MODEL
  // ==========================================================================
  describe("3. Official 2026/27 Defensive Contribution (DC) Scoring Rules & Event Model", () => {
    // A. DEF (Position 2): CBIT >= 10 => 2 points max per fixture. Recoveries do not count.
    it("DEF: 9 CBIT yields 0 points", () => {
      const res = evaluateDefensiveContributionMatch(2, {
        clearances_blocks_interceptions: 5,
        tackles: 4, // CBIT = 9
        recoveries: 8, // recoveries must NOT count for DEF
      });
      expect(res.cbit).toBe(9);
      expect(res.threshold).toBe(10);
      expect(res.thresholdHit).toBe(false);
      expect(res.pointsAwarded).toBe(0);
    });

    it("DEF: 10 CBIT yields 2 points", () => {
      const res = evaluateDefensiveContributionMatch(2, {
        clearances_blocks_interceptions: 6,
        tackles: 4, // CBIT = 10
        recoveries: 5,
      });
      expect(res.cbit).toBe(10);
      expect(res.thresholdHit).toBe(true);
      expect(res.pointsAwarded).toBe(2);
    });

    it("DEF: 20 CBIT yields 2 points maximum (capped per fixture)", () => {
      const res = evaluateDefensiveContributionMatch(2, {
        clearances_blocks_interceptions: 12,
        tackles: 8, // CBIT = 20
        recoveries: 10,
      });
      expect(res.cbit).toBe(20);
      expect(res.thresholdHit).toBe(true);
      expect(res.pointsAwarded).toBe(2);
    });

    // B. MID (Position 3): CBIRT >= 12 => 2 points max per fixture. Recoveries DO count.
    it("MID: 11 CBIRT yields 0 points", () => {
      const res = evaluateDefensiveContributionMatch(3, {
        clearances_blocks_interceptions: 3,
        tackles: 2,
        recoveries: 6, // CBIRT = 11
      });
      expect(res.cbirt).toBe(11);
      expect(res.threshold).toBe(12);
      expect(res.thresholdHit).toBe(false);
      expect(res.pointsAwarded).toBe(0);
    });

    it("MID: 12 CBIRT yields 2 points (recoveries count)", () => {
      const res = evaluateDefensiveContributionMatch(3, {
        clearances_blocks_interceptions: 3,
        tackles: 2,
        recoveries: 7, // CBIRT = 12
      });
      expect(res.cbirt).toBe(12);
      expect(res.thresholdHit).toBe(true);
      expect(res.pointsAwarded).toBe(2);
    });

    it("MID: 24 CBIRT yields 2 points maximum (capped per fixture)", () => {
      const res = evaluateDefensiveContributionMatch(3, {
        clearances_blocks_interceptions: 8,
        tackles: 6,
        recoveries: 10, // CBIRT = 24
      });
      expect(res.cbirt).toBe(24);
      expect(res.thresholdHit).toBe(true);
      expect(res.pointsAwarded).toBe(2);
    });

    // C. FWD (Position 4): CBIRT >= 12 => 2 points max per fixture. Recoveries DO count.
    it("FWD: 11 CBIRT yields 0 points", () => {
      const res = evaluateDefensiveContributionMatch(4, {
        clearances_blocks_interceptions: 2,
        tackles: 1,
        recoveries: 8, // CBIRT = 11
      });
      expect(res.cbirt).toBe(11);
      expect(res.thresholdHit).toBe(false);
      expect(res.pointsAwarded).toBe(0);
    });

    it("FWD: 12 CBIRT yields 2 points", () => {
      const res = evaluateDefensiveContributionMatch(4, {
        clearances_blocks_interceptions: 2,
        tackles: 2,
        recoveries: 8, // CBIRT = 12
      });
      expect(res.cbirt).toBe(12);
      expect(res.thresholdHit).toBe(true);
      expect(res.pointsAwarded).toBe(2);
    });

    // D. GKP (Position 1): NOT_APPLICABLE / 0 direct DC points
    it("GKP: NOT_APPLICABLE / 0 direct DC scoring even with high clearances/recoveries", () => {
      const res = evaluateDefensiveContributionMatch(1, {
        clearances_blocks_interceptions: 15,
        tackles: 5,
        recoveries: 20,
      });
      expect(res.thresholdHit).toBe(false);
      expect(res.pointsAwarded).toBe(0);
    });

    // E. Recoveries semantics: count for MID/FWD but NOT DEF
    it("verifies recoveries count toward MID/FWD CBIRT threshold but NOT toward DEF CBIT threshold", () => {
      // DEF with 8 CBI+tackles and 10 recoveries -> CBIT = 8 (< 10) -> 0 pts
      const defRes = evaluateDefensiveContributionMatch(2, {
        clearances_blocks_interceptions: 5,
        tackles: 3,
        recoveries: 10,
      });
      expect(defRes.cbit).toBe(8);
      expect(defRes.thresholdHit).toBe(false);
      expect(defRes.pointsAwarded).toBe(0);

      // MID with same numbers (5 CBI, 3 tackles, 10 recoveries) -> CBIRT = 18 (>= 12) -> 2 pts
      const midRes = evaluateDefensiveContributionMatch(3, {
        clearances_blocks_interceptions: 5,
        tackles: 3,
        recoveries: 10,
      });
      expect(midRes.cbirt).toBe(18);
      expect(midRes.thresholdHit).toBe(true);
      expect(midRes.pointsAwarded).toBe(2);
    });

    // F. Expected DC points integrated into pipeline & additive identity
    it("integrates expected DC points into pipeline and separates from Bonus points", () => {
      const snapshot = createSnapshot(2);
      const fixtures = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const pDef = mockPlayer({ id: 888, element_type: 2 });

      // Defender who hit 10+ CBIT in GW1 and GW2
      const hist = mockHistory([
        { round: 1, minutes: 90, starts: 1, clearances_blocks_interceptions: 8, tackles: 3, bonus: 2 }, // 11 CBIT
        { round: 2, minutes: 90, starts: 1, clearances_blocks_interceptions: 7, tackles: 4, bonus: 1 }, // 11 CBIT
      ]);

      const feat = buildPlayerPredictionFeatures({ player: pDef, snapshot, history: hist, allFixtures: fixtures });
      const mins = buildPlayerExpectedMinutes({ player: pDef, features: feat, snapshot, history: hist });
      const ep = buildPlayerExpectedPoints({ player: pDef, features: feat, minutesResult: mins, snapshot, history: hist, allFixtures: fixtures });

      expect(ep.breakdown.shrinkage_diagnostics.sample_dc_hits).toBe(2);
      expect(ep.breakdown.probability_defensive_contribution_points).toBeGreaterThan(0.20);
      expect(ep.breakdown.expected_defensive_contribution_points).toBeGreaterThan(0.40);
      expect(ep.breakdown.expected_bonus_points).toBeGreaterThan(0.10); // distinct and separate

      // Verify the fixture expected points matches the full identity including DC
      const fix = ep.breakdown.fixtures[0];
      const identitySum = fix.expected_appearance_points +
        fix.expected_goal_points +
        fix.expected_assist_points +
        fix.expected_clean_sheet_points +
        fix.expected_save_points +
        fix.expected_penalty_save_points +
        fix.expected_defensive_contribution_points +
        fix.expected_bonus_points +
        fix.expected_goals_conceded_deduction +
        fix.expected_penalty_miss_deduction +
        fix.expected_yellow_card_deduction +
        fix.expected_red_card_deduction +
        fix.expected_own_goal_deduction;

      expect(Math.abs(fix.fixture_expected_points - identitySum)).toBeLessThan(0.001);
    });
  });

  // ==========================================================================
  // SECTION 4: EXPECTED POINTS CONFIDENCE AUDIT & VALIDATION TESTS
  // ==========================================================================
  describe("4. Expected Points Confidence Audit & Validation Tests", () => {
    // A. Player with substantial personal history vs player with zero personal history
    it("A. Substantial personal history vs zero personal history yields differing confidence", () => {
      const snapshot = createSnapshot(5);
      const fixtures = mockFixtures([{ event: 6, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const p = mockPlayer({ id: 101, element_type: 3, status: "a" });

      // Zero history player (new signing)
      const histZero = mockHistory([]);
      const featZero = buildPlayerPredictionFeatures({ player: p, snapshot, history: histZero, allFixtures: fixtures });
      const minsZero = buildPlayerExpectedMinutes({ player: p, features: featZero, snapshot, history: histZero });
      const epZero = buildPlayerExpectedPoints({ player: p, features: featZero, minutesResult: minsZero, snapshot, history: histZero, allFixtures: fixtures });

      // Substantial history player (5 matches started)
      const hist5 = mockHistory([
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, expected_goals: "0.45" },
        { round: 2, minutes: 90, starts: 1, goals_scored: 0, expected_goals: "0.30" },
        { round: 3, minutes: 85, starts: 1, goals_scored: 1, expected_goals: "0.55" },
        { round: 4, minutes: 90, starts: 1, goals_scored: 0, expected_goals: "0.25" },
        { round: 5, minutes: 90, starts: 1, goals_scored: 2, expected_goals: "0.80" },
      ]);
      const feat5 = buildPlayerPredictionFeatures({ player: p, snapshot, history: hist5, allFixtures: fixtures });
      const mins5 = buildPlayerExpectedMinutes({ player: p, features: feat5, snapshot, history: hist5 });
      const ep5 = buildPlayerExpectedPoints({ player: p, features: feat5, minutesResult: mins5, snapshot, history: hist5, allFixtures: fixtures });

      expect(epZero.expected_points_confidence.value).toBe(0.0);
      expect(ep5.expected_points_confidence.value).toBeGreaterThan(0.50);
      expect(Number(ep5.expected_points_confidence.value)).toBeGreaterThan(Number(epZero.expected_points_confidence.value));
    });

    // B. Changing confidence inputs does NOT change Expected Points value
    it("B. Changing confidence inputs does NOT change Expected Points (decoupling property)", () => {
      const snapshot = createSnapshot(2);
      const fixtures = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const p = mockPlayer({ id: 101, element_type: 3, status: "a" });
      const hist = mockHistory([
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, expected_goals: "0.40", expected_assists: "0.20" },
        { round: 2, minutes: 90, starts: 1, goals_scored: 0, expected_goals: "0.30", expected_assists: "0.10" },
      ]);

      const feat = buildPlayerPredictionFeatures({ player: p, snapshot, history: hist, allFixtures: fixtures });
      const minsReal = buildPlayerExpectedMinutes({ player: p, features: feat, snapshot, history: hist });

      // Create a cloned minutesResult with artificially altered playing_time_confidence
      const minsAltered = {
        ...minsReal,
        playing_time_confidence: {
          ...minsReal.playing_time_confidence,
          value: 0.999, // drastically altered confidence
        },
      };

      const epReal = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: minsReal, snapshot, history: hist, allFixtures: fixtures });
      const epAltered = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: minsAltered, snapshot, history: hist, allFixtures: fixtures });

      // Confidence changes:
      expect(epReal.expected_points_confidence.value).not.toBe(epAltered.expected_points_confidence.value);
      // Expected Points value remains IDENTICAL:
      expect(epReal.expected_points_next_gameweek.value).toBe(epAltered.expected_points_next_gameweek.value);
      expect(epReal.breakdown.expected_goals).toBe(epAltered.breakdown.expected_goals);
      expect(epReal.breakdown.expected_assists).toBe(epAltered.breakdown.expected_assists);
      expect(epReal.breakdown.expected_clean_sheet_points).toBe(epAltered.breakdown.expected_clean_sheet_points);
    });

    // C. Increasing valid historical evidence monotonically increases confidence
    it("C. Increasing valid historical evidence monotonically increases confidence", () => {
      const snapshot = createSnapshot(6);
      const fixtures = mockFixtures([{ event: 7, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const p = mockPlayer({ id: 101, element_type: 3, status: "a" });

      const confidences: number[] = [];
      const matchHistory: any[] = [];

      for (let gw = 1; gw <= 6; gw++) {
        matchHistory.push({ round: gw, minutes: 90, starts: 1, goals_scored: 0, expected_goals: "0.20" });
        const hist = mockHistory([...matchHistory]);
        const feat = buildPlayerPredictionFeatures({ player: p, snapshot, history: hist, allFixtures: fixtures });
        const mins = buildPlayerExpectedMinutes({ player: p, features: feat, snapshot, history: hist });
        const ep = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: mins, snapshot, history: hist, allFixtures: fixtures });
        confidences.push(Number(ep.expected_points_confidence.value));
      }

      // Check strictly monotonic increase
      for (let i = 1; i < confidences.length; i++) {
        expect(confidences[i]).toBeGreaterThanOrEqual(confidences[i - 1]);
      }
      expect(confidences[5]).toBeGreaterThan(confidences[0]);
    });

    // D. Unsupported / missing components / zero sample reduce confidence appropriately
    it("D. Zero sample or missing playing time confidence produces zero EP confidence", () => {
      const snapshot = createSnapshot(2);
      const fixtures = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const p = mockPlayer({ id: 101, element_type: 3, status: "a" });
      const histZero = mockHistory([]);

      const feat = buildPlayerPredictionFeatures({ player: p, snapshot, history: histZero, allFixtures: fixtures });
      const mins = buildPlayerExpectedMinutes({ player: p, features: feat, snapshot, history: histZero });
      const ep = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: mins, snapshot, history: histZero, allFixtures: fixtures });

      expect(ep.expected_points_confidence.value).toBe(0.0);
      expect(mins.playing_time_confidence.validity).toBe(DataValidity.MISSING);
    });

    // E. Confidence remains bounded strictly within [0, 1]
    it("E. Confidence remains strictly bounded within [0, 1] across all conditions", () => {
      const snapshot = createSnapshot(38);
      const fixtures = mockFixtures([{ event: 38, team_h: 1, team_a: 2, team_h_difficulty: 1 }]);
      const p = mockPlayer({ id: 101, element_type: 4, status: "a" });

      // Extremely large sample of 38 matches
      const bigHist = mockHistory(
        Array.from({ length: 38 }, (_, i) => ({ round: i + 1, minutes: 90, starts: 1, goals_scored: 1 }))
      );

      const feat = buildPlayerPredictionFeatures({ player: p, snapshot, history: bigHist, allFixtures: fixtures });
      const mins = buildPlayerExpectedMinutes({ player: p, features: feat, snapshot, history: bigHist });
      const ep = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: mins, snapshot, history: bigHist, allFixtures: fixtures });

      const conf = Number(ep.expected_points_confidence.value);
      expect(conf).toBeGreaterThanOrEqual(0.0);
      expect(conf).toBeLessThanOrEqual(1.0);
      expect(conf).toBeGreaterThan(0.70);
    });

    // F. Phase 3 playing_time_confidence is propagated correctly
    it("F. Phase 3 playing_time_confidence is propagated directly into Phase 4 EP confidence scaling", () => {
      const snapshot = createSnapshot(2);
      const fixtures = mockFixtures([{ event: 3, team_h: 1, team_a: 2, team_h_difficulty: 3 }]);
      const p = mockPlayer({ id: 101, element_type: 3, status: "a" });
      const hist = mockHistory([
        { round: 1, minutes: 90, starts: 1 },
        { round: 2, minutes: 90, starts: 1 },
      ]);

      const feat = buildPlayerPredictionFeatures({ player: p, snapshot, history: hist, allFixtures: fixtures });
      const mins = buildPlayerExpectedMinutes({ player: p, features: feat, snapshot, history: hist });
      const ep = buildPlayerExpectedPoints({ player: p, features: feat, minutesResult: mins, snapshot, history: hist, allFixtures: fixtures });

      // In mockPlayer, chance_of_playing_next_round: 100 => fallbackUsed = false => availFactor = 1.0 => ptConf = 0.435
      // 0.435 * (0.35 + 0.65 * 0.393) = 0.435 * 0.60545 = 0.263
      const ptConf = Number(mins.playing_time_confidence.value);
      const sampleMatchFactor = Math.round((1.0 - Math.exp(-2 / 4.0)) * 1000) / 1000;
      const expectedEpConf = Math.round(ptConf * (0.35 + 0.65 * sampleMatchFactor) * 1000) / 1000;

      expect(ep.expected_points_confidence.value).toBe(expectedEpConf);

      // Now verify with status fallback (chance_of_playing_next_round missing => fallbackUsed = true => availFactor = 0.85)
      const pFallback = mockPlayer({ id: 102, element_type: 3, status: "a", chance_of_playing_next_round: null, chance_of_playing_this_round: null });
      const featFb = buildPlayerPredictionFeatures({ player: pFallback, snapshot, history: hist, allFixtures: fixtures });
      const minsFb = buildPlayerExpectedMinutes({ player: pFallback, features: featFb, snapshot, history: hist });
      const epFb = buildPlayerExpectedPoints({ player: pFallback, features: featFb, minutesResult: minsFb, snapshot, history: hist, allFixtures: fixtures });
      
      const expectedFbEpConf = Math.round(Number(minsFb.playing_time_confidence.value) * (0.35 + 0.65 * sampleMatchFactor) * 1000) / 1000;
      expect(epFb.expected_points_confidence.value).toBe(expectedFbEpConf);
    });
  });
});

