import { describe, it, expect } from "vitest";
import {
  SEQUENTIAL_ENGINE_VERSION,
  SEQUENTIAL_PRICE_MODEL,
  SEQUENTIAL_SEARCH_SCOPE,
  SEQUENTIAL_FPL_RULES_VERSION,
  nextGameweekFT,
  calculateHitCost,
  applyZeroDriftBudget,
  isStateDominated,
  TrajectoryNode,
  SequentialState,
} from "../services/sequential_transfer_engine.js";
import { FPL_RULES } from "../services/transfer_engine.js";

describe("Phase 6D — Step 1: State Machine & FT Transition Engine", () => {
  describe("1. Metadata and Engine Version Contracts", () => {
    it("exposes sequential engine version and frozen price model contract", () => {
      expect(SEQUENTIAL_ENGINE_VERSION).toBe("sequential-transfer.v1");
      expect(SEQUENTIAL_PRICE_MODEL).toBe("FROZEN_DEADLINE_PRICES_ZERO_DRIFT");
      expect(SEQUENTIAL_SEARCH_SCOPE).toBe("HEURISTIC_BEAM_SEARCH");
      expect(SEQUENTIAL_FPL_RULES_VERSION).toBe("fpl-transfer-rules.2026-27.v1");
    });
  });

  describe("2. Free Transfer (FT) Accumulation & Rolling Dynamics", () => {
    it("rolls 1 FT to 2 FT when 0 transfers are made (HOLD)", () => {
      const nextFT = nextGameweekFT(1, 0);
      expect(nextFT).toBe(2);
    });

    it("rolls 2 FT to 3 FT when 0 transfers are made", () => {
      const nextFT = nextGameweekFT(2, 0);
      expect(nextFT).toBe(3);
    });

    it("rolls 4 FT to 5 FT when 0 transfers are made", () => {
      const nextFT = nextGameweekFT(4, 0);
      expect(nextFT).toBe(5);
    });

    it("caps accumulated FT at exactly 5 (2026/27 rule: max 5 FTs)", () => {
      const nextFT = nextGameweekFT(5, 0);
      expect(nextFT).toBe(5);
    });

    it("enforces minimum lower bound of 1 FT for next gameweek", () => {
      // If current FT was somehow 0 or less, rule bounds it and awards 1 for next GW
      expect(nextGameweekFT(0, 0)).toBe(2);
      expect(nextGameweekFT(1, 1)).toBe(1);
    });
  });

  describe("3. FT Consumption and Carry-Forward", () => {
    it("resets to 1 FT when 1 transfer is made with 1 FT available", () => {
      // 1 used, 0 remaining + 1 awarded = 1 FT
      const nextFT = nextGameweekFT(1, 1);
      expect(nextFT).toBe(1);
    });

    it("carries 2 FT forward when 1 transfer is made with 2 FT available", () => {
      // 2 available, 1 used -> 1 remaining + 1 awarded = 2 FT
      const nextFT = nextGameweekFT(2, 1);
      expect(nextFT).toBe(2);
    });

    it("carries 4 FT forward when 1 transfer is made with 4 FT available", () => {
      // 4 available, 1 used -> 3 remaining + 1 awarded = 4 FT
      const nextFT = nextGameweekFT(4, 1);
      expect(nextFT).toBe(4);
    });

    it("resets to 1 FT when all available FTs are consumed", () => {
      expect(nextGameweekFT(3, 3)).toBe(1);
      expect(nextGameweekFT(5, 5)).toBe(1);
    });

    it("resets to 1 FT when transfers exceed available FTs (hits taken)", () => {
      // 1 FT available, 3 transfers taken -> all FT consumed, 1 awarded for next GW
      expect(nextGameweekFT(1, 3)).toBe(1);
      expect(nextGameweekFT(2, 4)).toBe(1);
    });
  });

  describe("4. Hit Penalty Calculation", () => {
    it("charges 0 penalty when transfers <= available FT", () => {
      expect(calculateHitCost(0, 1)).toBe(0);
      expect(calculateHitCost(1, 1)).toBe(0);
      expect(calculateHitCost(1, 2)).toBe(0);
      expect(calculateHitCost(2, 2)).toBe(0);
      expect(calculateHitCost(3, 5)).toBe(0);
    });

    it("charges 4 points for 1 excess transfer (-4)", () => {
      expect(calculateHitCost(2, 1)).toBe(4);
      expect(calculateHitCost(1, 0)).toBe(4);
    });

    it("charges 8 points for 2 excess transfers (-8)", () => {
      expect(calculateHitCost(3, 1)).toBe(8);
      expect(calculateHitCost(4, 2)).toBe(8);
    });

    it("charges 16 points for 4 excess transfers (-16)", () => {
      expect(calculateHitCost(5, 1)).toBe(16);
    });
  });

  describe("5. Zero-Drift Bank Arithmetic (Integer Tenths)", () => {
    it("calculates exact single-transfer bank delta without float precision error", () => {
      // bank 0.1, sell 4.4, buy 4.5 -> 0.1 + 4.4 - 4.5 = 0.0
      const res = applyZeroDriftBudget(0.1, [4.4], [4.5]);
      expect(res.newBank).toBe(0.0);
      expect(res.isAffordable).toBe(true);
      expect(res.delta).toBe(-0.1);
    });

    it("handles multi-transfer balance accurately", () => {
      // bank 0.5, sell [4.5, 9.8], buy [5.2, 9.0] -> 0.5 + 14.3 - 14.2 = 0.6
      const res = applyZeroDriftBudget(0.5, [4.5, 9.8], [5.2, 9.0]);
      expect(res.newBank).toBe(0.6);
      expect(res.isAffordable).toBe(true);
      expect(res.delta).toBe(0.1);
    });

    it("flags unaffordable transfers when resulting bank is negative", () => {
      // bank 0.2, sell [4.5], buy [4.8] -> 0.2 + 4.5 - 4.8 = -0.1
      const res = applyZeroDriftBudget(0.2, [4.5], [4.8]);
      expect(res.newBank).toBe(-0.1);
      expect(res.isAffordable).toBe(false);
      expect(res.delta).toBe(-0.3);
    });

    it("accurately computes zero-gain lateral transfer bank balance", () => {
      const res = applyZeroDriftBudget(0.0, [5.0], [5.0]);
      expect(res.newBank).toBe(0.0);
      expect(res.isAffordable).toBe(true);
      expect(res.delta).toBe(0.0);
    });
  });

  describe("6. State Dominance Pruning", () => {
    const mockSquad = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    function createMockNode(params: {
      stage: number;
      squad: number[];
      bank: number;
      ft: number;
      points: number;
      hitCost: number;
      transfers: number;
    }): TrajectoryNode {
      return {
        stage: params.stage,
        node_id: `node_${Math.random()}`,
        cumulative_points: params.points,
        cumulative_hit_cost: params.hitCost,
        cumulative_transfers: params.transfers,
        action_history: [],
        state: {
          gameweek: params.stage + 1,
          squad_ids: params.squad,
          bank: params.bank,
          available_ft: params.ft,
          player_valuations: new Map(),
        },
      };
    }

    it("returns false if stages differ", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 0,
      });
      const baseline = createMockNode({
        stage: 2,
        squad: mockSquad,
        bank: 1.0,
        ft: 2,
        points: 60,
        hitCost: 0,
        transfers: 0,
      });

      expect(isStateDominated(candidate, baseline)).toBe(false);
    });

    it("returns false if squads differ", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 0,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 99],
        bank: 1.0,
        ft: 2,
        points: 60,
        hitCost: 0,
        transfers: 0,
      });

      expect(isStateDominated(candidate, baseline)).toBe(false);
    });

    it("dominates candidate when baseline has more points, equal bank and FT", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 54.2,
        hitCost: 0,
        transfers: 1,
      });

      expect(isStateDominated(candidate, baseline)).toBe(true);
    });

    it("dominates candidate when baseline has equal points and bank, but strictly more FTs", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 2,
        points: 50,
        hitCost: 0,
        transfers: 0,
      });

      expect(isStateDominated(candidate, baseline)).toBe(true);
    });

    it("dominates candidate when baseline has equal points and FT, but strictly more bank", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.2,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.6,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });

      expect(isStateDominated(candidate, baseline)).toBe(true);
    });

    it("does NOT dominate when candidate has higher bank even if baseline has more points", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 1.5, // candidate has more money for future stages
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 52,
        hitCost: 0,
        transfers: 1,
      });

      expect(isStateDominated(candidate, baseline)).toBe(false);
    });

    it("breaks tie on fewer transfers/hits when points, bank, and FT are identical", () => {
      const candidate = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 4,
        transfers: 2,
      });
      const baseline = createMockNode({
        stage: 1,
        squad: mockSquad,
        bank: 0.5,
        ft: 1,
        points: 50,
        hitCost: 0,
        transfers: 1,
      });

      expect(isStateDominated(candidate, baseline)).toBe(true);
    });
  });
});
