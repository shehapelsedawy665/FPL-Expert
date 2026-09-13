import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { app } from "../server";
import {
  assessTransferUrgency,
  PRICE_PREDICTOR_VERSION,
  PlayerPricePrediction,
  predictPlayerPriceChange,
} from "../services/price_predictor";
import {
  runTransferEngine,
  createCurrentLiveTransferSnapshot,
  TeamFinancialState,
} from "../services/transfer_engine";
import { optimizeSequentialTransfers } from "../services/sequential_transfer_engine";
import { fetchBootstrapData, fetchFixtures, fetchTeamData } from "../services/fpl_service";

describe("Phase 7 — Step 2: Market Movers API & Transfer Urgency Integration", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
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

  describe("1. GET /api/prices/movers Endpoint", () => {
    it("returns HTTP 200 with version, timestamp, and correctly partitioned mover lists", async () => {
      const res = await fetch(`${baseUrl}/api/prices/movers`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.version).toBe(PRICE_PREDICTOR_VERSION);
      expect(typeof data.timestamp).toBe("string");
      expect(new Date(data.timestamp).getTime()).not.toBeNaN();

      expect(Array.isArray(data.likely_risers)).toBe(true);
      expect(Array.isArray(data.risers_at_risk)).toBe(true);
      expect(Array.isArray(data.likely_fallers)).toBe(true);
      expect(Array.isArray(data.fallers_at_risk)).toBe(true);
      expect(typeof data.total_tracked_players).toBe("number");
      expect(data.total_tracked_players).toBeGreaterThan(0);

      // Verify partition invariants
      for (const p of data.likely_risers as PlayerPricePrediction[]) {
        expect(p.price_target_percentage).toBeGreaterThanOrEqual(100);
        expect(p.momentum_state).toBe("LIKELY_RISE_TONIGHT");
        expect(p.estimated_change_direction).toBe("RISE");
      }

      for (const p of data.risers_at_risk as PlayerPricePrediction[]) {
        expect(p.price_target_percentage).toBeGreaterThanOrEqual(80);
        expect(p.price_target_percentage).toBeLessThan(100);
        expect(p.momentum_state).toBe("RISK_OF_RISE");
        expect(p.estimated_change_direction).toBe("RISE");
      }

      for (const p of data.likely_fallers as PlayerPricePrediction[]) {
        expect(p.price_target_percentage).toBeLessThanOrEqual(-100);
        expect(p.momentum_state).toBe("LIKELY_FALL_TONIGHT");
        expect(p.estimated_change_direction).toBe("FALL");
      }

      for (const p of data.fallers_at_risk as PlayerPricePrediction[]) {
        expect(p.price_target_percentage).toBeLessThanOrEqual(-80);
        expect(p.price_target_percentage).toBeGreaterThan(-100);
        expect(p.momentum_state).toBe("RISK_OF_FALL");
        expect(p.estimated_change_direction).toBe("FALL");
      }
    });

    it("respects limit query parameter when specified", async () => {
      const limit = 3;
      const res = await fetch(`${baseUrl}/api/prices/movers?limit=${limit}`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.likely_risers.length).toBeLessThanOrEqual(limit);
      expect(data.risers_at_risk.length).toBeLessThanOrEqual(limit);
      expect(data.likely_fallers.length).toBeLessThanOrEqual(limit);
      expect(data.fallers_at_risk.length).toBeLessThanOrEqual(limit);
    });
  });

  describe("2. Urgency Assessment Engine (assessTransferUrgency)", () => {
    it("generates CRITICAL urgency when a target player is rising tonight and remaining bank is £0.0m", () => {
      const risingPlayer = {
        id: 10,
        web_name: "Haaland",
        now_cost: 152,
        transfers_in_event: 150000,
        transfers_out_event: 5000,
        selected_by_percent: "50.0", // 5,000,000 managers => threshold = 250,000; net = 145,000 => target% ~ 58
        rise_threshold: 100000, // Explicit threshold: 145000 / 100000 = 145% (>= 100%)
      };

      const assessment = assessTransferUrgency({
        transfersIn: [risingPlayer],
        transfersOut: [{ id: 11, web_name: "Jesus", now_cost: 70, selected_by_percent: "2.0" }],
        bankAfter: 0.0, // Exhausted bank! A £0.1m rise breaks the transfer budget
      });

      expect(assessment.urgency_level).toBe("CRITICAL");
      expect(assessment.budget_impact_if_delayed).toBe(true);
      expect(assessment.urgency_reason).toContain("Haaland");
      expect(assessment.urgency_reason).toContain("rise momentum tonight");
      expect(assessment.urgency_reason).toContain("preserve bank");
    });

    it("generates HIGH urgency when a target player is rising tonight but remaining bank has £0.5m buffer", () => {
      const risingPlayer = {
        id: 10,
        web_name: "Haaland",
        now_cost: 152,
        transfers_in_event: 150000,
        transfers_out_event: 5000,
        rise_threshold: 100000,
      };

      const assessment = assessTransferUrgency({
        transfersIn: [risingPlayer],
        transfersOut: [{ id: 11, web_name: "Jesus", now_cost: 70, selected_by_percent: "2.0" }],
        bankAfter: 0.5, // £0.5m buffer remaining
      });

      expect(assessment.urgency_level).toBe("HIGH");
      expect(assessment.budget_impact_if_delayed).toBe(false);
      expect(assessment.urgency_reason).toContain("Haaland");
      expect(assessment.urgency_reason).toContain("save £0.1m");
    });

    it("generates HIGH urgency when selling a falling player before price drop", () => {
      const fallingPlayer = {
        id: 20,
        web_name: "Sterling",
        now_cost: 70,
        transfers_in_event: 1000,
        transfers_out_event: 50000,
        fall_threshold: 40000, // net = -49,000 / 40,000 = -122.5% (<= -100%)
      };

      const assessment = assessTransferUrgency({
        transfersIn: [{ id: 25, web_name: "Rogers", now_cost: 50, selected_by_percent: "15.0" }],
        transfersOut: [fallingPlayer],
        bankAfter: 1.0,
      });

      expect(assessment.urgency_level).toBe("HIGH");
      expect(assessment.budget_impact_if_delayed).toBe(false);
      expect(assessment.urgency_reason).toContain("Sterling");
      expect(assessment.urgency_reason).toContain("fall momentum");
      expect(assessment.urgency_reason).toContain("avoid £0.1m value loss");
    });

    it("defaults to NONE urgency when players are neutral", () => {
      const neutralIn = {
        id: 30,
        web_name: "Konsa",
        now_cost: 45,
        transfers_in_event: 500,
        transfers_out_event: 500,
        selected_by_percent: "10.0",
      };
      const neutralOut = {
        id: 31,
        web_name: "Dunk",
        now_cost: 45,
        transfers_in_event: 600,
        transfers_out_event: 600,
        selected_by_percent: "8.0",
      };

      const assessment = assessTransferUrgency({
        transfersIn: [neutralIn],
        transfersOut: [neutralOut],
        bankAfter: 0.2,
      });

      expect(assessment.urgency_level).toBe("NONE");
      expect(assessment.budget_impact_if_delayed).toBe(false);
      expect(assessment.urgency_reason).toContain("No immediate price rise or fall pressure detected");
    });

    it("defaults to NONE urgency when transfer count is 0 (HOLD)", () => {
      const assessment = assessTransferUrgency({
        transfersIn: [],
        transfersOut: [],
        bankAfter: 0.0,
      });

      expect(assessment.urgency_level).toBe("NONE");
      expect(assessment.budget_impact_if_delayed).toBe(false);
      expect(assessment.urgency_reason).toContain("HOLD posture");
    });
  });

  describe("3. Engine Integration (Phase 6C & Phase 6D)", () => {
    it("attaches urgency_assessment to Phase 6C TransferEngineResult and recommended_plan", async () => {
      const bootstrap = await fetchBootstrapData();
      const fixtures = await fetchFixtures();
      const snapshot = createCurrentLiveTransferSnapshot(bootstrap.events);
      const teamData = await fetchTeamData(4107702, bootstrap.reference_gameweek);

      const playerMap = new Map<number, any>(bootstrap.players.map((p: any) => [p.id, p]));
      const ownedPlayers = (teamData.picks || []).map((pick: any) => {
        const p = playerMap.get(pick.element);
        const nowCost = p?.now_cost || 50;
        return {
          id: pick.element,
          web_name: p?.web_name || `Player ${pick.element}`,
          element_type: p?.element_type || 1,
          team: p?.team || 1,
          now_cost: nowCost,
          selling_price: typeof pick.selling_price === "number" ? pick.selling_price : nowCost,
          purchase_price: typeof pick.purchase_price === "number" ? pick.purchase_price : nowCost,
        };
      });

      const financialState: TeamFinancialState = {
        team_id: 4107702,
        bank: teamData.entry_history?.bank || 0,
        available_free_transfers: 1,
        overall_rank: 100000,
        owned_players: ownedPlayers,
      };

      const result = runTransferEngine({
        financialState,
        snapshot,
        allPlayers: bootstrap.players,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
        horizon: 3,
        discountFactor: 0.95,
        maxTransfers: 1,
      });

      expect(result.urgency_assessment).toBeDefined();
      expect(["CRITICAL", "HIGH", "MEDIUM", "NONE"]).toContain(result.urgency_assessment?.urgency_level);
      expect(typeof result.urgency_assessment?.urgency_reason).toBe("string");
      expect(typeof result.urgency_assessment?.budget_impact_if_delayed).toBe("boolean");
      expect(result.recommended_plan.urgency_assessment).toBeDefined();
    });

    it("attaches urgency_assessment to Phase 6D SequentialPlan in /api/transfers/sequential", async () => {
      const res = await fetch(`${baseUrl}/api/transfers/sequential?team_id=4107702&horizon=3&beam_width=10`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.urgency_assessment).toBeDefined();
      expect(["CRITICAL", "HIGH", "MEDIUM", "NONE"]).toContain(data.urgency_assessment?.urgency_level);
      expect(typeof data.urgency_assessment?.urgency_reason).toBe("string");
      expect(typeof data.urgency_assessment?.budget_impact_if_delayed).toBe("boolean");
    });
  });
});
