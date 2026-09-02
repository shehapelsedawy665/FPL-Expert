import { describe, it, expect } from "vitest";
import {
  DataValidity,
  GameweekBoundary,
  PredictionSnapshot,
  validatePredictionPayload,
} from "../services/prediction_contract.js";
import { buildPlayerPredictionFeatures } from "../services/prediction_features.js";
import {
  buildPlayerExpectedMinutes,
  deriveSupportingHistoryEvidence,
  MINUTES_MODEL_VERSION,
  POSITION_PRIORS,
  STATUS_AVAILABILITY_CONFIG,
} from "../services/expected_minutes_model.js";

describe("Phase 3: Expected Minutes & Playing-Time Probability Model", () => {
  const boundaryGw4 = new GameweekBoundary({
    last_finished_gameweek: 3,
    in_progress_gameweek: null,
    prediction_gameweek: 4,
    historical_cutoff_gameweek: 3,
  });

  const snapshotGw4 = new PredictionSnapshot({
    snapshot_id: "snap_test_gw4",
    boundary: boundaryGw4,
  });

  const normalFixtures = [
    { id: 1, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
  ];

  // 1. Fully available regular starter
  it("Scenario 1: fully available regular starter has high start and appearance probabilities and ~80-90 expected minutes", () => {
    const player = { id: 10, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 8 },
      { round: 3, minutes: 85, starts: 1, total_points: 5 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.probability_available.value).toBe(1.0);
    expect(result.probability_available.validity).toBe(DataValidity.OBSERVED);
    expect(result.breakdown.probabilities.probability_start).toBeGreaterThan(0.65);
    expect(result.breakdown.probabilities.probability_appearance).toBeGreaterThanOrEqual(result.breakdown.probabilities.probability_start);
    expect(result.expected_minutes.value).toBeGreaterThan(55);
    expect(result.expected_minutes.value).toBeLessThanOrEqual(90);
    expect(result.model_version).toBe(MINUTES_MODEL_VERSION);
  });

  // 2. Available rotation player
  it("Scenario 2: available rotation player (1 start, 1 sub, 1 benched) produces intermediate probabilities", () => {
    const player = { id: 20, element_type: 3, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 25, starts: 0, total_points: 1 },
      { round: 3, minutes: 0, starts: 0, total_points: 0 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.probabilities.probability_start).toBeLessThan(result.breakdown.probabilities.probability_appearance);
    expect(result.breakdown.historical_evidence.season_starts).toBe(1);
    expect(result.breakdown.historical_evidence.season_sub_appearances).toBe(1);
    expect(result.breakdown.historical_evidence.season_zero_minute_gws).toBe(1);
    expect(result.expected_minutes.value).toBeGreaterThan(15);
    expect(result.expected_minutes.value).toBeLessThan(60);
  });

  // 3. Substitute-only player
  it("Scenario 3: substitute-only player (0 starts, 3 sub cameos) has low start probability but modest appearance probability", () => {
    const player = { id: 30, element_type: 3, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 15, starts: 0, total_points: 1 },
      { round: 2, minutes: 20, starts: 0, total_points: 1 },
      { round: 3, minutes: 10, starts: 0, total_points: 1 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.historical_evidence.season_starts).toBe(0);
    expect(result.breakdown.historical_evidence.season_sub_appearances).toBe(3);
    expect(result.breakdown.probabilities.probability_start).toBeLessThan(0.3);
    expect(result.breakdown.probabilities.probability_appearance).toBeGreaterThan(0.5);
    expect(result.breakdown.minutes_decomposition.substitute_contribution).toBeGreaterThan(0);
  });

  // 4. Zero-minute player
  it("Scenario 4: zero-minute player (0 minutes in all 3 GWs) has low appearance probability derived from shrinkage", () => {
    const player = { id: 40, element_type: 2, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 0, starts: 0, total_points: 0 },
      { round: 2, minutes: 0, starts: 0, total_points: 0 },
      { round: 3, minutes: 0, starts: 0, total_points: 0 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.historical_evidence.season_appearances).toBe(0);
    expect(result.breakdown.historical_evidence.season_zero_minute_gws).toBe(3);
    expect(result.breakdown.probabilities.probability_appearance).toBeLessThan(0.3);
    expect(result.expected_minutes.value).toBeLessThan(25);
  });

  // 5. Injured/unavailable player
  it("Scenario 5: injured/unavailable player (status 'i') has 0 availability, 0 start, 0 appearance, 0 expected minutes", () => {
    const player = { id: 50, element_type: 4, team: 1, status: "i", news: "Hamstring injury" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.probability_available.value).toBe(0);
    expect(result.probability_available.validity).toBe(DataValidity.OBSERVED_ZERO);
    expect(result.probability_appearance.value).toBe(0);
    expect(result.probability_start.value).toBe(0);
    expect(result.probability_60_plus_minutes.value).toBe(0);
    expect(result.expected_minutes.value).toBe(0);
  });

  // 6. Official chance field present
  it("Scenario 6: official chance field (e.g. 75%) is normalized to 0.75 and used directly", () => {
    const player = { id: 60, element_type: 3, team: 1, status: "d", chance_of_playing_next_round: 75 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.probability_available.value).toBe(0.75);
    expect(result.probability_available.validity).toBe(DataValidity.OBSERVED);
    expect(result.breakdown.availability.fallback_used).toBe(false);
  });

  // 7. Status fallback when official chance missing
  it("Scenario 7: status fallback is used when official chance is missing", () => {
    const player = { id: 70, element_type: 2, team: 1, status: "a", chance_of_playing_next_round: null };
    const history = [{ round: 1, minutes: 90, starts: 1, total_points: 6 }];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.availability.fallback_used).toBe(true);
    expect(result.probability_available.value).toBe(STATUS_AVAILABILITY_CONFIG.a.probability);
    expect(result.probability_available.validity).toBe(STATUS_AVAILABILITY_CONFIG.a.validity);
  });

  // 8. 2 starts from 2 GWs shrunk below absolute certainty
  it("Scenario 8: 2 starts from 2 GWs is shrunk below 1.00", () => {
    const boundaryGw3 = new GameweekBoundary({
      last_finished_gameweek: 2,
      in_progress_gameweek: null,
      prediction_gameweek: 3,
      historical_cutoff_gameweek: 2,
    });
    const snapshotGw3 = new PredictionSnapshot({ snapshot_id: "snap_gw3", boundary: boundaryGw3 });
    const player = { id: 80, element_type: 4, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const gw3Fixtures = [{ id: 1, event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw3,
      history,
      allFixtures: gw3Fixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw3,
      history,
    });

    expect(result.breakdown.shrinkage.sample_size).toBe(2);
    expect(result.breakdown.shrinkage.raw_start_rate).toBe(1.0);
    // With calibrated prior weight 1.5, shrunk_start_base = (2 + 1.5*0.45)/(2+1.5) = 2.675/3.5 = 0.764
    // Plus streak bonus for 2 consecutive starts (0.06*2*1.0 = 0.12) -> condStart ~ 0.884
    expect(result.breakdown.probabilities.probability_start).toBeGreaterThan(0.70);
    expect(result.breakdown.probabilities.probability_start).toBeLessThan(0.95);
  });

  // 9. Missing start history
  it("Scenario 9: missing start history safely falls back to position default expected minutes", () => {
    const player = { id: 90, element_type: 1, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 10, starts: 0, total_points: 1 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.historical_evidence.starts_fallback_used).toBe(true);
    expect(result.breakdown.minutes_decomposition.expected_minutes_when_started).toBe(POSITION_PRIORS[1].default_expected_mins_when_started);
  });

  // 10. Missing substitute-minutes history
  it("Scenario 10: missing substitute history safely falls back to position default sub minutes", () => {
    const player = { id: 100, element_type: 2, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.historical_evidence.sub_fallback_used).toBe(true);
    expect(result.breakdown.minutes_decomposition.expected_minutes_as_substitute).toBe(POSITION_PRIORS[2].default_expected_mins_as_sub);
  });

  // 11. Observed zero vs missing
  it("Scenario 11: observed zero is distinguished from missing data", () => {
    const playerWithZero = { id: 110, element_type: 3, team: 1, status: "s" };
    const historyZero = [{ round: 1, minutes: 0, starts: 0, total_points: 0 }];
    const featuresZero = buildPlayerPredictionFeatures({
      player: playerWithZero,
      snapshot: snapshotGw4,
      history: historyZero,
      allFixtures: normalFixtures,
    });
    const resultZero = buildPlayerExpectedMinutes({
      player: playerWithZero,
      features: featuresZero,
      snapshot: snapshotGw4,
      history: historyZero,
    });

    expect(resultZero.probability_available.validity).toBe(DataValidity.OBSERVED_ZERO);
    expect(resultZero.probability_available.value).toBe(0);

    const playerEmpty = { id: 111, element_type: 3, team: 1, status: "a" };
    const featuresEmpty = buildPlayerPredictionFeatures({
      player: playerEmpty,
      snapshot: snapshotGw4,
      history: [],
      allFixtures: normalFixtures,
    });
    const resultEmpty = buildPlayerExpectedMinutes({
      player: playerEmpty,
      features: featuresEmpty,
      snapshot: snapshotGw4,
      history: [],
    });

    expect(resultEmpty.breakdown.historical_evidence.completed_gameweeks_count).toBe(0);
  });

  // 12. P(start) <= P(appearance)
  it("Scenario 12: invariant P(start) <= P(appearance) is strictly maintained", () => {
    const player = { id: 120, element_type: 4, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 30, starts: 0, total_points: 1 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.probabilities.probability_start).toBeLessThanOrEqual(result.breakdown.probabilities.probability_appearance);
  });

  // 13. P(appearance) <= P(available)
  it("Scenario 13: invariant P(appearance) <= P(available) is strictly maintained", () => {
    const player = { id: 130, element_type: 3, team: 1, status: "d", chance_of_playing_next_round: 50 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.probabilities.probability_appearance).toBeLessThanOrEqual(result.probability_available.value);
  });

  // 14. P(60+) <= P(appearance)
  it("Scenario 14: invariant P(60+) <= P(appearance) and P(60+) <= P(start) are maintained", () => {
    const player = { id: 140, element_type: 3, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 55, starts: 1, total_points: 2 },
      { round: 3, minutes: 20, starts: 0, total_points: 1 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.breakdown.probabilities.probability_60_plus_minutes).toBeLessThanOrEqual(result.breakdown.probabilities.probability_start);
    expect(result.breakdown.probabilities.probability_60_plus_minutes).toBeLessThanOrEqual(result.breakdown.probabilities.probability_appearance);
  });

  // 15. Expected minutes decomposition
  it("Scenario 15: expected minutes equals sum of start contribution and substitute contribution", () => {
    const player = { id: 150, element_type: 2, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 30, starts: 0, total_points: 1 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    const decomp = result.breakdown.minutes_decomposition;
    const computedSum = Math.round((decomp.start_contribution + decomp.substitute_contribution) * 10) / 10;
    expect(decomp.single_fixture_expected_minutes).toBeCloseTo(computedSum, 1);
  });

  // 16. Expected minutes within valid range
  it("Scenario 16: expected minutes for single fixture is in [0, 90]", () => {
    const player = { id: 160, element_type: 4, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.expected_minutes.value).toBeGreaterThanOrEqual(0);
    expect(result.expected_minutes.value).toBeLessThanOrEqual(90);
  });

  // 17. BGW expected minutes = 0
  it("Scenario 17: BGW sets expected minutes and probabilities to 0 / NOT_APPLICABLE", () => {
    const player = { id: 170, element_type: 4, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    // No fixture in GW4, next fixture in GW5
    const bgwFixtures = [
      { id: 201, event: 5, team_h: 1, team_a: 6, team_h_difficulty: 3, team_a_difficulty: 3 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: bgwFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.expected_minutes.validity).toBe(DataValidity.NOT_APPLICABLE);
    expect(result.expected_minutes.value).toBe(null);
    expect(result.probability_appearance.validity).toBe(DataValidity.NOT_APPLICABLE);
    expect(result.probability_start.validity).toBe(DataValidity.NOT_APPLICABLE);
    expect(result.probability_60_plus_minutes.validity).toBe(DataValidity.NOT_APPLICABLE);
    expect(result.breakdown.minutes_decomposition.total_expected_minutes).toBe(0);
  });

  // 18. DGW expected minutes can exceed 90
  it("Scenario 18: DGW expected minutes can exceed 90 for a regular starter", () => {
    const player = { id: 180, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const dgwFixtures = [
      { id: 301, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 302, event: 4, team_h: 3, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: dgwFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.expected_minutes.value).toBeGreaterThan(90);
    expect(result.breakdown.fixture_count).toBe(2);
    expect(result.breakdown.per_fixture_breakdown?.length).toBe(2);
  });

  // 19. DGW expected minutes cannot exceed 90 × fixture_count
  it("Scenario 19: DGW expected minutes cannot exceed 90 * fixture_count (180 for 2 fixtures)", () => {
    const player = { id: 190, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
    ];
    const dgwFixtures = [
      { id: 301, event: 4, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 302, event: 4, team_h: 3, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: dgwFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(result.expected_minutes.value).toBeLessThanOrEqual(180);
  });

  // 20. In-progress GW excluded
  it("Scenario 20: in-progress GW is excluded from minutes and start rates", () => {
    const boundaryWithInProgress = new GameweekBoundary({
      last_finished_gameweek: 2,
      in_progress_gameweek: 3,
      prediction_gameweek: 4,
      historical_cutoff_gameweek: 2,
    });
    const snapshotWithInProgress = new PredictionSnapshot({
      snapshot_id: "snap_inp",
      boundary: boundaryWithInProgress,
    });
    const player = { id: 200, element_type: 4, team: 1, status: "a" };
    const historyWithInProgress = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 45, starts: 0, total_points: 1 }, // GW3 in progress: MUST BE EXCLUDED
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotWithInProgress,
      history: historyWithInProgress,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotWithInProgress,
      history: historyWithInProgress,
    });

    expect(result.breakdown.historical_evidence.completed_gameweeks_count).toBe(2);
    expect(result.breakdown.historical_evidence.season_starts).toBe(2);
    expect(result.breakdown.historical_evidence.season_sub_appearances).toBe(0);
  });

  // 21. Deterministic same-snapshot replay
  it("Scenario 21: running model twice with same inputs produces identical deterministic outputs", () => {
    const player = { id: 210, element_type: 3, team: 1, status: "a" };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 45, starts: 0, total_points: 2 },
      { round: 3, minutes: 90, starts: 1, total_points: 7 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const run1 = buildPlayerExpectedMinutes({ player, features, snapshot: snapshotGw4, history });
    const run2 = buildPlayerExpectedMinutes({ player, features, snapshot: snapshotGw4, history });

    expect(run1.expected_minutes.value).toBe(run2.expected_minutes.value);
    expect(run1.breakdown.probabilities).toEqual(run2.breakdown.probabilities);
    expect(run1.prediction_output).toEqual(run2.prediction_output);
  });

  // 22. Route-neutral outputs & Prediction Contract validation
  it("Scenario 22: prediction_output adheres strictly to validatePredictionPayload contract", () => {
    const player = { id: 220, element_type: 4, team: 1, status: "a", expert_score: 72.5 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 8 },
    ];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(() => validatePredictionPayload(result.prediction_output)).not.toThrow();
  });

  // 23. Legacy score invariance
  it("Scenario 23: legacy expert_score and minutes_proxy are not overwritten or mutated", () => {
    const player = { id: 230, element_type: 4, team: 1, status: "a", expert_score: 68.8, expected_minutes_proxy: 78.5 };
    const history = [{ round: 1, minutes: 90, starts: 1, total_points: 6 }];
    const features = buildPlayerPredictionFeatures({
      player,
      snapshot: snapshotGw4,
      history,
      allFixtures: normalFixtures,
    });
    const result = buildPlayerExpectedMinutes({
      player,
      features,
      snapshot: snapshotGw4,
      history,
    });

    expect(player.expert_score).toBe(68.8);
    expect(player.expected_minutes_proxy).toBe(78.5);
    expect(result.prediction_output.expert_rank_score.value).toBe(68.8);
  });

  // 24. Synthetic Sanity Matrix (Players A-F)
  it("Scenario 24: Synthetic Sanity Matrix produces expected playing-time ordering (A > B > C > D > E > F)", () => {
    // Player A: 100% available, 5/5 starts, 90 mins each
    const playerA = { id: 101, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyA = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
      { round: 4, minutes: 90, starts: 1, total_points: 6 },
      { round: 5, minutes: 90, starts: 1, total_points: 6 },
    ];

    // Player B: 100% available, 2/2 starts, 90 mins each
    const playerB = { id: 102, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyB = [
      { round: 4, minutes: 90, starts: 1, total_points: 6 },
      { round: 5, minutes: 90, starts: 1, total_points: 6 },
    ];

    // Player C: 75% available, 5/5 starts, 90 mins each
    const playerC = { id: 103, element_type: 4, team: 1, status: "d", chance_of_playing_next_round: 75 };
    const historyC = [...historyA];

    // Player D: 100% available, 5/5 sub cameos (~20 mins each)
    const playerD = { id: 104, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyD = [
      { round: 1, minutes: 20, starts: 0, total_points: 1 },
      { round: 2, minutes: 20, starts: 0, total_points: 1 },
      { round: 3, minutes: 20, starts: 0, total_points: 1 },
      { round: 4, minutes: 20, starts: 0, total_points: 1 },
      { round: 5, minutes: 20, starts: 0, total_points: 1 },
    ];

    // Player E: 100% available, 5/5 bench (0 mins)
    const playerE = { id: 105, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyE = [
      { round: 1, minutes: 0, starts: 0, total_points: 0 },
      { round: 2, minutes: 0, starts: 0, total_points: 0 },
      { round: 3, minutes: 0, starts: 0, total_points: 0 },
      { round: 4, minutes: 0, starts: 0, total_points: 0 },
      { round: 5, minutes: 0, starts: 0, total_points: 0 },
    ];

    // Player F: 0% available (status 'i')
    const playerF = { id: 106, element_type: 4, team: 1, status: "i", chance_of_playing_next_round: 0 };
    const historyF = [...historyA];

    const boundaryGw6 = new GameweekBoundary({
      last_finished_gameweek: 5,
      in_progress_gameweek: null,
      prediction_gameweek: 6,
      historical_cutoff_gameweek: 5,
    });
    const snapshotGw6 = new PredictionSnapshot({ snapshot_id: "snap_gw6", boundary: boundaryGw6 });
    const gw6Fixtures = [{ id: 601, event: 6, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }];

    const resA = buildPlayerExpectedMinutes({ player: playerA, features: buildPlayerPredictionFeatures({ player: playerA, snapshot: snapshotGw6, history: historyA, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyA });
    const resB = buildPlayerExpectedMinutes({ player: playerB, features: buildPlayerPredictionFeatures({ player: playerB, snapshot: snapshotGw6, history: historyB, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyB });
    const resC = buildPlayerExpectedMinutes({ player: playerC, features: buildPlayerPredictionFeatures({ player: playerC, snapshot: snapshotGw6, history: historyC, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyC });
    const resD = buildPlayerExpectedMinutes({ player: playerD, features: buildPlayerPredictionFeatures({ player: playerD, snapshot: snapshotGw6, history: historyD, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyD });
    const resE = buildPlayerExpectedMinutes({ player: playerE, features: buildPlayerPredictionFeatures({ player: playerE, snapshot: snapshotGw6, history: historyE, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyE });
    const resF = buildPlayerExpectedMinutes({ player: playerF, features: buildPlayerPredictionFeatures({ player: playerF, snapshot: snapshotGw6, history: historyF, allFixtures: gw6Fixtures }), snapshot: snapshotGw6, history: historyF });

    const minsA = resA.expected_minutes.value as number;
    const minsB = resB.expected_minutes.value as number;
    const minsC = resC.expected_minutes.value as number;
    const minsD = resD.expected_minutes.value as number;
    const minsE = resE.expected_minutes.value as number;
    const minsF = resF.expected_minutes.value as number;

    // Sanity checks on absolute values
    expect(minsA).toBeGreaterThanOrEqual(78); // Solid ~80+ min starter
    expect(minsB).toBeGreaterThanOrEqual(70); // 2/2 starter ~72-78 mins
    expect(minsC).toBeGreaterThanOrEqual(55); // 75% available of ~80+ min
    expect(minsD).toBeLessThan(30);           // Sub cameo ~15-25 mins
    expect(minsE).toBeLessThan(15);           // Bench ~0-12 mins
    expect(minsF).toBe(0);                   // Injured = exactly 0 mins

    // Strict Ordering Verification: A >= B > C > D > E > F
    expect(minsA).toBeGreaterThanOrEqual(minsB);
    expect(minsB).toBeGreaterThan(minsC);
    expect(minsC).toBeGreaterThan(minsD);
    expect(minsD).toBeGreaterThan(minsE);
    expect(minsE).toBeGreaterThan(minsF);
  });

  // 25. Sample Growth Test (1/1 -> 2/2 -> 3/3 -> 5/5 -> 8/8)
  it("Scenario 25: monotonic start probability & confidence increase as consistent 90-minute sample grows", () => {
    const buildHistory = (n: number) => {
      const arr = [];
      for (let i = 1; i <= n; i++) {
        arr.push({ round: i, minutes: 90, starts: 1, total_points: 6 });
      }
      return arr;
    };

    const results = [1, 2, 3, 5, 8].map((n) => {
      const boundary = new GameweekBoundary({
        last_finished_gameweek: n,
        in_progress_gameweek: null,
        prediction_gameweek: n + 1,
        historical_cutoff_gameweek: n,
      });
      const snapshot = new PredictionSnapshot({ snapshot_id: `snap_${n}`, boundary });
      const player = { id: 300 + n, element_type: 4, team: 1, status: "a", chance_of_playing_next_round: 100 };
      const history = buildHistory(n);
      const features = buildPlayerPredictionFeatures({
        player,
        snapshot,
        history,
        allFixtures: [{ id: 1, event: n + 1, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }],
      });
      return buildPlayerExpectedMinutes({ player, features, snapshot, history });
    });

    const startProbs = results.map((r) => r.breakdown.probabilities.probability_start);
    const confidences = results.map((r) => r.playing_time_confidence.value as number);
    const expMinutes = results.map((r) => r.expected_minutes.value as number);

    // Monotonic progression checks
    for (let i = 1; i < results.length; i++) {
      expect(startProbs[i]).toBeGreaterThanOrEqual(startProbs[i - 1]);
      expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
      expect(expMinutes[i]).toBeGreaterThanOrEqual(expMinutes[i - 1]);
    }

    // 2/2 should be at least ~70+ minutes, 5/5 at least ~80+ minutes
    expect(expMinutes[1]).toBeGreaterThanOrEqual(70);
    expect(expMinutes[3]).toBeGreaterThanOrEqual(80);
  });

  // 26. Role Recency Test (Recent starter vs recent bench)
  it("Scenario 26: recent starter (0,0,0,90,90) has significantly higher expected minutes than recently benched (90,90,90,0,0)", () => {
    const boundaryGw6 = new GameweekBoundary({
      last_finished_gameweek: 5,
      in_progress_gameweek: null,
      prediction_gameweek: 6,
      historical_cutoff_gameweek: 5,
    });
    const snapshotGw6 = new PredictionSnapshot({ snapshot_id: "snap_recency", boundary: boundaryGw6 });
    const gw6Fixtures = [{ id: 601, event: 6, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }];

    // Player Emerged (started last 2 matches)
    const playerEmerged = { id: 401, element_type: 3, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyEmerged = [
      { round: 1, minutes: 0, starts: 0, total_points: 0 },
      { round: 2, minutes: 0, starts: 0, total_points: 0 },
      { round: 3, minutes: 0, starts: 0, total_points: 0 },
      { round: 4, minutes: 90, starts: 1, total_points: 6 },
      { round: 5, minutes: 90, starts: 1, total_points: 6 },
    ];

    // Player Dropped (benched last 2 matches)
    const playerDropped = { id: 402, element_type: 3, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyDropped = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
      { round: 3, minutes: 90, starts: 1, total_points: 6 },
      { round: 4, minutes: 0, starts: 0, total_points: 0 },
      { round: 5, minutes: 0, starts: 0, total_points: 0 },
    ];

    const resEmerged = buildPlayerExpectedMinutes({
      player: playerEmerged,
      features: buildPlayerPredictionFeatures({ player: playerEmerged, snapshot: snapshotGw6, history: historyEmerged, allFixtures: gw6Fixtures }),
      snapshot: snapshotGw6,
      history: historyEmerged,
    });

    const resDropped = buildPlayerExpectedMinutes({
      player: playerDropped,
      features: buildPlayerPredictionFeatures({ player: playerDropped, snapshot: snapshotGw6, history: historyDropped, allFixtures: gw6Fixtures }),
      snapshot: snapshotGw6,
      history: historyDropped,
    });

    // Emerged player should have higher start probability and higher expected minutes
    expect(resEmerged.breakdown.probabilities.probability_start).toBeGreaterThan(resDropped.breakdown.probabilities.probability_start);
    expect(Number(resEmerged.expected_minutes.value)).toBeGreaterThan(Number(resDropped.expected_minutes.value) + 15);
  });

  // 27. Goalkeeper role stability (David Raya 180/180 -> ~80-90 minutes)
  it("Scenario 27: Goalkeeper with 2/2 90-minute starts has very high start probability and ~80-90 expected minutes", () => {
    const boundaryGw3 = new GameweekBoundary({
      last_finished_gameweek: 2,
      in_progress_gameweek: null,
      prediction_gameweek: 3,
      historical_cutoff_gameweek: 2,
    });
    const snapshotGw3 = new PredictionSnapshot({ snapshot_id: "snap_raya", boundary: boundaryGw3 });
    const playerRaya = { id: 501, element_type: 1, team: 1, status: "a", chance_of_playing_next_round: 100 };
    const historyRaya = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const fixtures = [{ id: 1, event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }];

    const resRaya = buildPlayerExpectedMinutes({
      player: playerRaya,
      features: buildPlayerPredictionFeatures({ player: playerRaya, snapshot: snapshotGw3, history: historyRaya, allFixtures: fixtures }),
      snapshot: snapshotGw3,
      history: historyRaya,
    });

    expect(resRaya.breakdown.probabilities.probability_start).toBeGreaterThanOrEqual(0.85);
    expect(Number(resRaya.expected_minutes.value)).toBeGreaterThanOrEqual(80.0);
  });

  // 28. Availability applied exactly once (No double discount)
  it("Scenario 28: Availability is applied exactly once in decomposition formula", () => {
    const boundaryGw3 = new GameweekBoundary({
      last_finished_gameweek: 2,
      in_progress_gameweek: null,
      prediction_gameweek: 3,
      historical_cutoff_gameweek: 2,
    });
    const snapshotGw3 = new PredictionSnapshot({ snapshot_id: "snap_avail_single", boundary: boundaryGw3 });
    const playerDoubt = { id: 601, element_type: 4, team: 1, status: "d", chance_of_playing_next_round: 50 };
    const history = [
      { round: 1, minutes: 90, starts: 1, total_points: 6 },
      { round: 2, minutes: 90, starts: 1, total_points: 6 },
    ];
    const fixtures = [{ id: 1, event: 3, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }];

    const resDoubt = buildPlayerExpectedMinutes({
      player: playerDoubt,
      features: buildPlayerPredictionFeatures({ player: playerDoubt, snapshot: snapshotGw3, history, allFixtures: fixtures }),
      snapshot: snapshotGw3,
      history,
    });

    // When fully available (100%), player gets expected minutes E_full
    const playerFull = { ...playerDoubt, status: "a", chance_of_playing_next_round: 100 };
    const resFull = buildPlayerExpectedMinutes({
      player: playerFull,
      features: buildPlayerPredictionFeatures({ player: playerFull, snapshot: snapshotGw3, history, allFixtures: fixtures }),
      snapshot: snapshotGw3,
      history,
    });

    const minsDoubt = Number(resDoubt.expected_minutes.value);
    const minsFull = Number(resFull.expected_minutes.value);

    // With P(available) = 0.5, minsDoubt must be exactly 0.5 * minsFull (within 0.5 rounding)
    expect(minsDoubt).toBeCloseTo(0.5 * minsFull, 0);
  });
});
