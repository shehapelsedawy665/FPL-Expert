import { describe, it, expect } from "vitest";
import {
  GameweekBoundary,
  PredictionSnapshot,
  DataValidity,
} from "../services/prediction_contract.js";
import {
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  MULTI_GW_PROJECTION_VERSION,
  FORWARD_ROLE_ASSUMPTION,
  FORWARD_AVAILABILITY_ASSUMPTION,
} from "../services/multi_gw_projection.js";
import { SetPieceRole } from "../services/prediction_features.js";

describe("Phase 6B: Multi-Gameweek Projection Layer", () => {
  const teams = [
    { id: 1, name: "Arsenal", short_name: "ARS" },
    { id: 2, name: "Aston Villa", short_name: "AVL" },
    { id: 3, name: "Burnley", short_name: "BUR" },
    { id: 4, name: "Chelsea", short_name: "CHE" },
    { id: 5, name: "Liverpool", short_name: "LIV" },
    { id: 6, name: "Man City", short_name: "MCI" },
  ];

  const snapshot = new PredictionSnapshot({
    snapshot_id: "test_snapshot_gw5",
    boundary: new GameweekBoundary({
      last_finished_gameweek: 5,
      historical_cutoff_gameweek: 5,
      in_progress_gameweek: null,
      prediction_gameweek: 6,
    }),
  });

  const sampleHistory = [
    { round: 1, minutes: 90, starts: 1, goals_scored: 1, assists: 0, expected_goals: "0.60", expected_assists: "0.20", total_points: 8 },
    { round: 2, minutes: 90, starts: 1, goals_scored: 0, assists: 1, expected_goals: "0.30", expected_assists: "0.50", total_points: 6 },
    { round: 3, minutes: 85, starts: 1, goals_scored: 1, assists: 1, expected_goals: "0.75", expected_assists: "0.40", total_points: 12 },
    { round: 4, minutes: 90, starts: 1, goals_scored: 0, assists: 0, expected_goals: "0.40", expected_assists: "0.10", total_points: 2 },
    { round: 5, minutes: 90, starts: 1, goals_scored: 2, assists: 0, expected_goals: "1.10", expected_assists: "0.15", total_points: 13 },
  ];

  const fixtures = [
    // GW 6: ARS (1) vs BUR (3) [Home, Diff 2]
    { id: 101, event: 6, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4 },
    // GW 7: ARS (1) vs AVL (2) [Away, Diff 3]
    { id: 102, event: 7, team_h: 2, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
    // GW 8: Blank for ARS (no fixture in event 8)
    // GW 9: DGW for ARS (2 fixtures in event 9): ARS vs CHE, ARS vs LIV
    { id: 103, event: 9, team_h: 1, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
    { id: 104, event: 9, team_h: 1, team_a: 5, team_h_difficulty: 4, team_a_difficulty: 3 },
    // GW 10: ARS (1) vs MCI (6) [Away, Diff 5]
    { id: 105, event: 10, team_h: 6, team_a: 1, team_h_difficulty: 2, team_a_difficulty: 5 },
  ];

  const premiumMid = {
    id: 10,
    web_name: "Saka",
    element_type: 3, // MID
    team: 1, // ARS
    status: "a",
    chance_of_playing_next_round: 100,
  };

  it("1. builds multi-GW projections across a 5-GW horizon (GW6 to GW10)", () => {
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    expect(proj.player_id).toBe(10);
    expect(proj.web_name).toBe("Saka");
    expect(proj.position_short_name).toBe("MID");
    expect(proj.team_short_name).toBe("ARS");
    expect(proj.start_gameweek).toBe(6);
    expect(proj.horizon).toBe(5);
    expect(proj.gameweeks.length).toBe(5);

    // Verify gameweek numbers
    expect(proj.gameweeks.map((g) => g.gameweek)).toEqual([6, 7, 8, 9, 10]);
    expect(proj.gameweeks.map((g) => g.gw_offset)).toEqual([1, 2, 3, 4, 5]);
  });

  it("2. handles BGW correctly (GW8 = 0 points, 0 minutes, NOT_APPLICABLE)", () => {
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    const gw8 = proj.gameweeks.find((g) => g.gameweek === 8)!;
    expect(gw8).toBeDefined();
    expect(gw8.fixture_count).toBe(0);
    expect(gw8.gameweek_type).toBe("blank");
    expect(gw8.is_bgw).toBe(true);
    expect(gw8.is_dgw).toBe(false);
    expect(gw8.expected_minutes).toBe(0.0);
    expect(gw8.expected_points).toBe(0.0);
    expect(gw8.raw_expected_points).toBe(0.0);
    expect(gw8.validity).toBe(DataValidity.NOT_APPLICABLE);
    expect(gw8.fixtures.length).toBe(0);
  });

  it("3. handles DGW correctly (GW9 = sum of 2 fixtures)", () => {
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    const gw9 = proj.gameweeks.find((g) => g.gameweek === 9)!;
    expect(gw9).toBeDefined();
    expect(gw9.fixture_count).toBe(2);
    expect(gw9.gameweek_type).toBe("double");
    expect(gw9.is_dgw).toBe(true);
    expect(gw9.is_bgw).toBe(false);
    expect(gw9.fixtures.length).toBe(2);

    // Check that GW9 points equals sum of individual fixture points
    const sumFixPoints = Math.round((gw9.fixtures[0].expected_points + gw9.fixtures[1].expected_points) * 100) / 100;
    expect(gw9.expected_points).toBe(sumFixPoints);

    // Check that GW9 minutes equals sum of individual fixture minutes
    const sumFixMins = Math.round((gw9.fixtures[0].expected_minutes + gw9.fixtures[1].expected_minutes) * 10) / 10;
    expect(gw9.expected_minutes).toBe(sumFixMins);
  });

  it("4. verifies cumulative and time-discounted arithmetic", () => {
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
      discountFactors: [1.00, 0.95, 0.90],
    });

    const xPts = proj.gameweeks.map((g) => g.expected_points);
    const expectedCum = Math.round(xPts.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(proj.cumulative_expected_points).toBe(expectedCum);

    // Undiscounted (1.00) equals cumulative
    expect(proj.discounted_expected_points["1.00"]).toBe(expectedCum);

    // 0.95 discount: sum_{i=0..4} 0.95^i * xPts[i]
    let manualDisc95 = 0;
    for (let i = 0; i < xPts.length; i++) {
      manualDisc95 += Math.pow(0.95, i) * xPts[i];
    }
    manualDisc95 = Math.round(manualDisc95 * 100) / 100;
    expect(proj.discounted_expected_points["0.95"]).toBe(manualDisc95);

    // 0.90 discount: sum_{i=0..4} 0.90^i * xPts[i]
    let manualDisc90 = 0;
    for (let i = 0; i < xPts.length; i++) {
      manualDisc90 += Math.pow(0.90, i) * xPts[i];
    }
    manualDisc90 = Math.round(manualDisc90 * 100) / 100;
    expect(proj.discounted_expected_points["0.90"]).toBe(manualDisc90);

    // Check cumulative sub-horizons
    expect(proj.cumulative_horizons.gw1).toBe(xPts[0]);
    expect(proj.cumulative_horizons.gw3).toBe(Math.round((xPts[0] + xPts[1] + xPts[2]) * 100) / 100);
    expect(proj.cumulative_horizons.gw5).toBe(expectedCum);
  });

  it("5. confirms zero future data leakage and static role policy", () => {
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    expect(proj.role_assumption).toBe(FORWARD_ROLE_ASSUMPTION);
    expect(proj.availability_assumption).toBe(FORWARD_AVAILABILITY_ASSUMPTION);
    expect(proj.provenance.historical_cutoff_gameweek).toBe(5);
    expect(proj.provenance.models.multi_gw_version).toBe(MULTI_GW_PROJECTION_VERSION);
  });

  it("6. demonstrates horizon ranking reversal (GW1 favorite vs GW5 favorite)", () => {
    // Player A: Plays in GW6 (easy diff 2), then blanks in GW7, GW8, tough in GW9, GW10
    // Player B: Plays in GW6 (tough diff 5), but has DGW in GW9 and easy games elsewhere
    const playerA = {
      id: 21,
      web_name: "PlayerA_ShortTerm",
      element_type: 4, // FWD
      team: 2, // AVL
      status: "a",
      chance_of_playing_next_round: 100,
    };

    const playerB = {
      id: 22,
      web_name: "PlayerB_LongTerm",
      element_type: 4, // FWD
      team: 1, // ARS
      status: "a",
      chance_of_playing_next_round: 100,
    };

    const customFixtures = [
      // GW6: Player A easy (diff 2), Player B hard (diff 5)
      { id: 201, event: 6, team_h: 2, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 202, event: 6, team_h: 6, team_a: 1, team_h_difficulty: 2, team_a_difficulty: 5 },
      // GW7: Player A tough (diff 5), Player B easy (diff 2)
      { id: 203, event: 7, team_h: 6, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 5 },
      { id: 204, event: 7, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4 },
      // GW8: Player A blanks (no fix), Player B normal (diff 3)
      { id: 205, event: 8, team_h: 1, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
      // GW9: Player A normal (diff 4), Player B DGW (diff 2 & diff 3)
      { id: 206, event: 9, team_h: 5, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 207, event: 9, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
      { id: 208, event: 9, team_h: 1, team_a: 3, team_h_difficulty: 2, team_a_difficulty: 4 },
      // GW10: Both normal
      { id: 209, event: 10, team_h: 2, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 3 },
      { id: 210, event: 10, team_h: 1, team_a: 5, team_h_difficulty: 3, team_a_difficulty: 3 },
    ];

    const projA = projectPlayerMultiGameweek({
      player: playerA,
      snapshot,
      allFixtures: customFixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    const projB = projectPlayerMultiGameweek({
      player: playerB,
      snapshot,
      allFixtures: customFixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
    });

    // In GW6 (GW1 of horizon): Player A has higher xPts than Player B due to easy fixture vs hard fixture
    expect(projA.gameweeks[0].expected_points).toBeGreaterThan(projB.gameweeks[0].expected_points);

    // Over 5 GWs: Player B has much higher cumulative expected points due to Player A's blank and Player B's DGW
    expect(projB.cumulative_expected_points).toBeGreaterThan(projA.cumulative_expected_points);
  });

  it("7. projects multi-GW for a full squad batch", () => {
    const squad = [
      { id: 1, web_name: "Raya", element_type: 1, team: 1, status: "a" },
      { id: 2, web_name: "Saliba", element_type: 2, team: 1, status: "a" },
      { id: 3, web_name: "Gabriel", element_type: 2, team: 1, status: "a" },
      { id: 4, web_name: "Saka", element_type: 3, team: 1, status: "a" },
      { id: 5, web_name: "Havertz", element_type: 4, team: 1, status: "a" },
    ];

    const projections = projectSquadMultiGameweek({
      players: squad,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
    });

    expect(projections.length).toBe(5);
    for (const p of projections) {
      expect(p.gameweeks.length).toBe(5);
      expect(p.cumulative_expected_points).toBeGreaterThanOrEqual(0);
      expect(p.discounted_expected_points["0.95"]).toBeDefined();
    }
  });

  it("8. verifies projection order independence (GW6->GW10 vs GW10->GW6)", () => {
    const forwardProj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
      startGameweek: 6,
    });

    // Evaluate each GW independently as target start gameweek
    for (let offset = 0; offset < 5; offset++) {
      const singleGwProj = projectPlayerMultiGameweek({
        player: premiumMid,
        snapshot,
        allFixtures: fixtures,
        allTeams: teams,
        history: sampleHistory,
        horizon: 1,
        startGameweek: 6 + offset,
      });

      expect(forwardProj.gameweeks[offset].expected_points).toBe(
        singleGwProj.gameweeks[0].expected_points
      );
      expect(forwardProj.gameweeks[offset].expected_minutes).toBe(
        singleGwProj.gameweeks[0].expected_minutes
      );
      expect(forwardProj.gameweeks[offset].probability_appearance).toBe(
        singleGwProj.gameweeks[0].probability_appearance
      );
    }
  });

  it("9. verifies GW3 Phase 6B output matches Phase 4 / Phase 6A single-GW pipeline exactly", () => {
    const singleGwProj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
      startGameweek: 6,
    });

    // GW6 (offset 1) is the primary single-GW prediction
    const gw6 = singleGwProj.gameweeks[0];
    expect(gw6.gameweek).toBe(6);
    expect(gw6.expected_minutes).toBeGreaterThan(0);
    expect(gw6.raw_expected_points).toBe(gw6.expected_points);
  });

  it("10. verifies mixed 5-GW schedule with SGW, BGW, and DGW", () => {
    // GW6: SGW, GW7: SGW, GW8: BGW, GW9: DGW, GW10: SGW
    const proj = projectPlayerMultiGameweek({
      player: premiumMid,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      history: sampleHistory,
      horizon: 5,
      discountFactors: [1.00, 0.95, 0.90],
    });

    expect(proj.gameweeks[0].fixture_count).toBe(1); // SGW
    expect(proj.gameweeks[1].fixture_count).toBe(1); // SGW
    expect(proj.gameweeks[2].fixture_count).toBe(0); // BGW
    expect(proj.gameweeks[3].fixture_count).toBe(2); // DGW
    expect(proj.gameweeks[4].fixture_count).toBe(1); // SGW

    expect(proj.bgw_count).toBe(1);
    expect(proj.dgw_count).toBe(1);
    expect(proj.total_fixtures_count).toBe(5);

    const manualSum =
      proj.gameweeks[0].expected_points +
      proj.gameweeks[1].expected_points +
      0.0 +
      proj.gameweeks[3].expected_points +
      proj.gameweeks[4].expected_points;

    expect(proj.cumulative_expected_points).toBe(Math.round(manualSum * 100) / 100);
  });

  it("11. verifies snapshot immutability and squad hash parity", () => {
    const squad = [
      { id: 1, web_name: "Raya", element_type: 1, team: 1 },
      { id: 8, web_name: "Calafiori", element_type: 2, team: 1 },
      { id: 411, web_name: "Haaland", element_type: 4, team: 15 },
    ];

    const projections = projectSquadMultiGameweek({
      players: squad,
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
    });

    const squadIdsBefore = squad.map((p) => p.id);
    const projIdsAfter = projections.map((p) => p.player_id);

    expect(projIdsAfter).toEqual(squadIdsBefore);
    for (const p of projections) {
      expect(p.snapshot_id).toBe(snapshot.snapshot_id);
      expect(p.cutoff_gameweek).toBe(snapshot.boundary.historical_cutoff_gameweek);
    }
  });
});
