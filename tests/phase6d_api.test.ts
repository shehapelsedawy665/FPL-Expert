import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { app } from "../server";
import { fetchBootstrapData } from "../services/fpl_service";

describe("Phase 6D — Sequential Transfer API Integration (/api/transfers/sequential)", () => {
  let server: http.Server;
  let baseUrl: string;
  let bootstrapData: any;

  beforeAll(async () => {
    bootstrapData = await fetchBootstrapData();
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("1. returns 200 with complete metadata and contract compliance for default Team 4107702", async () => {
    const res = await fetch(`${baseUrl}/api/transfers/sequential?team_id=4107702&horizon=5&discount=0.95&beam_width=15`);
    expect(res.status).toBe(200);

    const data = await res.json();

    // Contract Metadata
    expect(data.engine_version).toBe("sequential-transfer.v1");
    expect(data.search_scope).toBe("HEURISTIC_BEAM_SEARCH");
    expect(data.global_optimality).toBe("NOT_PROVEN");
    expect(data.price_model).toBe("FROZEN_DEADLINE_PRICES_ZERO_DRIFT");
    expect(data.financial_state_validity).toBe("VALID");

    // Execution & Scoring Structure
    expect(data.team_id).toBe(4107702);
    expect(data.horizon).toBe(5);
    expect(data.discount_factor).toBe(0.95);
    expect(data.beam_width).toBe(15);
    expect(typeof data.baseline_hold_score).toBe("number");
    expect(typeof data.trajectory_score).toBe("number");
    expect(typeof data.net_strategic_advantage).toBe("number");
    expect(data.net_strategic_advantage).toBe(
      Math.round((data.trajectory_score - data.baseline_hold_score) * 100) / 100
    );

    // Plan & Breakdowns
    expect(Array.isArray(data.action_plan)).toBe(true);
    expect(data.action_plan.length).toBe(5);
    expect(Array.isArray(data.gameweek_breakdowns)).toBe(true);
    expect(data.gameweek_breakdowns.length).toBe(5);

    // Final State Structure
    expect(data.final_state).toBeDefined();
    expect(data.final_state.squad_ids.length).toBe(15);
    expect(data.final_state.bank).toBeGreaterThanOrEqual(0);
    expect(data.final_state.available_ft).toBeGreaterThanOrEqual(1);
    expect(data.final_state.available_ft).toBeLessThanOrEqual(5);
  }, 15000);

  it("2. enforces INSUFFICIENT_HISTORICAL_FINANCIAL_STATE guard when historical flag is set without verification", async () => {
    const res = await fetch(
      `${baseUrl}/api/transfers/sequential?team_id=4107702&horizon=3&is_historical=true&is_historical_verified=false`
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.financial_state_validity).toBe("INSUFFICIENT_HISTORICAL_FINANCIAL_STATE");
    expect(data.validation_message).toContain("Historical selling prices");
    expect(data.total_transfers).toBe(0);
    expect(data.total_hit_cost).toBe(0);

    // Every step must be forced HOLD
    for (const step of data.action_plan) {
      expect(step.action_label).toBe("HOLD");
      expect(step.transfer_count).toBe(0);
    }
  }, 15000);

  it("3. verifies all trajectory actions adhere strictly to legal FPL constraints across all gameweeks", async () => {
    const res = await fetch(`${baseUrl}/api/transfers/sequential?team_id=4107702&horizon=5&beam_width=15`);
    expect(res.status).toBe(200);

    const data = await res.json();
    const playerMap = new Map<number, any>(bootstrapData.players.map((p: any) => [p.id, p]));

    let currentSquad = [...data.final_state.squad_ids]; // To check end state composition
    const posCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const clubCounts: Record<number, number> = {};

    for (const pid of currentSquad) {
      const p = playerMap.get(pid);
      expect(p).toBeDefined();
      posCounts[p.element_type] = (posCounts[p.element_type] || 0) + 1;
      clubCounts[p.team] = (clubCounts[p.team] || 0) + 1;
    }

    // 2 GK, 5 DEF, 5 MID, 3 FWD
    expect(posCounts[1]).toBe(2);
    expect(posCounts[2]).toBe(5);
    expect(posCounts[3]).toBe(5);
    expect(posCounts[4]).toBe(3);

    // Max 3 players per club rule
    for (const [club, count] of Object.entries(clubCounts)) {
      expect(count).toBeLessThanOrEqual(3);
    }

    // Check action_plan step by step
    for (let i = 0; i < data.action_plan.length; i++) {
      const step = data.action_plan[i];
      const gwBreakdown = data.gameweek_breakdowns[i];

      expect(step.bank_before).toBeGreaterThanOrEqual(0);
      expect(step.bank_after).toBeGreaterThanOrEqual(0);
      expect(step.free_transfers_available_before).toBeGreaterThanOrEqual(1);
      expect(step.free_transfers_available_before).toBeLessThanOrEqual(5);

      // Hit calculation check
      const expectedPaid = Math.max(0, step.transfer_count - step.free_transfers_available_before);
      expect(step.paid_transfers).toBe(expectedPaid);
      expect(step.hit_cost).toBe(expectedPaid * 4);

      // GW breakdown integrity
      expect(gwBreakdown.gameweek).toBe(step.gameweek);
      expect(gwBreakdown.starting_xi_points).toBeGreaterThan(0);
      expect(gwBreakdown.team_points).toBeGreaterThan(0);
      expect(gwBreakdown.captain).toBeDefined();
      expect(gwBreakdown.captain.id).toBeGreaterThan(0);
      expect(typeof gwBreakdown.captain.web_name).toBe("string");
      expect(gwBreakdown.hit_cost).toBe(step.hit_cost);
      expect(gwBreakdown.available_ft_after).toBeGreaterThanOrEqual(1);
      expect(gwBreakdown.available_ft_after).toBeLessThanOrEqual(5);
    }
  }, 15000);

  it("4. clamps horizon and beam_width parameters to safe architectural bounds", async () => {
    // Test horizon clamped to [1, 8] and beam_width clamped to [1, 50]
    const res = await fetch(`${baseUrl}/api/transfers/sequential?team_id=4107702&horizon=20&beam_width=99`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.horizon).toBe(8); // clamped to 8
    expect(data.beam_width).toBe(50); // clamped to 50
    expect(data.action_plan.length).toBe(8);
  }, 20000);
});
