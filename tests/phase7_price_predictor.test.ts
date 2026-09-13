import { describe, it, expect } from "vitest";
import {
  PRICE_PREDICTOR_VERSION,
  calculateTransferMomentum,
  calculateDynamicThresholds,
  classifyMomentumState,
  classifyChangeDirection,
  predictPlayerPriceChange,
  predictSquadPriceChanges,
  filterMarketMovers,
  resolveOwnershipCount,
} from "../services/price_predictor";

describe("Phase 7 — Price Change Predictor & Market Momentum Engine", () => {
  const TOTAL_MANAGERS = 10_000_000;

  describe("1. Net Transfer Momentum & Velocity Calculations", () => {
    it("calculates net event transfers and velocity correctly for standard player", () => {
      const player = {
        id: 101,
        web_name: "Salah",
        now_cost: 125,
        transfers_in_event: 45000,
        transfers_out_event: 5000,
        selected_by_percent: "30.0", // 3,000,000 managers
      };

      const momentum = calculateTransferMomentum(player, TOTAL_MANAGERS);
      expect(momentum.transfers_in_event).toBe(45000);
      expect(momentum.transfers_out_event).toBe(5000);
      expect(momentum.net_event_transfers).toBe(40000);
      expect(momentum.ownership_count).toBe(3000000);

      // net_transfer_velocity = 40,000 / 3,000,000 = 0.013333
      expect(momentum.net_transfer_velocity).toBeCloseTo(0.013333, 5);
    });

    it("applies ownership floor of 1000 to prevent division by zero or extreme velocity on zero ownership", () => {
      const player = {
        id: 999,
        web_name: "Unowned Youngster",
        now_cost: 40,
        transfers_in_event: 200,
        transfers_out_event: 50,
        selected_by_percent: "0.0",
        ownership_count: 0,
      };

      const momentum = calculateTransferMomentum(player, TOTAL_MANAGERS);
      expect(momentum.ownership_count).toBe(0);
      expect(momentum.net_event_transfers).toBe(150);
      // Floor is max(0, 1000) = 1000 => 150 / 1000 = 0.15
      expect(momentum.net_transfer_velocity).toBe(0.15);
    });

    it("resolves ownership from explicit ownership_count or selected_by_percent string", () => {
      expect(resolveOwnershipCount({ ownership_count: 500000 }, TOTAL_MANAGERS)).toBe(500000);
      expect(resolveOwnershipCount({ selected_by_percent: "12.5" }, TOTAL_MANAGERS)).toBe(1250000);
      expect(resolveOwnershipCount({ selected_by_percent: "0.5" }, TOTAL_MANAGERS)).toBe(50000);
      expect(resolveOwnershipCount({}, TOTAL_MANAGERS)).toBe(0);
      expect(resolveOwnershipCount(null, TOTAL_MANAGERS)).toBe(0);
    });
  });

  describe("2. Status Classifications & Price Targets", () => {
    it("classifies target percentages into precise momentum states", () => {
      expect(classifyMomentumState(120.0)).toBe("LIKELY_RISE_TONIGHT");
      expect(classifyMomentumState(100.0)).toBe("LIKELY_RISE_TONIGHT");
      expect(classifyMomentumState(99.9)).toBe("RISK_OF_RISE");
      expect(classifyMomentumState(80.0)).toBe("RISK_OF_RISE");
      expect(classifyMomentumState(79.9)).toBe("NEUTRAL");
      expect(classifyMomentumState(0.0)).toBe("NEUTRAL");
      expect(classifyMomentumState(-79.9)).toBe("NEUTRAL");
      expect(classifyMomentumState(-80.0)).toBe("RISK_OF_FALL");
      expect(classifyMomentumState(-99.9)).toBe("RISK_OF_FALL");
      expect(classifyMomentumState(-100.0)).toBe("LIKELY_FALL_TONIGHT");
      expect(classifyMomentumState(-135.5)).toBe("LIKELY_FALL_TONIGHT");
    });

    it("maps momentum states to directional change classifications", () => {
      expect(classifyChangeDirection("LIKELY_RISE_TONIGHT")).toBe("RISE");
      expect(classifyChangeDirection("RISK_OF_RISE")).toBe("RISE");
      expect(classifyChangeDirection("NEUTRAL")).toBe("STABLE");
      expect(classifyChangeDirection("RISK_OF_FALL")).toBe("FALL");
      expect(classifyChangeDirection("LIKELY_FALL_TONIGHT")).toBe("FALL");
    });
  });

  describe("3. Price Prediction Engine (predictPlayerPriceChange)", () => {
    it("triggers LIKELY_RISE_TONIGHT under high net-buying volume reaching >= 100% target", () => {
      const player = {
        id: 426,
        web_name: "B.Fernandes",
        now_cost: 85,
        transfers_in_event: 65000,
        transfers_out_event: 5000,
        selected_by_percent: "5.0", // 500,000 managers => riseThreshold = max(15000, 500000 * 0.05) = 25000
      };

      const result = predictPlayerPriceChange(player, { totalManagers: TOTAL_MANAGERS });

      expect(result.version).toBe(PRICE_PREDICTOR_VERSION);
      expect(result.player_id).toBe(426);
      expect(result.now_cost).toBe(85);
      expect(result.net_event_transfers).toBe(60000);
      expect(result.rise_threshold).toBe(25000);
      // Target: (60,000 / 25,000) * 100 = 240%
      expect(result.price_target_percentage).toBe(240);
      expect(result.momentum_state).toBe("LIKELY_RISE_TONIGHT");
      expect(result.estimated_change_direction).toBe("RISE");
    });

    it("triggers RISK_OF_RISE when target is between 80% and 100%", () => {
      const player = {
        id: 212,
        web_name: "Palmer",
        now_cost: 105,
        transfers_in_event: 25000,
        transfers_out_event: 3000, // net = 22000
        selected_by_percent: "5.0", // 500,000 managers => riseThreshold = 25000
      };

      const result = predictPlayerPriceChange(player, { totalManagers: TOTAL_MANAGERS });

      // Target: (22,000 / 25,000) * 100 = 88%
      expect(result.price_target_percentage).toBe(88);
      expect(result.momentum_state).toBe("RISK_OF_RISE");
      expect(result.estimated_change_direction).toBe("RISE");
    });

    it("triggers LIKELY_FALL_TONIGHT under heavy selling volume reaching <= -100% target", () => {
      const player = {
        id: 356,
        web_name: "Watkins",
        now_cost: 90,
        transfers_in_event: 2000,
        transfers_out_event: 42000, // net = -40000
        selected_by_percent: "6.0", // 600,000 managers => fallThreshold = max(15000, 600000 * 0.05) = 30000
      };

      const result = predictPlayerPriceChange(player, { totalManagers: TOTAL_MANAGERS });

      expect(result.net_event_transfers).toBe(-40000);
      expect(result.fall_threshold).toBe(30000);
      // Target: (-40000 / 30000) * 100 = -133.33%
      expect(result.price_target_percentage).toBe(-133.33);
      expect(result.momentum_state).toBe("LIKELY_FALL_TONIGHT");
      expect(result.estimated_change_direction).toBe("FALL");
    });

    it("triggers RISK_OF_FALL when negative target is between -80% and -100%", () => {
      const player = {
        id: 40,
        web_name: "Saka",
        now_cost: 100,
        transfers_in_event: 5000,
        transfers_out_event: 30500, // net = -25500
        selected_by_percent: "6.0", // 600,000 managers => fallThreshold = 30000
      };

      const result = predictPlayerPriceChange(player, { totalManagers: TOTAL_MANAGERS });

      // Target: (-25500 / 30000) * 100 = -85%
      expect(result.price_target_percentage).toBe(-85);
      expect(result.momentum_state).toBe("RISK_OF_FALL");
      expect(result.estimated_change_direction).toBe("FALL");
    });

    it("defaults to NEUTRAL for low ownership / low velocity differential assets", () => {
      const player = {
        id: 777,
        web_name: "Differential Mid",
        now_cost: 55,
        transfers_in_event: 350,
        transfers_out_event: 120, // net = 230
        selected_by_percent: "0.2", // 20,000 managers
      };

      const result = predictPlayerPriceChange(player, { totalManagers: TOTAL_MANAGERS });

      // Floor threshold is 15000
      // Target: (230 / 15000) * 100 = 1.53%
      expect(result.price_target_percentage).toBe(1.53);
      expect(result.momentum_state).toBe("NEUTRAL");
      expect(result.estimated_change_direction).toBe("STABLE");
    });

    it("defaults to NEUTRAL when net transfers are zero", () => {
      const player = {
        id: 555,
        web_name: "Balanced Player",
        now_cost: 60,
        transfers_in_event: 1000,
        transfers_out_event: 1000,
        selected_by_percent: "2.0",
      };

      const result = predictPlayerPriceChange(player);
      expect(result.net_event_transfers).toBe(0);
      expect(result.price_target_percentage).toBe(0);
      expect(result.momentum_state).toBe("NEUTRAL");
      expect(result.estimated_change_direction).toBe("STABLE");
    });
  });

  describe("4. Boundary Clamping & Missing Data Safety", () => {
    it("safely handles null, undefined, and non-numeric transfer values without throwing", () => {
      const malformedPlayer = {
        id: "abc",
        now_cost: null,
        transfers_in_event: undefined,
        transfers_out_event: "not_a_number",
        selected_by_percent: null,
      };

      const result = predictPlayerPriceChange(malformedPlayer);
      expect(result.player_id).toBe(0);
      expect(result.now_cost).toBe(50);
      expect(result.transfers_in_event).toBe(0);
      expect(result.transfers_out_event).toBe(0);
      expect(result.net_event_transfers).toBe(0);
      expect(result.net_transfer_velocity).toBe(0);
      expect(result.price_target_percentage).toBe(0);
      expect(result.momentum_state).toBe("NEUTRAL");
      expect(result.estimated_change_direction).toBe("STABLE");
    });

    it("respects explicit rise and fall thresholds when specified directly on player", () => {
      const customPlayer = {
        id: 123,
        now_cost: 75,
        transfers_in_event: 18000,
        transfers_out_event: 0,
        rise_threshold: 20000,
        fall_threshold: 20000,
      };

      const result = predictPlayerPriceChange(customPlayer);
      expect(result.rise_threshold).toBe(20000);
      // (18000 / 20000) * 100 = 90% => RISK_OF_RISE
      expect(result.price_target_percentage).toBe(90);
      expect(result.momentum_state).toBe("RISK_OF_RISE");
    });
  });

  describe("5. Squad Predictions & Market Movers Filtering", () => {
    it("correctly filters market movers into categorized buckets", () => {
      const squad = [
        { id: 1, web_name: "Hot Asset", transfers_in_event: 50000, transfers_out_event: 0, selected_by_percent: "5.0" },
        { id: 2, web_name: "Rising Asset", transfers_in_event: 22000, transfers_out_event: 0, selected_by_percent: "5.0" },
        { id: 3, web_name: "Cold Asset", transfers_in_event: 0, transfers_out_event: 50000, selected_by_percent: "5.0" },
        { id: 4, web_name: "Dropping Asset", transfers_in_event: 0, transfers_out_event: 22000, selected_by_percent: "5.0" },
        { id: 5, web_name: "Static Asset", transfers_in_event: 100, transfers_out_event: 100, selected_by_percent: "5.0" },
      ];

      const predictions = predictSquadPriceChanges(squad, { totalManagers: TOTAL_MANAGERS });
      expect(predictions.length).toBe(5);

      const movers = filterMarketMovers(predictions);
      expect(movers.likely_risers.map((p) => p.player_id)).toEqual([1]);
      expect(movers.risers_at_risk.map((p) => p.player_id)).toEqual([2]);
      expect(movers.likely_fallers.map((p) => p.player_id)).toEqual([3]);
      expect(movers.fallers_at_risk.map((p) => p.player_id)).toEqual([4]);
      expect(movers.neutral.map((p) => p.player_id)).toEqual([5]);
    });
  });
});
