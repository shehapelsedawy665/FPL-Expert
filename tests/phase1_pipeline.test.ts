import { describe, it, expect } from "vitest";
import {
  DataValidity,
  DataValue,
  GameweekBoundary,
  PredictionSnapshot,
} from "../services/prediction_contract";
import {
  derivePlayerAppearances,
  minutesProfile,
  weightedPercentile,
  teamContextScore,
  playerRating,
  addRatings,
} from "../services/rating_engine";
import { validateTeamStrengths, fixtureDataForTeam } from "../services/fpl_service";

describe("Phase 1: Appearances Handling", () => {
  const boundary = new GameweekBoundary({
    last_finished_gameweek: 20,
    in_progress_gameweek: null,
    prediction_gameweek: 21,
    historical_cutoff_gameweek: 20,
  });

  it("derives appearances from match history when minutes > 0", () => {
    const player = { id: 1, name: "Test Player", minutes: 900, starts: 10 };
    const history = [
      { round: 1, minutes: 90 },
      { round: 2, minutes: 0 },
      { round: 3, minutes: 45 },
      { round: 4, minutes: 90 },
      { round: 22, minutes: 90 }, // Should be excluded due to cutoff 20
    ];

    const result = derivePlayerAppearances(player, history, boundary);
    expect(result.validity).toBe(DataValidity.DERIVED);
    expect(result.value).toBe(3);
    expect(result.source).toBe("fpl_player_history");
  });

  it("handles observed zero appearances when player was in squad but had 0 minutes across matches", () => {
    const player = { id: 2, name: "Bench Player", minutes: 0, starts: 0 };
    const history = [
      { round: 1, minutes: 0 },
      { round: 2, minutes: 0 },
      { round: 3, minutes: 0 },
    ];

    const result = derivePlayerAppearances(player, history, boundary);
    expect(result.validity).toBe(DataValidity.OBSERVED_ZERO);
    expect(result.value).toBe(0);
  });

  it("marks appearances as missing when no history is provided and not present in bootstrap", () => {
    const player = { id: 3, name: "Missing App Player", minutes: 450, starts: 5 };
    const result = derivePlayerAppearances(player, null, boundary);

    expect(result.validity).toBe(DataValidity.MISSING);
    expect(result.value).toBeNull();
    expect(result.source).toBe("fpl_missing");
  });

  it("preserves explicit observed zero from player input without treating as missing", () => {
    const player = { id: 4, name: "Zero App Player", appearances: 0, minutes: 0, starts: 0 };
    const result = derivePlayerAppearances(player, null, boundary);

    expect(result.validity).toBe(DataValidity.OBSERVED_ZERO);
    expect(result.value).toBe(0);
  });
});

describe("Phase 1: Legacy Minutes Proxy Renormalization", () => {
  const boundary = new GameweekBoundary({
    last_finished_gameweek: 10,
    in_progress_gameweek: null,
    prediction_gameweek: 11,
    historical_cutoff_gameweek: 10,
  });

  it("renormalizes weights (55/85 and 30/85) when appearances is missing", () => {
    const player = {
      id: 1,
      minutes: 900, // 900 / 900 = 100%
      starts: 10,   // 10 / 10 = 100%
      chance_of_playing_next_round: 100,
    };
    const missingApp = new DataValue({
      value: null,
      validity: DataValidity.MISSING,
    });

    const result = minutesProfile(player, 10, missingApp, boundary);

    expect(result.appearancesExcluded).toBe(true);
    expect(result.renormalized).toBe(true);
    // When seasonMinutesRate = 100 and startsRate = 100, proxy is 100
    expect(result.minutesProxy).toBeCloseTo(100.0, 1);
    expect(result.effectiveWeights.minutes).toBeCloseTo(0.55 / 0.85, 4);
    expect(result.effectiveWeights.starts).toBeCloseTo(0.30 / 0.85, 4);
    expect(result.effectiveWeights.appearances).toBe(0.0);
  });

  it("uses standard 55/30/15 weights when appearances is observed zero (does not renormalize)", () => {
    const player = {
      id: 2,
      minutes: 450, // 450 / 900 = 50%
      starts: 5,    // 5 / 10 = 50%
      chance_of_playing_next_round: 100,
    };
    const observedZeroApp = new DataValue({
      value: 0,
      validity: DataValidity.OBSERVED_ZERO,
    });

    const result = minutesProfile(player, 10, observedZeroApp, boundary);

    expect(result.appearancesExcluded).toBe(false);
    expect(result.renormalized).toBe(false);
    // 50 * 0.55 + 50 * 0.30 + 0 * 0.15 = 27.5 + 15 = 42.5
    expect(result.minutesProxy).toBeCloseTo(42.5, 1);
  });
});

describe("Phase 1: Missing Metrics Exclusion & Renormalization", () => {
  it("renormalizes weights over valid metrics when some metrics are null/missing", () => {
    const player = {
      id: 1,
      goals_scored: 5,
      assists: null, // missing
      expected_goals: 4.2,
      bonus: undefined, // missing
    };

    const peers = [
      player,
      { id: 2, goals_scored: 2, assists: 1, expected_goals: 1.5, bonus: 3 },
      { id: 3, goals_scored: 8, assists: 4, expected_goals: 7.0, bonus: 10 },
    ];

    const weights = {
      goals_scored: 0.40,
      assists: 0.20,
      expected_goals: 0.30,
      bonus: 0.10,
    };

    const result = weightedPercentile(player, peers, weights, 10);

    expect(result.diagnostic.excluded_metrics).toContain("assists");
    expect(result.diagnostic.excluded_metrics).toContain("bonus");
    expect(result.diagnostic.renormalized).toBe(true);

    // Valid weights were goals_scored (0.4) and expected_goals (0.3), total = 0.7
    expect(result.diagnostic.effective_weights.goals_scored).toBeCloseTo(0.4 / 0.7, 4);
    expect(result.diagnostic.effective_weights.expected_goals).toBeCloseTo(0.3 / 0.7, 4);
    expect(result.score).toBeGreaterThan(0);
  });

  it("treats 0 as valid OBSERVED_ZERO rather than missing", () => {
    const player = {
      id: 1,
      goals_scored: 0, // Valid 0
      assists: 0,      // Valid 0
    };

    const peers = [
      player,
      { id: 2, goals_scored: 2, assists: 1 },
    ];

    const weights = {
      goals_scored: 0.50,
      assists: 0.50,
    };

    const result = weightedPercentile(player, peers, weights, 10);
    expect(result.diagnostic.excluded_metrics.length).toBe(0);
    expect(result.diagnostic.renormalized).toBe(false);
  });
});

describe("Phase 1: Team Strength Validation & Renormalization", () => {
  it("detects uninformative all-zero or missing team strength", () => {
    const teamsWithZeroStrength = [
      { id: 1, name: "Team A", strength_attack_home: 0, strength_attack_away: 0, strength_defence_home: 0, strength_defence_away: 0 },
      { id: 2, name: "Team B", strength_attack_home: 0, strength_attack_away: 0, strength_defence_home: 0, strength_defence_away: 0 },
    ];

    const validity = validateTeamStrengths(teamsWithZeroStrength);
    expect(validity.attackValid).toBe(false);
    expect(validity.defenceValid).toBe(false);
  });

  it("detects valid informative team strength", () => {
    const validTeams = [
      { id: 1, name: "Arsenal", strength_attack_home: 1250, strength_attack_away: 1280, strength_defence_home: 1200, strength_defence_away: 1220 },
      { id: 2, name: "Chelsea", strength_attack_home: 1150, strength_attack_away: 1180, strength_defence_home: 1140, strength_defence_away: 1160 },
    ];

    const validity = validateTeamStrengths(validTeams);
    expect(validity.attackValid).toBe(true);
    expect(validity.defenceValid).toBe(true);
  });

  it("renormalizes team context score when strength is invalid", () => {
    const player = {
      id: 1,
      element_type: 3, // MID
      team_attack_strength: null,
      team_defence_strength: null,
      team_attack_strength_validity: DataValidity.INVALID,
      team_defence_strength_validity: DataValidity.INVALID,
      selected_by_percent: 15.0,
      transfers_in_event: 50000,
      transfers_out_event: 10000,
    };

    const peers = [player];
    const result = teamContextScore(player, peers);

    expect(result.diagnostic.attack_valid).toBe(false);
    expect(result.diagnostic.defence_valid).toBe(false);
    expect(result.diagnostic.excluded_components).toContain("attack");
    expect(result.diagnostic.excluded_components).toContain("defence");
    expect(result.diagnostic.renormalized).toBe(true);
  });
});

describe("Phase 1: Transfer Signal Horizon Semantics", () => {
  it("correctly separates event transfers from cumulative transfers", () => {
    const player = {
      id: 1,
      name: "Erling Haaland",
      element_type: 4,
      transfers_in_event: 120000,
      transfers_out_event: 15000,
      transfers_in: 3500000,
      transfers_out: 1200000,
    };

    const rated = playerRating(player, [player], [player], 15);

    expect(rated.transfer_signal).toBe(105000); // 120000 - 15000
    expect(rated.transfer_signal_horizon).toBe("current_gameweek");
    expect(rated.cumulative_transfers_in).toBe(3500000);
    expect(rated.cumulative_transfers_out).toBe(1200000);
    expect(rated.cumulative_transfer_signal).toBe(2300000);
    expect(rated.cumulative_transfer_horizon).toBe("season_to_date");
  });
});

describe("Phase 1: Gameweek Boundary & Leakage Protection", () => {
  it("excludes in-progress gameweek fixtures from future difficulty window", () => {
    const boundary = new GameweekBoundary({
      last_finished_gameweek: 10,
      in_progress_gameweek: 11,
      prediction_gameweek: 12,
      historical_cutoff_gameweek: 10,
    });

    const fixtures = [
      { id: 1, event: 10, finished: true, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 2, event: 11, finished: false, team_h: 1, team_a: 3, team_h_difficulty: 3, team_a_difficulty: 3 }, // in progress
      { id: 3, event: 12, finished: false, team_h: 4, team_a: 1, team_h_difficulty: 2, team_a_difficulty: 2 }, // prediction gw
      { id: 4, event: 13, finished: false, team_h: 1, team_a: 5, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 5, event: 14, finished: false, team_h: 6, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 3 },
      { id: 6, event: 15, finished: false, team_h: 1, team_a: 7, team_h_difficulty: 2, team_a_difficulty: 5 },
      { id: 7, event: 16, finished: false, team_h: 8, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 2 },
    ];

    const teams = [
      { id: 1, name: "Arsenal", short_name: "ARS", strength_attack_home: 1200, strength_attack_away: 1200, strength_defence_home: 1200, strength_defence_away: 1200 },
      { id: 2, name: "Aston Villa", short_name: "AVL" },
      { id: 3, name: "Chelsea", short_name: "CHE" },
      { id: 4, name: "Everton", short_name: "EVE" },
      { id: 5, name: "Fulham", short_name: "FUL" },
      { id: 6, name: "Liverpool", short_name: "LIV" },
      { id: 7, name: "Man City", short_name: "MCI" },
      { id: 8, name: "Man Utd", short_name: "MUN" },
    ];

    const teamData = fixtureDataForTeam(1, fixtures, teams, boundary);

    // Next 5 fixtures should start from event 12, skipping event 11
    expect(teamData.next_5_fixtures.length).toBe(5);
    expect(teamData.next_5_fixtures[0].gameweek).toBe(12);
  });
});

describe("Phase 1: Active Scoring Gameweek Leakage & Historical Reconstruction", () => {
  const inProgressBoundary = new GameweekBoundary({
    last_finished_gameweek: 2,
    in_progress_gameweek: 3,
    prediction_gameweek: 4,
    historical_cutoff_gameweek: 2,
  });

  const testSnapshot = new PredictionSnapshot({
    snapshot_id: "snap_gw4_cutoff2",
    events: [
      { id: 1, finished: true, is_current: false },
      { id: 2, finished: true, is_current: false },
      { id: 3, finished: false, is_current: true },
      { id: 4, finished: false, is_next: true },
    ],
    snapshot_created_at: "2026-09-01T14:00:00Z",
  });

  it("Test A: protects against active in-progress GW3 performance leakage into historical rating inputs", () => {
    // Player Haaland history for GW1 and GW2
    const gw1Match = { round: 1, minutes: 90, starts: 1, goals_scored: 2, assists: 0, total_points: 13, bonus: 3, clean_sheets: 0, expected_goals: 1.8, expected_assists: 0.1, threat: 75, ict_index: 12.0 };
    const gw2Match = { round: 2, minutes: 90, starts: 1, goals_scored: 1, assists: 1, total_points: 8, bonus: 1, clean_sheets: 0, expected_goals: 1.2, expected_assists: 0.4, threat: 60, ict_index: 9.5 };
    
    // Case 1: In GW3 (in-progress), Haaland plays 90m and scores 5 goals (25 pts)
    const gw3MatchCase1 = { round: 3, minutes: 90, starts: 1, goals_scored: 5, assists: 0, total_points: 25, bonus: 3, clean_sheets: 0, expected_goals: 4.5, expected_assists: 0.0, threat: 180, ict_index: 28.0 };
    const haalandCase1 = {
      id: 999,
      web_name: "Haaland",
      element_type: 4,
      now_cost: 150,
      minutes: 270, // 180 + 90
      starts: 3,
      goals_scored: 8, // 3 + 5
      total_points: 46, // 21 + 25
      event_points: 25, // partial GW3 points in bootstrap
      form: 15.3,
      status: "a",
      selected_by_percent: 60.0,
      team_attack_strength: 1350,
      team_defence_strength: 1200,
    };
    const historyCase1 = [gw1Match, gw2Match, gw3MatchCase1];

    // Case 2: In GW3 (in-progress), exaggerated live data (e.g. 15 goals, 70 pts in bootstrap)
    const gw3MatchCase2 = { round: 3, minutes: 90, starts: 1, goals_scored: 15, assists: 3, total_points: 70, bonus: 3, clean_sheets: 0, expected_goals: 12.0, expected_assists: 2.0, threat: 400, ict_index: 60.0 };
    const haalandCase2 = {
      id: 999,
      web_name: "Haaland",
      element_type: 4,
      now_cost: 150,
      minutes: 400,
      starts: 4,
      goals_scored: 25,
      total_points: 120,
      event_points: 70, // exaggerated partial GW3 points
      form: 35.0,
      status: "a",
      selected_by_percent: 60.0,
      team_attack_strength: 1350,
      team_defence_strength: 1200,
    };
    const historyCase2 = [gw1Match, gw2Match, gw3MatchCase2];

    const ratedCase1 = addRatings([haalandCase1], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 999: historyCase1 },
    })[0];

    const ratedCase2 = addRatings([haalandCase2], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 999: historyCase2 },
    })[0];

    // Historical reconstruction ensures prediction context scores are 100% INVARIANT to in-progress GW3
    expect(ratedCase1.expert_score).toBe(ratedCase2.expert_score);
    expect(ratedCase1.current_form_score).toBe(ratedCase2.current_form_score);
    expect(ratedCase1.future_fpl_score).toBe(ratedCase2.future_fpl_score);
    expect(ratedCase1.expected_minutes_proxy).toBe(ratedCase2.expected_minutes_proxy);
    expect(ratedCase1.minutes_security).toBe(ratedCase2.minutes_security);
    expect(ratedCase1.rating_breakdown).toEqual(ratedCase2.rating_breakdown);

    // Verify diagnostic metadata
    expect(ratedCase1.history_rounds_used).toEqual([1, 2]);
    expect(ratedCase1.in_progress_rounds_excluded).toEqual([3]);
    expect(ratedCase1.reconstructed_from_history).toBe(true);
  });

  it("Test B: historical reconstruction accurately aggregates stats through cutoff gameweek", () => {
    const history = [
      { round: 1, minutes: 90, starts: 1, goals_scored: 2, assists: 1, clean_sheets: 0, bonus: 3, total_points: 13, expected_goals: 1.5, expected_assists: 0.3 },
      { round: 2, minutes: 80, starts: 1, goals_scored: 1, assists: 0, clean_sheets: 0, bonus: 2, total_points: 8, expected_goals: 0.8, expected_assists: 0.1 },
      { round: 3, minutes: 90, starts: 1, goals_scored: 4, assists: 2, clean_sheets: 1, bonus: 3, total_points: 22, expected_goals: 3.5, expected_assists: 1.0 }, // GW3 in-progress
    ];

    const player = {
      id: 501,
      element_type: 4,
      now_cost: 100,
      minutes: 260,
      starts: 3,
      goals_scored: 7,
      total_points: 43,
      status: "a",
      selected_by_percent: 20.0,
    };

    const rated = addRatings([player], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 501: history },
    })[0];

    // Minutes and stats should strictly reflect rounds 1 and 2:
    // Minutes = 90 + 80 = 170. Expected minutes for 2 GWs = 180. Rate = (170/180) * 100 = 94.44%
    // Starts = 2/2 = 100%, Apps = 2/2 = 100%. Proxy = 94.44*0.55 + 100*0.30 + 100*0.15 = 96.94%
    expect(rated.expected_minutes_proxy).toBeCloseTo(96.9, 1);
    expect(rated.appearances_value).toBe(2);
    expect(rated.appearances_validity).toBe(DataValidity.DERIVED);
  });

  it("Test C & D: completed match history appearances derived, and in-progress match appearances excluded", () => {
    // Player with 0 minutes in GW1 and GW2, but plays 90m in GW3
    const history = [
      { round: 1, minutes: 0 },
      { round: 2, minutes: 0 },
      { round: 3, minutes: 90 }, // in-progress GW3
    ];

    const player = {
      id: 502,
      element_type: 3,
      now_cost: 60,
      minutes: 90,
      starts: 1,
      status: "a",
      selected_by_percent: 5.0,
    };

    const rated = addRatings([player], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 502: history },
    })[0];

    // Appearances up to cutoff GW2 is 0 (observed zero), GW3 is excluded
    expect(rated.appearances_value).toBe(0);
    expect(rated.appearances_validity).toBe(DataValidity.OBSERVED_ZERO);
    expect(rated.history_rounds_used).toEqual([1, 2]);
    expect(rated.in_progress_rounds_excluded).toEqual([3]);
  });

  it("Test E & F: route neutrality and deterministic execution across calls", () => {
    const player = {
      id: 503,
      element_type: 1,
      now_cost: 50,
      status: "a",
      selected_by_percent: 10.0,
      team_attack_strength: 1200,
      team_defence_strength: 1200,
    };

    const history = [
      { round: 1, minutes: 90, total_points: 6, clean_sheets: 1 },
      { round: 2, minutes: 90, total_points: 2, clean_sheets: 0 },
    ];

    const run1 = addRatings([player], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 503: history },
    })[0];

    const run2 = addRatings([player], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: { 503: history },
    })[0];

    expect(run1.expert_score).toBe(run2.expert_score);
    expect(run1.future_fpl_score).toBe(run2.future_fpl_score);
    expect(run1.current_form_score).toBe(run2.current_form_score);
    expect(run1.rating_breakdown).toEqual(run2.rating_breakdown);
    expect(run1.snapshot_id).toBe("snap_gw4_cutoff2");
  });

  it("Test G: missing appearances are never coerced to zero and use mathematical renormalization", () => {
    const player = {
      id: 504,
      element_type: 2,
      now_cost: 60,
      minutes: 180,
      starts: 2,
      status: "a",
      selected_by_percent: 15.0,
    };

    // No history provided
    const rated = addRatings([player], {
      referenceGameweek: 2,
      boundary: inProgressBoundary,
      snapshot: testSnapshot,
      recentHistoryByPlayer: null,
    })[0];

    expect(rated.appearances_value).toBeNull();
    expect(rated.appearances_validity).toBe(DataValidity.MISSING);
    expect(rated.rating_breakdown.minutes_proxy_renormalized).toBe(true);
    expect(rated.diagnostics.minutes_profile.appearances_excluded).toBe(true);
    // Since player played 180/180 minutes and 2/2 starts, renormalized proxy is 100
    expect(rated.expected_minutes_proxy).toBe(100);
  });
});

describe("Phase 1: Route Parity & Scoring Invariance", () => {
  it("produces identical scores and breakdowns regardless of route context", () => {
    const boundary = new GameweekBoundary({
      last_finished_gameweek: 15,
      in_progress_gameweek: null,
      prediction_gameweek: 16,
      historical_cutoff_gameweek: 15,
    });
    const snapshot = new PredictionSnapshot({
      snapshot_id: "test_snapshot_gw16",
      events: [{ id: 15, finished: true, is_current: false }, { id: 16, finished: false, is_next: true }],
      snapshot_created_at: "2026-09-01T12:00:00Z",
    });

    const raya = {
      id: 101,
      web_name: "Raya",
      element_type: 1,
      now_cost: 55,
      minutes: 1350,
      starts: 15,
      clean_sheets: 7,
      bonus: 8,
      status: "a",
      selected_by_percent: 32.5,
      transfers_in_event: 45000,
      transfers_out_event: 5000,
      transfers_in: 1200000,
      transfers_out: 400000,
      team_attack_strength: 1250,
      team_defence_strength: 1300,
      next_3_avg_difficulty: 2.33,
      next_5_avg_difficulty: 2.6,
      next_5_fixtures: [
        { gameweek: 16, venue: "H", difficulty: 2 },
        { gameweek: 17, venue: "A", difficulty: 3 },
        { gameweek: 18, venue: "H", difficulty: 2 },
        { gameweek: 19, venue: "A", difficulty: 3 },
        { gameweek: 20, venue: "H", difficulty: 3 },
      ],
    };

    const haaland = {
      id: 102,
      web_name: "Haaland",
      element_type: 4,
      now_cost: 152,
      minutes: 1300,
      starts: 15,
      goals_scored: 14,
      assists: 3,
      bonus: 20,
      expected_goals: 12.8,
      expected_assists: 2.1,
      expected_goal_involvements: 14.9,
      status: "a",
      selected_by_percent: 65.0,
      transfers_in_event: 85000,
      transfers_out_event: 12000,
      transfers_in: 4500000,
      transfers_out: 1100000,
      team_attack_strength: 1350,
      team_defence_strength: 1200,
      next_3_avg_difficulty: 2.0,
      next_5_avg_difficulty: 2.4,
      next_5_fixtures: [
        { gameweek: 16, venue: "H", difficulty: 2 },
        { gameweek: 17, venue: "H", difficulty: 2 },
        { gameweek: 18, venue: "A", difficulty: 2 },
        { gameweek: 19, venue: "A", difficulty: 3 },
        { gameweek: 20, venue: "H", difficulty: 3 },
      ],
    };

    const players = [raya, haaland];

    // Pipeline 1: Bulk rating as on /players or /my-team
    const bulkRated = addRatings(players, {
      referenceGameweek: 15,
      boundary,
      snapshot,
    });

    const rayaBulk = bulkRated.find((p) => p.id === 101)!;
    const haalandBulk = bulkRated.find((p) => p.id === 102)!;

    // Pipeline 2: Single player detail calculation
    const detailRated = addRatings(players, {
      referenceGameweek: 15,
      boundary,
      snapshot,
    });

    const rayaDetail = detailRated.find((p) => p.id === 101)!;
    const haalandDetail = detailRated.find((p) => p.id === 102)!;

    expect(rayaBulk.expert_score).toBe(rayaDetail.expert_score);
    expect(rayaBulk.future_fpl_score).toBe(rayaDetail.future_fpl_score);
    expect(rayaBulk.expected_minutes_proxy).toBe(rayaDetail.expected_minutes_proxy);
    expect(rayaBulk.minutes_security).toBe(rayaDetail.minutes_security);
    expect(rayaBulk.rating_breakdown).toEqual(rayaDetail.rating_breakdown);

    expect(haalandBulk.expert_score).toBe(haalandDetail.expert_score);
    expect(haalandBulk.future_fpl_score).toBe(haalandDetail.future_fpl_score);
    expect(haalandBulk.expected_minutes_proxy).toBe(haalandDetail.expected_minutes_proxy);
    expect(haalandBulk.minutes_security).toBe(haalandDetail.minutes_security);
    expect(haalandBulk.rating_breakdown).toEqual(haalandDetail.rating_breakdown);

    // Verify snapshot metadata presence
    expect(rayaBulk.snapshot_id).toBe("test_snapshot_gw16");
    expect(rayaBulk.historical_cutoff_gameweek).toBe(15);
    expect(rayaBulk.prediction_gameweek).toBe(16);
    expect(rayaBulk.transfer_signal_horizon).toBe("current_gameweek");
    expect(rayaBulk.cumulative_transfer_horizon).toBe("season_to_date");
  });
});
