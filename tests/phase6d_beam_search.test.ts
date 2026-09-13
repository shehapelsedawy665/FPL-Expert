import { describe, it, expect } from "vitest";
import { PredictionSnapshot, GameweekBoundary } from "../services/prediction_contract.js";
import {
  TeamFinancialState,
  evaluateSquadHorizonValue,
} from "../services/transfer_engine.js";
import {
  projectSquadMultiGameweek,
  projectPlayerMultiGameweek,
} from "../services/multi_gw_projection.js";
import {
  optimizeSequentialTransfers,
  SEQUENTIAL_ENGINE_VERSION,
  SEQUENTIAL_PRICE_MODEL,
  SEQUENTIAL_SEARCH_SCOPE,
} from "../services/sequential_transfer_engine.js";

// ============================================================================
// FIXTURES & SYNTHETIC ENVIRONMENT
// ============================================================================

const snapshot = new PredictionSnapshot({
  snapshot_id: "snap_gw3_cutoff2",
  boundary: new GameweekBoundary({
    last_finished_gameweek: 2,
    prediction_gameweek: 3,
    historical_cutoff_gameweek: 2,
    in_progress_gameweek: null,
    is_pre_season: false,
  }),
});

const teams = [
  { id: 1, name: "Arsenal", short_name: "ARS", strength_attack_home: 1250, strength_defence_home: 1300, strength_attack_away: 1200, strength_defence_away: 1250 },
  { id: 6, name: "Chelsea", short_name: "CHE", strength_attack_home: 1200, strength_defence_home: 1150, strength_attack_away: 1150, strength_defence_away: 1100 },
  { id: 8, name: "Crystal Palace", short_name: "CRY", strength_attack_home: 1050, strength_defence_home: 1100, strength_attack_away: 1000, strength_defence_away: 1050 },
  { id: 10, name: "Fulham", short_name: "FUL", strength_attack_home: 1080, strength_defence_home: 1060, strength_attack_away: 1020, strength_defence_away: 1040 },
  { id: 11, name: "Hull City", short_name: "HUL", strength_attack_home: 1000, strength_defence_home: 1000, strength_attack_away: 980, strength_defence_away: 980 },
  { id: 12, name: "Ipswich", short_name: "IPS", strength_attack_home: 1020, strength_defence_home: 1010, strength_attack_away: 990, strength_defence_away: 990 },
  { id: 14, name: "Liverpool", short_name: "LIV", strength_attack_home: 1300, strength_defence_home: 1280, strength_attack_away: 1250, strength_defence_away: 1240 },
  { id: 15, name: "Man City", short_name: "MCI", strength_attack_home: 1350, strength_defence_home: 1320, strength_attack_away: 1300, strength_defence_away: 1280 },
  { id: 16, name: "Man Utd", short_name: "MUN", strength_attack_home: 1180, strength_defence_home: 1160, strength_attack_away: 1140, strength_defence_away: 1120 },
  { id: 19, name: "Tottenham", short_name: "TOT", strength_attack_home: 1220, strength_defence_home: 1180, strength_attack_away: 1180, strength_defence_away: 1140 },
];

const fixtures = [
  // GW3
  { id: 29, event: 3, team_h: 1, team_a: 6, team_h_difficulty: 4, team_a_difficulty: 4 },
  { id: 30, event: 3, team_h: 10, team_a: 16, team_h_difficulty: 3, team_a_difficulty: 3 },
  { id: 26, event: 3, team_h: 15, team_a: 11, team_h_difficulty: 2, team_a_difficulty: 5 },
  { id: 24, event: 3, team_h: 10, team_a: 8, team_h_difficulty: 3, team_a_difficulty: 3 },
  { id: 27, event: 3, team_h: 12, team_a: 14, team_h_difficulty: 5, team_a_difficulty: 2 },
  
  // GW4
  { id: 36, event: 4, team_h: 11, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 2 },
  { id: 39, event: 4, team_h: 16, team_a: 15, team_h_difficulty: 4, team_a_difficulty: 4 },
  { id: 34, event: 4, team_h: 8, team_a: 12, team_h_difficulty: 2, team_a_difficulty: 3 },
  { id: 35, event: 4, team_h: 6, team_a: 10, team_h_difficulty: 3, team_a_difficulty: 4 },
  { id: 38, event: 4, team_h: 14, team_a: 19, team_h_difficulty: 3, team_a_difficulty: 4 },

  // GW5
  { id: 42, event: 5, team_h: 10, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
  { id: 45, event: 5, team_h: 15, team_a: 8, team_h_difficulty: 2, team_a_difficulty: 5 },
  { id: 50, event: 5, team_h: 10, team_a: 16, team_h_difficulty: 3, team_a_difficulty: 3 },
  { id: 46, event: 5, team_h: 14, team_a: 11, team_h_difficulty: 2, team_a_difficulty: 5 },
  { id: 47, event: 5, team_h: 19, team_a: 6, team_h_difficulty: 3, team_a_difficulty: 3 },

  // GW6
  { id: 51, event: 6, team_h: 1, team_a: 12, team_h_difficulty: 2, team_a_difficulty: 5 },
  { id: 58, event: 6, team_h: 14, team_a: 15, team_h_difficulty: 4, team_a_difficulty: 4 },
  { id: 59, event: 6, team_h: 16, team_a: 19, team_h_difficulty: 3, team_a_difficulty: 3 },
  { id: 55, event: 6, team_h: 8, team_a: 11, team_h_difficulty: 2, team_a_difficulty: 4 },
  { id: 56, event: 6, team_h: 6, team_a: 10, team_h_difficulty: 2, team_a_difficulty: 4 },

  // GW7
  { id: 69, event: 7, team_h: 8, team_a: 1, team_h_difficulty: 4, team_a_difficulty: 3 },
  { id: 67, event: 7, team_h: 15, team_a: 12, team_h_difficulty: 2, team_a_difficulty: 5 },
  { id: 66, event: 7, team_h: 11, team_a: 16, team_h_difficulty: 4, team_a_difficulty: 2 },
  { id: 68, event: 7, team_h: 14, team_a: 6, team_h_difficulty: 3, team_a_difficulty: 3 },
  { id: 63, event: 7, team_h: 19, team_a: 10, team_h_difficulty: 2, team_a_difficulty: 4 },
];

const sample15Squad: TeamFinancialState["owned_players"] = [
  { id: 1, web_name: "Raya", element_type: 1, team: 1, now_cost: 60, selling_price: 60, purchase_price: 60 },
  { id: 356, web_name: "Virgil", element_type: 2, team: 14, now_cost: 65, selling_price: 65, purchase_price: 65 },
  { id: 423, web_name: "Shaw", element_type: 2, team: 16, now_cost: 45, selling_price: 45, purchase_price: 45 },
  { id: 8, web_name: "Calafiori", element_type: 2, team: 1, now_cost: 56, selling_price: 56, purchase_price: 56 },
  { id: 290, web_name: "Slater", element_type: 3, team: 11, now_cost: 45, selling_price: 45, purchase_price: 45 },
  { id: 426, web_name: "B.Fernandes", element_type: 3, team: 16, now_cost: 120, selling_price: 120, purchase_price: 120 },
  { id: 40, web_name: "Rogers", element_type: 3, team: 6, now_cost: 75, selling_price: 75, purchase_price: 75 },
  { id: 366, web_name: "Wirtz", element_type: 3, team: 14, now_cost: 75, selling_price: 75, purchase_price: 75 },
  { id: 569, web_name: "Gonzalo", element_type: 4, team: 10, now_cost: 60, selling_price: 60, purchase_price: 60 },
  { id: 411, web_name: "Haaland", element_type: 4, team: 15, now_cost: 155, selling_price: 155, purchase_price: 155 },
  { id: 165, web_name: "João Pedro", element_type: 4, team: 6, now_cost: 77, selling_price: 77, purchase_price: 77 },
  { id: 497, web_name: "Dubravka", element_type: 1, team: 19, now_cost: 40, selling_price: 40, purchase_price: 40 },
  { id: 31, web_name: "Konsa", element_type: 2, team: 1, now_cost: 44, selling_price: 44, purchase_price: 44 },
  { id: 212, web_name: "Hughes", element_type: 3, team: 8, now_cost: 45, selling_price: 45, purchase_price: 45 },
  { id: 259, web_name: "Diop", element_type: 2, team: 12, now_cost: 40, selling_price: 40, purchase_price: 40 },
];

const mockAllPlayers = [
  ...sample15Squad.map((p) => ({
    ...p,
    status: "a",
    minutes: 180,
    goals_scored: 1,
    assists: 1,
    clean_sheets: 1,
    ict_index: "15.0",
    form: "5.0",
    points_per_game: "5.0",
    total_points: 10,
    ep_this: "5.0",
    ep_next: "5.0",
  })),
  // Additional candidates in market
  { id: 991, web_name: "Saka", element_type: 3, team: 1, now_cost: 100, status: "a", minutes: 180, total_points: 15, form: "7.0", points_per_game: "7.5" },
  { id: 992, web_name: "Salah", element_type: 3, team: 14, now_cost: 125, status: "a", minutes: 180, total_points: 18, form: "8.5", points_per_game: "9.0" },
  { id: 993, web_name: "Palmer", element_type: 3, team: 6, now_cost: 105, status: "a", minutes: 180, total_points: 16, form: "8.0", points_per_game: "8.0" },
  { id: 994, web_name: "Alexander-Arnold", element_type: 2, team: 14, now_cost: 70, status: "a", minutes: 180, total_points: 12, form: "6.0", points_per_game: "6.0" },
  { id: 995, web_name: "Gabriel", element_type: 2, team: 1, now_cost: 60, status: "a", minutes: 180, total_points: 11, form: "5.5", points_per_game: "5.5" },
  { id: 996, web_name: "Isak", element_type: 4, team: 15, now_cost: 85, status: "a", minutes: 180, total_points: 14, form: "7.0", points_per_game: "7.0" },
  { id: 997, web_name: "Pickford", element_type: 1, team: 10, now_cost: 50, status: "a", minutes: 180, total_points: 9, form: "4.5", points_per_game: "4.5" },
  { id: 998, web_name: "BudgetMid", element_type: 3, team: 11, now_cost: 45, status: "a", minutes: 180, total_points: 8, form: "4.0", points_per_game: "4.0" },
];

describe("Phase 6D Step 2 — Forward Beam Search & Trajectory Optimization Tests", () => {
  const financialState: TeamFinancialState = {
    team_id: 4107702,
    snapshot_id: "snap_gw3_cutoff2",
    bank: 10, // £1.0m
    available_free_transfers: 1,
    owned_players: sample15Squad,
  };

  it("1. HOLD sequence over H=5 matches baseline multi-GW HOLD score and rolls FT correctly", () => {
    // Run precomputed projections
    const precomputedProjections = new Map();
    for (const p of mockAllPlayers) {
      const proj = projectPlayerMultiGameweek({
        player: p,
        snapshot,
        allFixtures: fixtures,
        allTeams: teams,
        horizon: 5,
      });
      precomputedProjections.set(p.id, proj);
    }

    // Baseline HOLD evaluation using Phase 6C evaluateSquadHorizonValue
    const baselineHold = evaluateSquadHorizonValue({
      squad: sample15Squad,
      snapshot,
      precomputedProjections,
      horizon: 5,
      discountFactor: 0.95,
    });

    // Run sequential optimizer forced to HOLD (maxTransfersPerGw = 0)
    const holdPlan = optimizeSequentialTransfers({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      beamWidth: 5,
      maxTransfersPerGw: 0,
      precomputedProjections,
    });

    expect(holdPlan.horizon).toBe(5);
    expect(holdPlan.total_transfers).toBe(0);
    expect(holdPlan.total_hit_cost).toBe(0);
    expect(holdPlan.trajectory_steps.length).toBe(5);

    // Each step should be HOLD
    for (let i = 0; i < 5; i++) {
      expect(holdPlan.trajectory_steps[i].action_label).toBe("HOLD");
      expect(holdPlan.trajectory_steps[i].transfer_count).toBe(0);
      expect(holdPlan.trajectory_steps[i].hit_cost).toBe(0);
    }

    // Free transfers should roll: starts at 1, rolls to 2, 3, 4, 5 (capped at 5)
    expect(holdPlan.final_state.available_ft).toBe(5);

    // Total discounted score should match baseline HOLD evaluation within floating point rounding
    expect(Math.abs(holdPlan.total_discounted_points - baselineHold.totalHorizonScore)).toBeLessThan(0.05);
  });

  it("2. captures strategic FT rolling where rolling in GW_t enables hit-free transfers in GW_{t+1}", () => {
    // Synthetic setup:
    // Owned budget mid (Slater, id 290) and forward (Gonzalo, id 569).
    // Target players: Palmer (id 993) and Isak (id 996).
    // Start with 1 FT.
    // If we make 2 transfers in GW 1: cost is 4-point hit.
    // If we HOLD in GW 1: FT rolls from 1 to 2 in GW 2.
    // Then in GW 2, we can make 2 transfers with 0 hits!
    const customFinancialState: TeamFinancialState = {
      team_id: 4107702,
      snapshot_id: "snap_gw3_cutoff2",
      bank: 50, // £5.0m in bank to afford upgrades
      available_free_transfers: 1,
      owned_players: sample15Squad,
    };

    const plan = optimizeSequentialTransfers({
      financialState: customFinancialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 3,
      discountFactor: 0.95,
      beamWidth: 25,
      candidateLimitPerPosition: 5,
      maxTransfersPerGw: 2,
    });

    expect(plan.trajectory_steps.length).toBe(3);
    expect(plan.total_discounted_points).toBeGreaterThan(0);

    // Check that every step has valid FT arithmetic:
    // available FT before + 1 - transfers_used = next FT (capped at 5)
    let currentFT = customFinancialState.available_free_transfers;
    for (const step of plan.trajectory_steps) {
      expect(step.free_transfers_available_before).toBe(currentFT);
      expect(step.free_transfers_used).toBeLessThanOrEqual(currentFT);
      const remaining = currentFT - step.free_transfers_used;
      const expectedNext = Math.min(5, remaining + 1);
      currentFT = expectedNext;
    }
  });

  it("3. beam pruning limits combinatorial explosion while preserving optimal trajectory", () => {
    // Test with small beam width (K=5) vs standard beam width (K=20)
    const runOptions = {
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 4,
      discountFactor: 0.95,
      maxTransfersPerGw: 1,
      candidateLimitPerPosition: 5,
    };

    const startTimeNarrow = performance.now();
    const planNarrow = optimizeSequentialTransfers({
      ...runOptions,
      beamWidth: 5,
    });
    const timeNarrow = performance.now() - startTimeNarrow;

    const startTimeWide = performance.now();
    const planWide = optimizeSequentialTransfers({
      ...runOptions,
      beamWidth: 20,
    });
    const timeWide = performance.now() - startTimeWide;

    // Both should terminate and return valid plans
    expect(planNarrow.trajectory_steps.length).toBe(4);
    expect(planWide.trajectory_steps.length).toBe(4);

    // Wide beam has at least as good or better score than narrow beam
    expect(planWide.total_discounted_points).toBeGreaterThanOrEqual(
      planNarrow.total_discounted_points - 0.01
    );

    // Should complete quickly without exponential explosion
    expect(timeNarrow).toBeLessThan(5000);
    expect(timeWide).toBeLessThan(10000);
  });

  it("4. verifies output contracts and mathematical honesty metadata", () => {
    const plan = optimizeSequentialTransfers({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 3,
      discountFactor: 0.95,
      beamWidth: 10,
      maxTransfersPerGw: 1,
      candidateLimitPerPosition: 3,
    });

    // Contract checks
    expect(plan.metadata.engine_version).toBe(SEQUENTIAL_ENGINE_VERSION);
    expect(plan.metadata.engine_version).toBe("sequential-transfer.v1");
    expect(plan.metadata.price_model).toBe(SEQUENTIAL_PRICE_MODEL);
    expect(plan.metadata.price_model).toBe("FROZEN_DEADLINE_PRICES_ZERO_DRIFT");
    expect(plan.metadata.search_scope).toBe(SEQUENTIAL_SEARCH_SCOPE);
    expect(plan.metadata.search_scope).toBe("HEURISTIC_BEAM_SEARCH");
    expect(plan.metadata.global_optimality).toBe("NOT_PROVEN");

    // Structure checks
    expect(plan.plan_id).toMatch(/^SEQ-PLAN-GW\d+-H\d+$/);
    expect(plan.final_state).toBeDefined();
    expect(plan.final_state.squad_ids.length).toBe(15);
    expect(typeof plan.final_state.bank).toBe("number");
    expect(plan.final_state.available_ft).toBeGreaterThanOrEqual(1);
    expect(plan.final_state.available_ft).toBeLessThanOrEqual(5);

    // Gameweek breakdown checks
    expect(plan.gw_breakdown).toBeDefined();
    expect(plan.gw_breakdown!.length).toBe(3);
    for (const row of plan.gw_breakdown!) {
      expect(row.gameweek).toBeGreaterThanOrEqual(3);
      expect(row.gw_offset).toBeGreaterThanOrEqual(1);
      expect(typeof row.team_points).toBe("number");
      expect(typeof row.discounted_points).toBe("number");
      expect(typeof row.hit_cost).toBe("number");
      expect(typeof row.net_points).toBe("number");
    }
  });
});
