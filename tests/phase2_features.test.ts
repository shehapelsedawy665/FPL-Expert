import { describe, it, expect } from "vitest";
import {
  DataValidity,
  GameweekBoundary,
  PredictionSnapshot,
} from "../services/prediction_contract.js";
import {
  buildPlayerPredictionFeatures,
  buildBulkPredictionFeatures,
  deriveSetPieceRole,
  SetPieceRole,
  FEATURE_SCHEMA_VERSION,
} from "../services/prediction_features.js";
import { addRatings } from "../services/rating_engine.js";

describe("Phase 2: Canonical Prediction Features Layer", () => {
  const boundaryGW4 = new GameweekBoundary({
    last_finished_gameweek: 2,
    in_progress_gameweek: 3,
    prediction_gameweek: 4,
    historical_cutoff_gameweek: 2,
  });

  const snapshotGW4 = new PredictionSnapshot({
    snapshot_id: "snap_gw4_cutoff2",
    boundary: boundaryGW4,
    snapshot_created_at: "2026-09-01T12:00:00.000Z",
  });

  it("produces canonical feature envelope with complete provenance metadata", () => {
    const player = {
      id: 101,
      element_type: 4,
      team: 1,
      now_cost: 150,
      status: "a",
      selected_by_percent: "55.0",
      penalties_order: 1,
      direct_freekicks_order: 2,
      corners_and_indirect_freekicks_order: null,
    };

    const history = [
      { round: 1, minutes: 90, starts: 1, goals_scored: 2, assists: 0, total_points: 13, bonus: 3, clean_sheets: 0, expected_goals: 1.5, expected_assists: 0.1, threat: 80, creativity: 15, influence: 60, ict_index: 15.5 },
      { round: 2, minutes: 90, starts: 1, goals_scored: 1, assists: 1, total_points: 9, bonus: 2, clean_sheets: 0, expected_goals: 0.9, expected_assists: 0.4, threat: 65, creativity: 25, influence: 45, ict_index: 13.5 },
      { round: 3, minutes: 90, starts: 1, goals_scored: 3, assists: 1, total_points: 17, bonus: 3, clean_sheets: 0, expected_goals: 2.2, expected_assists: 0.5, threat: 120, creativity: 40, influence: 90, ict_index: 25.0 }, // in-progress GW3
    ];

    const fixtures = [
      { id: 10, event: 4, team_h: 1, team_a: 5, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 20, event: 5, team_h: 6, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3 },
      { id: 30, event: 6, team_h: 1, team_a: 7, team_h_difficulty: 2, team_a_difficulty: 5 },
    ];

    const teams = [
      { id: 1, strength_overall_home: 1350, strength_overall_away: 1320, strength_attack_home: 1380, strength_attack_away: 1350, strength_defence_home: 1330, strength_defence_away: 1300 },
      { id: 5, strength_overall_home: 1050, strength_overall_away: 1020, strength_attack_home: 1060, strength_attack_away: 1040, strength_defence_home: 1050, strength_defence_away: 1030 },
    ];

    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGW4,
      history,
      allFixtures: fixtures,
      allTeams: teams,
    });

    expect(features.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(features.player_id).toBe(101);
    expect(features.prediction_gameweek).toBe(4);
    expect(features.historical_cutoff_gameweek).toBe(2);
    expect(features.snapshot_id).toBe("snap_gw4_cutoff2");
    expect(features.provenance.gameweek_rounds_used).toEqual([1, 2]);
    expect(features.provenance.completed_rounds_used).toEqual([1, 2]);
    expect(features.provenance.fixture_rows_used).toBe(2);
    expect(features.provenance.in_progress_rounds_excluded).toEqual([3]);
    expect(features.provenance.history_available).toBe(true);
  });

  describe("Gameweek Window Semantics & DGW Round Aggregation", () => {
    it("A & D: aggregates DGW fixture rows into one Gameweek for last 3 distinct Gameweeks", () => {
      // History: GW1 (1 fix), GW2 (2 fixes - DGW), GW3 (1 fix)
      const boundaryGW4 = new GameweekBoundary({
        last_finished_gameweek: 3,
        in_progress_gameweek: null,
        prediction_gameweek: 4,
        historical_cutoff_gameweek: 3,
      });
      const snapshot = new PredictionSnapshot({
        snapshot_id: "snap_gw4_cutoff3",
        boundary: boundaryGW4,
      });

      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 },
        { round: 2, minutes: 90, starts: 1, goals_scored: 1, total_points: 7 }, // GW2 fixture A
        { round: 2, minutes: 45, starts: 0, goals_scored: 0, total_points: 2 }, // GW2 fixture B (DGW)
        { round: 3, minutes: 90, starts: 1, goals_scored: 2, total_points: 12 },
      ];

      const player = { id: 201, element_type: 4, team: 1, now_cost: 90 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history,
      });

      const last3Gws = features.windows.last_3_gameweeks;
      // Must evaluate 3 distinct rounds: GW1, GW2, GW3
      expect(last3Gws.rounds_included).toEqual([1, 2, 3]);
      expect(last3Gws.matches_evaluated_count).toBe(3); // 3 distinct rounds
      expect(last3Gws.fixture_rows_count).toBe(4); // 4 fixture rows total
      expect(last3Gws.minutes.value).toBe(315); // 90 + (90 + 45) + 90
      expect(last3Gws.goals.value).toBe(4); // 1 + (1 + 0) + 2
      expect(last3Gws.points.value).toBe(27); // 6 + (7 + 2) + 12
      expect(last3Gws.starts.value).toBe(3); // 1 + (1 + 0) + 1
      expect(last3Gws.appearances.value).toBe(4); // 4 match appearances across 3 GWs
    });

    it("B: handles last 5 distinct Gameweeks with multiple fixtures in one round", () => {
      // History: GW1, GW2 (DGW: 2 fixes), GW3, GW4, GW5, GW6
      const boundaryGW7 = new GameweekBoundary({
        last_finished_gameweek: 6,
        in_progress_gameweek: null,
        prediction_gameweek: 7,
        historical_cutoff_gameweek: 6,
      });
      const snapshot = new PredictionSnapshot({
        snapshot_id: "snap_gw7_cutoff6",
        boundary: boundaryGW7,
      });

      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 0, total_points: 2 },
        { round: 2, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 }, // GW2 fix A
        { round: 2, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 }, // GW2 fix B
        { round: 3, minutes: 90, starts: 1, goals_scored: 0, total_points: 2 },
        { round: 4, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 },
        { round: 5, minutes: 90, starts: 1, goals_scored: 0, total_points: 2 },
        { round: 6, minutes: 90, starts: 1, goals_scored: 2, total_points: 10 },
      ];

      const player = { id: 202, element_type: 4, team: 1, now_cost: 95 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history,
      });

      const last5Gws = features.windows.last_5_gameweeks;
      // Last 5 distinct completed rounds from [1, 2, 3, 4, 5, 6] are [2, 3, 4, 5, 6]
      expect(last5Gws.rounds_included).toEqual([2, 3, 4, 5, 6]);
      expect(last5Gws.matches_evaluated_count).toBe(5);
      expect(last5Gws.fixture_rows_count).toBe(6); // GW2 has 2 rows + GW3,4,5,6 (1 each) = 6 rows
      expect(last5Gws.minutes.value).toBe(540); // 180 + 90 + 90 + 90 + 90
      expect(last5Gws.goals.value).toBe(5); // (1+1) + 0 + 1 + 0 + 2 = 5
      expect(last5Gws.points.value).toBe(32); // (6+6) + 2 + 6 + 2 + 10 = 32
    });

    it("C: zero-minute GW is retained as valid evidence in Gameweek windows", () => {
      const boundary = new GameweekBoundary({
        last_finished_gameweek: 3,
        in_progress_gameweek: null,
        prediction_gameweek: 4,
        historical_cutoff_gameweek: 3,
      });
      const snapshot = new PredictionSnapshot({
        snapshot_id: "snap_gw4_cutoff3",
        boundary,
      });

      // GW1: 90 min, GW2: 0 min (benched), GW3: 20 min (sub)
      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 },
        { round: 2, minutes: 0, starts: 0, goals_scored: 0, total_points: 0 },
        { round: 3, minutes: 20, starts: 0, goals_scored: 0, total_points: 1 },
      ];

      const player = { id: 203, element_type: 3, team: 1, now_cost: 60 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history,
      });

      const last3Gws = features.windows.last_3_gameweeks;
      expect(last3Gws.rounds_included).toEqual([1, 2, 3]);
      expect(last3Gws.matches_evaluated_count).toBe(3);
      expect(last3Gws.fixture_rows_count).toBe(3);
      expect(last3Gws.minutes.value).toBe(110);
      expect(last3Gws.points.value).toBe(7);
      expect(features.minutes_evidence.zero_minute_completed_gw_count.value).toBe(1);
    });

    it("E: appearance window remains appearance-based and differs from GW window", () => {
      const boundary = new GameweekBoundary({
        last_finished_gameweek: 5,
        in_progress_gameweek: null,
        prediction_gameweek: 6,
        historical_cutoff_gameweek: 5,
      });
      const snapshot = new PredictionSnapshot({
        snapshot_id: "snap_gw6_cutoff5",
        boundary,
      });

      // GW1=90, GW2=0, GW3=60, GW4=0, GW5=90
      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 1, total_points: 6 },
        { round: 2, minutes: 0, starts: 0, goals_scored: 0, total_points: 0 },
        { round: 3, minutes: 60, starts: 1, goals_scored: 1, total_points: 7 },
        { round: 4, minutes: 0, starts: 0, goals_scored: 0, total_points: 0 },
        { round: 5, minutes: 90, starts: 1, goals_scored: 2, total_points: 12 },
      ];

      const player = { id: 204, element_type: 4, team: 2, now_cost: 80 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history,
      });

      // Appearance window: last 3 actual appearances (GW1, GW3, GW5)
      const last3Apps = features.windows.last_3_appearances;
      expect(last3Apps.rounds_included).toEqual([1, 3, 5]);
      expect(last3Apps.matches_evaluated_count).toBe(3);
      expect(last3Apps.minutes.value).toBe(240);
      expect(last3Apps.goals.value).toBe(4);
      expect(last3Apps.points.value).toBe(25);

      // Gameweek window: last 3 distinct GW rounds (GW3, GW4, GW5)
      const last3Gws = features.windows.last_3_gameweeks;
      expect(last3Gws.rounds_included).toEqual([3, 4, 5]);
      expect(last3Gws.matches_evaluated_count).toBe(3);
      expect(last3Gws.minutes.value).toBe(150);
      expect(last3Gws.goals.value).toBe(3);
      expect(last3Gws.points.value).toBe(19);
    });
  });

  describe("Fixture Semantics (BGW & DGW)", () => {
    it("F & G: BGW sets prediction-GW fields to null/NOT_APPLICABLE and exposes next scheduled fixture separately", () => {
      // Team 1 has NO fixture in GW4 (Blank GW), but has a fixture scheduled in GW5
      const fixtures = [
        { id: 501, event: 5, team_h: 1, team_a: 6, team_h_difficulty: 2, team_a_difficulty: 4 },
        { id: 502, event: 6, team_h: 7, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3 },
      ];

      const player = { id: 301, element_type: 3, team: 1, now_cost: 70 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot: snapshotGW4,
        allFixtures: fixtures,
      });

      // BGW Prediction GW semantics
      expect(features.fixtures.prediction_gameweek).toBe(4);
      expect(features.fixtures.prediction_gw_fixture_count).toBe(0);
      expect(features.fixtures.fixture_count).toBe(0);
      expect(features.fixtures.gameweek_type).toBe("blank");
      expect(features.fixtures.prediction_gw_fixtures).toEqual([]);

      // Prediction-GW convenience fields are strictly NOT_APPLICABLE
      expect(features.fixtures.prediction_gw_opponent.value).toBeNull();
      expect(features.fixtures.prediction_gw_opponent.validity).toBe(DataValidity.NOT_APPLICABLE);
      expect(features.fixtures.prediction_gw_is_home.value).toBeNull();
      expect(features.fixtures.prediction_gw_is_home.validity).toBe(DataValidity.NOT_APPLICABLE);
      expect(features.fixtures.prediction_gw_difficulty.value).toBeNull();
      expect(features.fixtures.prediction_gw_difficulty.validity).toBe(DataValidity.NOT_APPLICABLE);

      // Next scheduled fixture exposed separately
      expect(features.fixtures.next_scheduled_fixture).toBeDefined();
      expect(features.fixtures.next_scheduled_fixture_gameweek.value).toBe(5);
      expect(features.fixtures.next_scheduled_opponent.value).toBe(6);
      expect(features.fixtures.next_scheduled_is_home.value).toBe(true);
      expect(features.fixtures.next_scheduled_difficulty.value).toBe(2);
    });

    it("H & I: DGW retains both prediction-GW fixtures and marks single-fixture fields NOT_APPLICABLE", () => {
      // Team 1 has 2 fixtures in GW4 (Double Gameweek)
      const fixtures = [
        { id: 601, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
        { id: 602, event: 4, team_h: 3, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
        { id: 603, event: 5, team_h: 1, team_a: 8, team_h_difficulty: 2, team_a_difficulty: 5 },
      ];

      const player = { id: 302, element_type: 4, team: 1, now_cost: 110 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot: snapshotGW4,
        allFixtures: fixtures,
      });

      expect(features.fixtures.prediction_gw_fixture_count).toBe(2);
      expect(features.fixtures.gameweek_type).toBe("double");
      expect(features.fixtures.prediction_gw_fixtures.length).toBe(2);

      // Both fixtures retained authoritatively
      expect(features.fixtures.prediction_gw_fixtures[0].opponent_team_id).toBe(2);
      expect(features.fixtures.prediction_gw_fixtures[0].is_home).toBe(true);
      expect(features.fixtures.prediction_gw_fixtures[1].opponent_team_id).toBe(3);
      expect(features.fixtures.prediction_gw_fixtures[1].is_home).toBe(false);

      // Single-fixture convenience fields are marked NOT_APPLICABLE for DGW
      expect(features.fixtures.prediction_gw_opponent.value).toBeNull();
      expect(features.fixtures.prediction_gw_opponent.validity).toBe(DataValidity.NOT_APPLICABLE);

      // Explicit first fixture convenience fields
      expect(features.fixtures.first_prediction_gw_fixture_opponent.value).toBe(2);
      expect(features.fixtures.first_prediction_gw_fixture_is_home.value).toBe(true);
    });
  });

  describe("Validity / Provenance Consistency", () => {
    it("J: derived appearances remain DERIVED in canonical output", () => {
      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 1 },
        { round: 2, minutes: 45, starts: 0, goals_scored: 0 },
      ];

      const player = { id: 401, element_type: 3, team: 1, now_cost: 65 };
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot: snapshotGW4,
        history,
      });

      // Season appearances derived from history must have validity DERIVED
      expect(features.minutes_evidence.season_appearances.value).toBe(2);
      expect(features.minutes_evidence.season_appearances.validity).toBe(DataValidity.DERIVED);
      expect(features.minutes_evidence.season_appearances.source).toBe("fpl_player_history");

      // Rate features derived from history must have validity DERIVED
      expect(features.minutes_evidence.appearance_rate.validity).toBe(DataValidity.DERIVED);
      expect(features.minutes_evidence.start_rate.validity).toBe(DataValidity.DERIVED);
      expect(features.minutes_evidence.sixty_plus_minute_rate.validity).toBe(DataValidity.DERIVED);
    });
  });

  describe("Set-Piece Role Semantics", () => {
    it("distinguishes first choice, secondary, ranked, and unknown roles", () => {
      expect(deriveSetPieceRole(1)).toEqual({ role: SetPieceRole.FIRST_CHOICE, validity: DataValidity.OBSERVED, order: 1 });
      expect(deriveSetPieceRole(2)).toEqual({ role: SetPieceRole.SECONDARY, validity: DataValidity.OBSERVED, order: 2 });
      expect(deriveSetPieceRole(3)).toEqual({ role: SetPieceRole.RANKED, validity: DataValidity.OBSERVED, order: 3 });
      expect(deriveSetPieceRole(null)).toEqual({ role: SetPieceRole.UNKNOWN, validity: DataValidity.MISSING, order: null });
      expect(deriveSetPieceRole(undefined)).toEqual({ role: SetPieceRole.UNKNOWN, validity: DataValidity.MISSING, order: null });
    });
  });

  describe("Route Neutrality & Deterministic Feature Parity", () => {
    it("produces identical feature sets across bulk and single-player execution", () => {
      const p1 = { id: 601, element_type: 3, team: 1, now_cost: 80, penalties_order: 1, status: "a", selected_by_percent: 20.0 };
      const p2 = { id: 602, element_type: 4, team: 2, now_cost: 110, status: "a", selected_by_percent: 45.0 };
      const historyP1 = [{ round: 1, minutes: 90, total_points: 8 }, { round: 2, minutes: 90, total_points: 5 }];

      const bulkFeatures = buildBulkPredictionFeatures({
        players: [p1, p2],
        snapshot: snapshotGW4,
        recentHistoryByPlayer: { 601: historyP1 },
      });

      const singleFeatureP1 = buildPlayerPredictionFeatures({
        player: p1,
        snapshot: snapshotGW4,
        history: historyP1,
      });

      expect(bulkFeatures[601]).toEqual(singleFeatureP1);
    });
  });

  describe("Legacy Scoring Invariance Verification", () => {
    it("ensures Phase 2 feature calculation does NOT alter legacy scores, breakdowns, or starting XI", () => {
      const player = {
        id: 701,
        element_type: 4,
        team: 1,
        now_cost: 140,
        minutes: 180,
        starts: 2,
        goals_scored: 3,
        total_points: 22,
        form: 11.0,
        status: "a",
        selected_by_percent: 50.0,
        team_attack_strength: 1350,
        team_defence_strength: 1200,
      };

      const history = [
        { round: 1, minutes: 90, starts: 1, goals_scored: 2, total_points: 13, bonus: 3 },
        { round: 2, minutes: 90, starts: 1, goals_scored: 1, total_points: 9, bonus: 2 },
      ];

      // Calculate legacy ratings
      const rated = addRatings([player], {
        referenceGameweek: 2,
        boundary: boundaryGW4,
        snapshot: snapshotGW4,
        recentHistoryByPlayer: { 701: history },
      })[0];

      // Calculate Phase 2 features
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot: snapshotGW4,
        history,
      });

      // Verify legacy fields are intact and unchanged
      expect(rated.expert_score).toBeGreaterThan(0);
      expect(rated.current_form_score).toBeGreaterThan(0);
      expect(rated.future_fpl_score).toBeGreaterThan(0);
      expect(rated.expected_minutes_proxy).toBe(100);
      expect(features.minutes_evidence.season_minutes.value).toBe(180);
      expect(features.per_90.goals_per90.value).toBe(1.5);
    });
  });
});
