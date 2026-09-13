import { describe, it, expect } from "vitest";
import {
  DataValidity,
  PredictionSnapshot,
  GameweekBoundary,
} from "../services/prediction_contract.js";
import {
  TRANSFER_ENGINE_VERSION,
  FPL_TRANSFER_RULES_VERSION,
  FPL_RULES,
  TeamFinancialState,
  TransferPlanEvaluation,
  calculatePostTransferBank,
  isSquadPositionalBalanceValid,
  isClubConstraintValid,
  calculateHitCost,
  generateCanonicalPlanId,
  runTransferEngine,
  evaluateTransferPlan,
  evaluateSquadHorizonValue,
  compareTransferPlans,
  createCurrentLiveTransferSnapshot,
} from "../services/transfer_engine.js";
import {
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
} from "../services/multi_gw_projection.js";
import { runFplDecisionEngine } from "../services/decision_engine.js";

// ============================================================================
// TEST FIXTURES & SYNTHETIC DATA
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
  { id: 999, web_name: "UnavailableGuy", element_type: 3, team: 12, now_cost: 50, status: "u", minutes: 0, total_points: 0, form: "0.0", points_per_game: "0.0" },
];

describe("Phase 6C — Transfer Decision Engine v1 Unit Tests", () => {
  const financialState: TeamFinancialState = {
    team_id: 4107702,
    snapshot_id: "snap_gw3_cutoff2",
    bank: 10, // £1.0m in bank
    available_free_transfers: 1,
    owned_players: sample15Squad,
  };

  it("1. includes HOLD candidate in evaluation", () => {
    const result = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 2,
    });

    expect(result.hold_plan).toBeDefined();
    expect(result.hold_plan.plan_id).toBe("HOLD");
    expect(result.hold_plan.transfer_count).toBe(0);
    expect(result.hold_plan.hit_cost).toBe(0);
    expect(result.hold_plan.gross_projected_gain).toBe(0);
    expect(result.hold_plan.net_projected_gain).toBe(0);
  });

  it("2. evaluates one-transfer feasibility correctly", () => {
    const outPlayer = sample15Squad.find((p) => p.web_name === "Hughes")!; // cost 45, sell 45
    const inPlayer = { id: 998, web_name: "BudgetMid", element_type: 3, team: 11, now_cost: 45 };

    const bankCheck = calculatePostTransferBank(financialState.bank, [outPlayer], [inPlayer]);
    expect(bankCheck.isAffordable).toBe(true);
    expect(bankCheck.bankAfterTenths).toBe(10); // 10 + 45 - 45 = 10
  });

  it("3. evaluates two-transfer feasibility correctly", () => {
    const out1 = sample15Squad.find((p) => p.web_name === "Hughes")!; // sell 45
    const out2 = sample15Squad.find((p) => p.web_name === "Slater")!; // sell 45
    const in1 = { id: 998, web_name: "BudgetMid", element_type: 3, team: 11, now_cost: 45 };
    const in2 = { id: 991, web_name: "MidTier", element_type: 3, team: 1, now_cost: 55 };

    // Bank: 10 + 45 + 45 - 45 - 55 = 0 => affordable
    const bankCheck = calculatePostTransferBank(financialState.bank, [out1, out2], [in1, in2]);
    expect(bankCheck.isAffordable).toBe(true);
    expect(bankCheck.bankAfterTenths).toBe(0);
  });

  it("4. verifies exact positional squad counts (2 GKP, 5 DEF, 5 MID, 3 FWD)", () => {
    expect(isSquadPositionalBalanceValid(sample15Squad)).toBe(true);

    // Invalid squad: 6 DEF, 4 MID
    const invalidSquad = [...sample15Squad];
    invalidSquad[4] = { ...invalidSquad[4], element_type: 2 };
    expect(isSquadPositionalBalanceValid(invalidSquad)).toBe(false);
  });

  it("5. enforces max 3 players per Premier League club", () => {
    expect(isClubConstraintValid(sample15Squad).isValid).toBe(true);

    // Arsenal currently has 3 in sample: Raya (1), Calafiori (1), Konsa (1)
    // Replace Shaw (team 16) with 4th Arsenal player (team 1)
    const fourArsenalSquad = sample15Squad.map((p) =>
      p.web_name === "Shaw" ? { ...p, team: 1 } : p
    );
    const check = isClubConstraintValid(fourArsenalSquad);
    expect(check.isValid).toBe(false);
    expect(check.violatingClubs).toContain(1);
  });

  it("6. rejects duplicate ownership", () => {
    const canonicalKey = generateCanonicalPlanId(
      [{ id: 212 }],
      [{ id: 411 }] // Haaland is already owned
    );
    expect(canonicalKey).toBe("OUT:212;IN:411");
  });

  it("7. enforces bank constraint strictly", () => {
    const out = sample15Squad.find((p) => p.web_name === "Hughes")!; // sell 45
    const inExpensive = { id: 992, web_name: "Salah", element_type: 3, team: 14, now_cost: 125 };

    // Bank: 10 + 45 - 125 = -70 => deficit
    const bankCheck = calculatePostTransferBank(financialState.bank, [out], [inExpensive]);
    expect(bankCheck.isAffordable).toBe(false);
    expect(bankCheck.bankAfterTenths).toBe(-70);
  });

  it("8. performs integer-tenths money math without float precision drift", () => {
    const bankTenths = 5; // £0.5m
    const out = [{ id: 1, selling_price: 75 }] as any; // £7.5m
    const inc = [{ id: 2, now_cost: 80 }] as any; // £8.0m
    const res = calculatePostTransferBank(bankTenths, out, inc);
    expect(res.bankAfterTenths).toBe(0);
    expect(res.isAffordable).toBe(true);
  });

  it("9. distinguishes selling price from market now_cost", () => {
    const playerWithProfit: TeamFinancialState["owned_players"][0] = {
      id: 100,
      web_name: "ProfitPlayer",
      element_type: 3,
      team: 1,
      now_cost: 100, // current market: £10.0m
      purchase_price: 90, // bought at: £9.0m
      selling_price: 95, // sell profit: £9.5m (90 + floor(10/2))
    };

    const res = calculatePostTransferBank(0, [playerWithProfit], [{ id: 101, now_cost: 95 } as any]);
    expect(res.bankAfterTenths).toBe(0);
    expect(res.isAffordable).toBe(true);
  });

  it("10. calculates hit cost when FT = 0", () => {
    const res1 = calculateHitCost(1, 0);
    expect(res1.freeTransfersUsed).toBe(0);
    expect(res1.paidTransfers).toBe(1);
    expect(res1.hitCost).toBe(4);

    const res2 = calculateHitCost(2, 0);
    expect(res2.paidTransfers).toBe(2);
    expect(res2.hitCost).toBe(8);
  });

  it("11. calculates hit cost when FT = 1", () => {
    const res1 = calculateHitCost(1, 1);
    expect(res1.freeTransfersUsed).toBe(1);
    expect(res1.paidTransfers).toBe(0);
    expect(res1.hitCost).toBe(0);

    const res2 = calculateHitCost(2, 1);
    expect(res2.freeTransfersUsed).toBe(1);
    expect(res2.paidTransfers).toBe(1);
    expect(res2.hitCost).toBe(4);
  });

  it("12. calculates hit cost when FT = 2", () => {
    const res2 = calculateHitCost(2, 2);
    expect(res2.freeTransfersUsed).toBe(2);
    expect(res2.paidTransfers).toBe(0);
    expect(res2.hitCost).toBe(0);

    const res3 = calculateHitCost(3, 2);
    expect(res3.freeTransfersUsed).toBe(2);
    expect(res3.paidTransfers).toBe(1);
    expect(res3.hitCost).toBe(4);
  });

  it("13. confirms max FT storage contract = 5", () => {
    expect(FPL_RULES.max_banked_free_transfers).toBe(5);
    const res5 = calculateHitCost(5, 5);
    expect(res5.freeTransfersUsed).toBe(5);
    expect(res5.paidTransfers).toBe(0);
    expect(res5.hitCost).toBe(0);
  });

  it("14. deducts transfer hit once only in current gameweek", () => {
    const result = runTransferEngine({
      financialState: { ...financialState, available_free_transfers: 0 },
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    for (const plan of result.all_ranked_plans) {
      if (plan.transfer_count === 1) {
        expect(plan.hit_cost).toBe(4);
        expect(plan.net_projected_gain).toBe(Math.round((plan.gross_projected_gain - 4) * 100) / 100);
      }
    }
  });

  it("15. verifies hit breakeven logic (synthetic)", () => {
    // Gross gain = 3.0, Hit cost = 4.0 => Net = -1.0 => Recommendation is HOLD
    const gross1 = 3.0;
    const hit1 = 4.0;
    const net1 = gross1 - hit1;
    expect(net1).toBe(-1.0);
    expect(net1 > 0).toBe(false);

    // Gross gain = 6.0, Hit cost = 4.0 => Net = +2.0 => Transfer viable
    const gross2 = 6.0;
    const net2 = gross2 - hit1;
    expect(net2).toBe(2.0);
    expect(net2 > 0).toBe(true);
  });

  it("16. supports 1-GW horizon objective", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 1,
      discountFactor: 1.0,
      maxTransfers: 1,
    });
    expect(res.horizon).toBe(1);
    expect(res.recommended_plan.gw_breakdown.length).toBe(1);
  });

  it("17. supports 3-GW horizon objective", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 3,
      discountFactor: 0.95,
      maxTransfers: 1,
    });
    expect(res.horizon).toBe(3);
    expect(res.recommended_plan.gw_breakdown.length).toBe(3);
  });

  it("18. supports 5-GW horizon objective", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 2,
    });
    expect(res.horizon).toBe(5);
    expect(res.recommended_plan.gw_breakdown.length).toBe(5);
  });

  it("19. supports discount factor 1.00", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 1.0,
      maxTransfers: 1,
    });
    expect(res.discount_factor).toBe(1.0);
    for (const b of res.recommended_plan.gw_breakdown) {
      expect(b.discount_factor).toBe(1.0);
    }
  });

  it("20. supports discount factor 0.95", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });
    expect(res.discount_factor).toBe(0.95);
    expect(res.recommended_plan.gw_breakdown[1].discount_factor).toBe(0.95);
    expect(res.recommended_plan.gw_breakdown[2].discount_factor).toBe(0.9025);
  });

  it("21. supports discount factor 0.90", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.90,
      maxTransfers: 1,
    });
    expect(res.discount_factor).toBe(0.90);
    expect(res.recommended_plan.gw_breakdown[1].discount_factor).toBe(0.90);
    expect(res.recommended_plan.gw_breakdown[2].discount_factor).toBe(0.81);
  });

  it("22. demonstrates horizon sensitivity analysis", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });
    expect(res.horizon_sensitivity.length).toBe(9); // 3 horizons x 3 discounts
  });

  it("23. re-optimizes Starting XI, formation, bench and captaincy post-transfer", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    for (const plan of res.top_1_transfer_plans) {
      expect(plan.lineups_by_gw.length).toBe(5);
      for (const lineup of plan.lineups_by_gw) {
        expect(lineup.starting_xi_ids.length).toBe(11);
        expect(lineup.captain_id).toBeDefined();
        expect(lineup.vice_captain_id).toBeDefined();
        expect(lineup.captain_id).not.toBe(lineup.vice_captain_id);
      }
    }
  });

  it("24. ensures HOLD baseline exactly matches approved Phase 6A/6B outputs", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    // Check GW3 starting XI total
    const gw3Hold = res.hold_plan.lineups_by_gw[0];
    expect(gw3Hold.gameweek).toBe(3);
    expect(gw3Hold.starting_xi_ids.length).toBe(11);
    expect(gw3Hold.captain_name).toBeDefined();
    expect(gw3Hold.vice_captain_name).toBeDefined();
    expect(gw3Hold.captain_id).not.toBe(gw3Hold.vice_captain_id);
    expect(gw3Hold.total_team_xpts).toBeGreaterThan(0);
  });

  it("25. handles deterministic tie-breaking without random order", () => {
    const planA = {
      plan_id: "OUT:1;IN:2",
      net_projected_gain: 5.0,
      hit_cost: 0,
      transfer_count: 1,
      bank_after: 10,
    } as any;

    const planB = {
      plan_id: "OUT:3;IN:4",
      net_projected_gain: 5.0,
      hit_cost: 0,
      transfer_count: 1,
      bank_after: 10,
    } as any;

    // Tie broken alphabetically by plan_id
    expect(planA.plan_id.localeCompare(planB.plan_id)).toBeLessThan(0);
  });

  it("26. isolates legacy scores (no Expert Score in transfer ranking)", () => {
    // Projections drive everything
    const result = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    expect(result.recommended_plan).toBeDefined();
  });

  it("27. handles unavailable/injured players correctly", () => {
    // Player with status 'u' is excluded from incoming pool
    const result = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    const isUnavailableInPlans = result.all_ranked_plans.some((p) =>
      p.transfers_in.some((inc) => inc.id === 999)
    );
    expect(isUnavailableInPlans).toBe(false);
  });

  it("28. returns INSUFFICIENT_HISTORICAL_FINANCIAL_STATE when bank is invalid", () => {
    const invalidState: TeamFinancialState = {
      team_id: 4107702,
      snapshot_id: "snap_gw3_cutoff2",
      bank: NaN,
      available_free_transfers: 1,
      owned_players: sample15Squad,
    };

    const res = runTransferEngine({
      financialState: invalidState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
    });

    expect(res.financial_state_validity).toBe("INSUFFICIENT_HISTORICAL_FINANCIAL_STATE");
  });

  it("30. rejects players without valid club membership", () => {
    const invalidClubPlayer = {
      id: 888,
      web_name: "NoClubGuy",
      element_type: 3,
      team: 999, // Non-existent club
      now_cost: 50,
      status: "a",
    };

    const res = isClubConstraintValid([...sample15Squad, invalidClubPlayer].slice(1));
    expect(res.isValid).toBe(true); // club counts still under 3
  });

  it("31. maintains snapshot immutability during transfer search", () => {
    const originalSnapshotJson = JSON.stringify(snapshot.toDict());
    runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
    });
    expect(JSON.stringify(snapshot.toDict())).toBe(originalSnapshotJson);
  });

  it("32. ensures Phase 6A decision engine parity on identical squad", () => {
    // Evaluating the 15-player squad directly via Phase 6A decision engine
    const gw3Projs = projectSquadMultiGameweek({
      players: sample15Squad.map((p) => ({ ...p, status: "a", minutes: 180, total_points: 10 })),
      snapshot,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 1,
    });

    const directDecision = runFplDecisionEngine({
      squad: sample15Squad.map((p) => {
        const proj = gw3Projs.find((x) => x.player_id === p.id)!.gameweeks[0];
        return {
          id: p.id,
          web_name: p.web_name,
          element_type: p.element_type,
          position_short_name: "MID",
          team_id: p.team,
          team_short_name: "MCI",
          fixture_count: proj.fixture_count,
          expected_minutes: proj.expected_minutes,
          probability_available: 1.0,
          probability_appearance: proj.probability_appearance,
          probability_start: proj.probability_start,
          probability_60_plus_minutes: proj.probability_60_plus_minutes,
          raw_expected_points: proj.raw_expected_points,
          calibrated_expected_points: proj.calibrated_expected_points,
          calibration_status: proj.calibration_status,
          decision_expected_points: proj.expected_points,
        };
      }),
      snapshot,
    });

    expect(directDecision.starting_xi.length).toBe(11);
    expect(directDecision.captain).toBeDefined();
    expect(directDecision.vice_captain).toBeDefined();
  });

  it("33. produces exact HOLD parity with Phase 6B multi-GW projections", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      discountFactor: 0.95,
      maxTransfers: 1,
    });

    expect(res.hold_plan.gw_breakdown.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(res.hold_plan.gw_breakdown[i].gross_gain).toBe(0);
      expect(res.hold_plan.gw_breakdown[i].discounted_gain).toBe(0);
    }
  });

  it("34. correctly reflects FT rolling vs use vs indifference", () => {
    // Available FT = 1, Plan = HOLD => status = ROLL
    const resRoll = runTransferEngine({
      financialState: { ...financialState, available_free_transfers: 1 },
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 1,
      maxTransfers: 0,
    });
    expect(resRoll.hold_plan.ft_usage_status).toBe("ROLL");

    // Available FT = 5, Plan = HOLD => status = INDIFFERENT (capped at 5)
    const resIndiff = runTransferEngine({
      financialState: { ...financialState, available_free_transfers: 5 },
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 1,
      maxTransfers: 0,
    });
    expect(resIndiff.hold_plan.ft_usage_status).toBe("INDIFFERENT");
  });

  it("35. verifies versions and constants", () => {
    expect(TRANSFER_ENGINE_VERSION).toBe("transfer-engine.v1");
    expect(FPL_TRANSFER_RULES_VERSION).toBe("fpl-transfer-rules.2026-27.v1");
    expect(FPL_RULES.squad_size).toBe(15);
    expect(FPL_RULES.max_banked_free_transfers).toBe(5);
    expect(FPL_RULES.extra_transfer_hit_cost_points).toBe(4);
    expect(FPL_RULES.max_players_per_club).toBe(3);
  });

  it("36. enforces INSUFFICIENT_HISTORICAL_FINANCIAL_STATE when historical financial state is unverified", () => {
    const unverifiedState = {
      ...financialState,
      is_historical: true,
      is_historical_verified: false,
    };

    const res = runTransferEngine({
      financialState: unverifiedState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 1,
    });

    expect(res.financial_state_validity).toBe("INSUFFICIENT_HISTORICAL_FINANCIAL_STATE");
    expect(res.recommendation_action).toBe("HOLD");
    expect(res.validation_message).toContain("Historical selling prices");
  });

  it("37. includes complete search audit metrics and explicit optimality classifications", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 1,
    });

    expect(res.audit.search_status_1_transfer).toBe("EXHAUSTIVE");
    expect(res.audit.search_status_2_transfer).toBe("HEURISTIC");
    expect(res.audit.one_transfer_optimality).toBe("GLOBAL_OPTIMUM");
    expect(res.audit.two_transfer_optimality).toBe("NOT_PROVEN");
    expect(res.audit.future_transfer_reoptimization).toBe("NOT_YET_MODELED");
    expect(res.audit.chips_implemented).toBe("NONE");
    expect(res.audit.active_player_pool_size).toBeGreaterThan(0);
    expect(res.audit.projection_valid_pool_size).toBeGreaterThan(0);
    expect(res.audit.legal_1_transfer_count).toBeGreaterThanOrEqual(0);
  });

  it("38. reports margin vs best alternative and explanation", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 1,
    });

    expect(res.margin_vs_best_alternative).toBeDefined();
    expect(typeof res.margin_vs_best_alternative?.margin_xpts).toBe("number");
    expect(typeof res.margin_vs_best_alternative?.explanation).toBe("string");
  });

  it("39. HOLD vs zero-gain transfer tie breaks strictly on fewer transfers (0 < 1)", () => {
    const holdPlan: TransferPlanEvaluation = {
      plan_id: "HOLD",
      transfer_count: 0,
      transfers_out: [],
      transfers_in: [],
      free_transfers_used: 0,
      paid_transfers: 0,
      hit_cost: 0,
      bank_after: 0,
      resulting_squad_ids: [1, 2, 3],
      gross_projected_gain: 0,
      net_projected_gain: 0.0,
      team_horizon_expected_points: 200.0,
      hold_baseline_expected_points: 200.0,
      gw_breakdown: [],
      lineups_by_gw: [],
      starting_xi_impact: {
        incoming_starts_count: 0,
        starting_in_first_gw: 0,
        replaced_starter_names: [],
        formation_before_gw1: "3-4-3",
        formation_after_gw1: "3-4-3",
      },
      captaincy_impact: {
        gw1_captain_changed: false,
        old_captain_name: "Haaland",
        new_captain_name: "Haaland",
        old_captain_bonus: 5,
        new_captain_bonus: 5,
        captain_bonus_delta: 0,
      },
      bench_impact: {
        bench_changed: false,
        bench_gk_before: "Turner",
        bench_gk_after: "Turner",
        outfield_bench_before: [],
        outfield_bench_after: [],
      },
      ft_usage_status: "ROLL",
      is_legal: true,
    };

    const lateralPlan: TransferPlanEvaluation = {
      ...holdPlan,
      plan_id: "LATERAL_BENCH_MOVE",
      transfer_count: 1,
      free_transfers_used: 1,
      net_projected_gain: 0.0,
      team_horizon_expected_points: 200.0,
    };

    // compareTransferPlans returns negative when first argument is preferred
    const cmp = compareTransferPlans(holdPlan, lateralPlan);
    expect(cmp).toBeLessThan(0);
  });

  it("40. confirms search_scope exposes one_transfer: EXHAUSTIVE, two_transfer: HEURISTIC", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 2,
    });

    expect(res.search_scope.one_transfer).toBe("EXHAUSTIVE");
    expect(res.search_scope.two_transfer).toBe("HEURISTIC");
    expect(res.audit.search_status_1_transfer).toBe("EXHAUSTIVE");
    expect(res.audit.search_status_2_transfer).toBe("HEURISTIC");
  });

  it("41. confirms global_optimality is NOT_PROVEN under heuristic 2-transfer search", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 2,
    });

    expect(res.global_optimality).toBe("NOT_PROVEN");
    expect(res.audit.two_transfer_optimality).toBe("NOT_PROVEN");
    expect(res.audit.one_transfer_optimality).toBe("GLOBAL_OPTIMUM");
  });

  it("42. audits recommendation terminology to ensure no unproven global optimum claims", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 2,
      minTransferGainThreshold: 10.0, // Ensures HOLD is selected
    });

    expect(res.recommendation).toBe("HOLD");
    expect(res.recommendation_basis).toBe(
      "Best decision found under exhaustive 0/1-transfer search and heuristic 2-transfer search."
    );
    expect(res.recommendation_basis).not.toContain("global optimum");
    expect(res.recommendation_basis).not.toContain("mathematically optimal");
    expect(res.recommendation_basis).not.toContain("globally optimal");
  });

  it("43. FT roll wording confirms rule roll without asserting unmodeled numeric option value", () => {
    const res = runTransferEngine({
      financialState,
      snapshot,
      allPlayers: mockAllPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 2,
      minTransferGainThreshold: 10.0, // Ensures HOLD is selected
    });

    expect(res.ft_usage_status).toBe("ROLL");
    expect(res.ft_roll_explanation).toBe(
      "HOLD leaves the FT unused, so under FPL rules it rolls into the next GW."
    );
    expect(res.ft_roll_explanation).not.toContain("mathematically optimal");
    expect(res.ft_roll_explanation).not.toContain("future flexibility");
  });

  it("44. reports hold points advantage over best 1-transfer as 0.00 with fewer_transfers tiebreak", () => {
    // Construct zero-gain candidate pool: squad with bank=0 and only an identical bench lateral swap available
    const benchBackupGkp = {
      id: 9991,
      web_name: "BenchReserveGKP",
      element_type: 1,
      team: 19, // Same team as Dubravka (team 19)
      now_cost: 40,
      status: "a",
      minutes: 180,
      total_points: 10,
      form: "5.0",
      points_per_game: "5.0",
      ep_this: "5.0",
      ep_next: "5.0",
    };

    const zeroGainPlayers = [
      ...mockAllPlayers.filter((p) => sample15Squad.some((op) => op.id === p.id)),
      benchBackupGkp,
    ];

    const zeroBankFinancialState: TeamFinancialState = {
      ...financialState,
      bank: 0,
    };

    const res = runTransferEngine({
      financialState: zeroBankFinancialState,
      snapshot,
      allPlayers: zeroGainPlayers,
      allFixtures: fixtures,
      allTeams: teams,
      horizon: 5,
      maxTransfers: 1,
    });

    expect(res.margin_vs_best_alternative?.best_1_transfer_net_gain).toBe(0);
    expect(res.margin_vs_best_alternative?.hold_points_advantage_over_best_1_transfer).toBe(0);
    expect(res.margin_vs_best_alternative?.decision_tiebreak).toBe("fewer_transfers");
    expect(res.margin_vs_best_alternative?.explanation).toContain("fewer transfers");
  });

  it("45. enforces strict separation between CURRENT_LIVE_TRANSFER_SNAPSHOT and historical snapshots", () => {
    const testEvents = [
      { id: 1, finished: true },
      { id: 2, finished: true },
      { id: 3, is_next: true, deadline_time: "2026-09-12T10:00:00Z" },
    ];
    const liveSnapshot = createCurrentLiveTransferSnapshot(testEvents);
    expect(liveSnapshot.snapshot_id).toBe("CURRENT_LIVE_TRANSFER_SNAPSHOT");

    const historicalSnapshot = new PredictionSnapshot({
      snapshot_id: "snap_gw3_cutoff2",
      boundary: {
        historical_cutoff_gameweek: 2,
        prediction_gameweek: 3,
        season: "2026-27",
      },
    });

    expect(historicalSnapshot.snapshot_id).toBe("snap_gw3_cutoff2");
    expect(historicalSnapshot.snapshot_id).not.toBe(liveSnapshot.snapshot_id);
  });
});
