/**
 * Phase 9 — Expert Hub, Top Targets & Differential Radar Engine
 * Test Suite: tests/phase9_expert_advisor.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../server.js";
import {
  EXPERT_ADVISOR_VERSION,
  getExpertRecommendations,
  getTopTransferTargets,
  getDifferentialRadar,
  getValuePicks,
  getCaptaincyComparison,
  isPlayerRuledOut,
  evaluatePlayersForExpert,
} from "../services/expert_advisor.js";
import {
  registerAvailabilitySignals,
  clearGlobalAvailabilityOverrides,
} from "../services/availability_intelligence.js";
import { fetchBootstrapData, fetchFixtures } from "../services/fpl_service.js";
import { PredictionSnapshot } from "../services/prediction_contract.js";

describe("Phase 9 — Expert Hub, Top Targets & Differential Radar", () => {
  let server: any;
  let baseUrl: string;

  beforeEach(async () => {
    clearGlobalAvailabilityOverrides();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    clearGlobalAvailabilityOverrides();
    if (server) {
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });

  describe("1. Contract & Core Logic Invariants", () => {
    it("generates expert recommendations adhering to expert-advisor.v1 contract", async () => {
      const result = await getExpertRecommendations({ horizon: 5 });

      expect(result.version).toBe(EXPERT_ADVISOR_VERSION);
      expect(result.generated_at).toBeDefined();
      expect(result.filters.horizon).toBe(5);
      expect(Array.isArray(result.top_targets)).toBe(true);
      expect(Array.isArray(result.differentials)).toBe(true);
      expect(Array.isArray(result.value_picks)).toBe(true);
      expect(result.captain_matrix).toBeDefined();
      expect(result.captain_matrix.candidates.length).toBeGreaterThan(0);
      expect(result.captain_matrix.candidates.length).toBeLessThanOrEqual(3);
    });

    it("evaluates players and attaches multi-gw projections and price predictions", async () => {
      const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrapData(),
        fetchFixtures(),
      ]);

      const snapshot = bootstrap.snapshot;

      const evaluations = evaluatePlayersForExpert(
        bootstrap.players,
        fixtures,
        bootstrap.teams,
        snapshot,
        5
      );

      expect(evaluations.length).toBeGreaterThan(50);
      const sample = evaluations[0];
      expect(sample.costInM).toBeGreaterThan(3.5);
      expect(sample.projectedXpts).toBeGreaterThanOrEqual(0);
      expect(sample.pricePrediction).toBeDefined();
      expect(sample.pricePrediction.momentum_state).toBeDefined();
    });
  });

  describe("2. Differential Radar (Strict Ownership Enforcing)", () => {
    it("strictly excludes players above 10% ownership threshold", async () => {
      const result = await getExpertRecommendations({ horizon: 5 });
      expect(result.differentials.length).toBeGreaterThan(0);

      for (const diff of result.differentials) {
        expect(diff.selected_by_percent).toBeLessThanOrEqual(10.0);
        expect(diff.differential_score).toBeGreaterThan(0);
        expect(diff.upside_summary).toBeDefined();
      }
    });

    it("respects custom maxOwnership threshold (e.g. 5.0%)", () => {
      const mockEvaluations: any[] = [
        {
          rawPlayer: { id: 1, web_name: "HighOwned", element_type: 3, now_cost: 100, team: 1, team_short_name: "ARS", status: "a" },
          costInM: 10.0,
          ownershipPercent: 25.0,
          availabilityProb: 1.0,
          projectedXpts: 30.0,
          avgXptsPerGw: 6.0,
          pricePrediction: { estimated_change_direction: "STABLE", net_event_transfers: 0 },
        },
        {
          rawPlayer: { id: 2, web_name: "MidOwned", element_type: 3, now_cost: 75, team: 1, team_short_name: "ARS", status: "a" },
          costInM: 7.5,
          ownershipPercent: 8.5,
          availabilityProb: 1.0,
          projectedXpts: 24.0,
          avgXptsPerGw: 4.8,
          pricePrediction: { estimated_change_direction: "STABLE", net_event_transfers: 0 },
        },
        {
          rawPlayer: { id: 3, web_name: "UltraDifferential", element_type: 3, now_cost: 60, team: 1, team_short_name: "ARS", status: "a" },
          costInM: 6.0,
          ownershipPercent: 3.2,
          availabilityProb: 1.0,
          projectedXpts: 22.0,
          avgXptsPerGw: 4.4,
          pricePrediction: { estimated_change_direction: "STABLE", net_event_transfers: 0 },
        },
      ];

      // With maxOwnership = 5.0%: HighOwned (25%) and MidOwned (8.5%) must be excluded
      const diffs5 = getDifferentialRadar(mockEvaluations, 5.0, 5);
      expect(diffs5.length).toBe(1);
      expect(diffs5[0].web_name).toBe("UltraDifferential");

      // With maxOwnership = 10.0%: MidOwned (8.5%) and UltraDifferential (3.2%) are included
      const diffs10 = getDifferentialRadar(mockEvaluations, 10.0, 5);
      expect(diffs10.length).toBe(2);
      expect(diffs10.some((p) => p.web_name === "HighOwned")).toBe(false);
    });
  });

  describe("3. Phase 8 Availability Intelligence Exclusion", () => {
    it("strictly excludes players ruled out in Phase 8 press conference overrides from all recommendations", async () => {
      const [bootstrap] = await Promise.all([fetchBootstrapData()]);

      // Pick an active top player (e.g. Haaland or Salah or Saka)
      const targetPlayer = bootstrap.players.find((p) => p.web_name === "Haaland") || bootstrap.players[0];
      const targetId = targetPlayer.id;

      // First verify player would normally be recommended or present
      const baseline = await getExpertRecommendations({ horizon: 5 });
      const inBaseline =
        baseline.top_targets.some((p) => p.player_id === targetId) ||
        baseline.captain_matrix.candidates.some((p) => p.player_id === targetId);

      // Now register a LIVE Phase 8 press conference injury override ruling the player out
      registerAvailabilitySignals([
        {
          player_id: targetId,
          player_name: targetPlayer.web_name,
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.98,
          quote_rationale: "Confirmed ruled out by coach press conference statement.",
          catchy_headline: `🚨 Breaking: ${targetPlayer.web_name} Ruled Out!`,
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
        },
      ]);

      // Generate expert recommendations with active override
      const overridden = await getExpertRecommendations({ horizon: 5 });

      // Player MUST be strictly excluded from all 4 categories
      const inTopTargets = overridden.top_targets.some((p) => p.player_id === targetId);
      const inDifferentials = overridden.differentials.some((p) => p.player_id === targetId);
      const inValuePicks = overridden.value_picks.some((p) => p.player_id === targetId);
      const inCaptaincy = overridden.captain_matrix.candidates.some((p) => p.player_id === targetId);

      expect(inTopTargets).toBe(false);
      expect(inDifferentials).toBe(false);
      expect(inValuePicks).toBe(false);
      expect(inCaptaincy).toBe(false);
    });

    it("isPlayerRuledOut helper correctly identifies FPL status and Phase 8 override flags", () => {
      expect(isPlayerRuledOut({ status: "a", adjusted_availability_prob: 1.0 })).toBe(false);
      expect(isPlayerRuledOut({ status: "i" })).toBe(true);
      expect(isPlayerRuledOut({ status: "s" })).toBe(true);
      expect(isPlayerRuledOut({ status: "u" })).toBe(true);
      expect(isPlayerRuledOut({ status: "a", chance_of_playing_next_round: 0 })).toBe(true);
      expect(isPlayerRuledOut({ status: "a", injury_status: "RULED_OUT" })).toBe(true);
      expect(isPlayerRuledOut({ status: "a", adjusted_availability_prob: 0.0 })).toBe(true);
    });
  });

  describe("4. Value Picks & Sorting Invariants", () => {
    it("sorts value picks in descending order of value_ratio (xPts per £1.0m)", async () => {
      const result = await getExpertRecommendations({ horizon: 5 });
      expect(result.value_picks.length).toBeGreaterThan(1);

      for (let i = 0; i < result.value_picks.length - 1; i++) {
        const current = result.value_picks[i];
        const next = result.value_picks[i + 1];
        expect(current.value_ratio).toBeGreaterThanOrEqual(next.value_ratio);
      }
    });

    it("verifies captaincy comparison produces top 3 picks with rank, base xPts, and captain score", async () => {
      const result = await getExpertRecommendations({ horizon: 5 });
      const capMatrix = result.captain_matrix;

      expect(capMatrix.candidates.length).toBeGreaterThan(0);
      expect(capMatrix.candidates.length).toBeLessThanOrEqual(3);

      capMatrix.candidates.forEach((cand, idx) => {
        expect(cand.rank).toBe(idx + 1);
        expect(cand.base_xpts).toBeGreaterThan(0);
        expect(cand.captaincy_score).toBeGreaterThan(0);
        expect(cand.probability_appearance).toBeGreaterThan(0);
        expect(cand.opponent_short_name).toBeDefined();
        expect(cand.rationale).toBeDefined();
      });

      expect(capMatrix.verdict).toBeDefined();
      expect(typeof capMatrix.verdict).toBe("string");
    });
  });

  describe("5. API Route Integration: GET /api/expert/recommendations", () => {
    it("returns 200 with complete schema and default horizon", async () => {
      const res = await fetch(`${baseUrl}/api/expert/recommendations`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.version).toBe(EXPERT_ADVISOR_VERSION);
      expect(data.generated_at).toBeDefined();
      expect(data.filters.horizon).toBe(5);
      expect(Array.isArray(data.top_targets)).toBe(true);
      expect(Array.isArray(data.differentials)).toBe(true);
      expect(Array.isArray(data.value_picks)).toBe(true);
      expect(data.captain_matrix).toBeDefined();
    });

    it("filters recommendations by position (element_type = 3 / MID)", async () => {
      const res = await fetch(`${baseUrl}/api/expert/recommendations?element_type=3`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.filters.element_type).toBe(3);

      // All top targets and value picks must be midfielders
      for (const target of data.top_targets) {
        expect(target.element_type).toBe(3);
        expect(target.position).toBe("MID");
      }

      for (const diff of data.differentials) {
        expect(diff.element_type).toBe(3);
        expect(diff.position).toBe("MID");
      }

      for (const val of data.value_picks) {
        expect(val.element_type).toBe(3);
        expect(val.position).toBe("MID");
      }
    });

    it("filters recommendations by budget (max_cost = 8.0m)", async () => {
      const res = await fetch(`${baseUrl}/api/expert/recommendations?max_cost=8.0`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.filters.max_cost).toBe(8.0);

      for (const target of data.top_targets) {
        expect(target.cost_in_millions).toBeLessThanOrEqual(8.0);
      }

      for (const diff of data.differentials) {
        expect(diff.cost_in_millions).toBeLessThanOrEqual(8.0);
      }

      for (const val of data.value_picks) {
        expect(val.cost_in_millions).toBeLessThanOrEqual(8.0);
      }
    });

    it("supports horizon parameter override", async () => {
      const res = await fetch(`${baseUrl}/api/expert/recommendations?horizon=3`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.filters.horizon).toBe(3);
    });
  });

  describe("6. UI Route Integration: GET /expert-hub", () => {
    it("renders /expert-hub HTML dashboard with sections and badges", async () => {
      const res = await fetch(`${baseUrl}/expert-hub`);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain("Expert Hub & Transfer Advisory");
      expect(html).toContain("Captaincy Showdown Matrix");
      expect(html).toContain("Top Transfer Targets");
      expect(html).toContain("Differential Radar");
      expect(html).toContain("Top Value Picks");
      expect(html).toContain("expert-advisor.v1");
    });
  });
});
