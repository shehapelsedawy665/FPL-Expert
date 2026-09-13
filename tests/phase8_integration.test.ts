import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { app } from "../server";
import {
  AVAILABILITY_INTEL_VERSION,
  clearGlobalAvailabilityOverrides,
  getGlobalAvailabilityOverrides,
  getGlobalNewsFeed,
  registerAvailabilitySignals,
  ExtractedInjurySignal,
} from "../services/availability_intelligence";
import {
  fetchBootstrapData,
  fetchFixtures,
  fetchTeamData,
  addFixtureData,
} from "../services/fpl_service";
import { addRatings } from "../services/rating_engine";
import { analyzeTeamSquad } from "../services/team_analyzer";
import { runTransferEngine, createCurrentLiveTransferSnapshot, TeamFinancialState } from "../services/transfer_engine";
import { optimizeSequentialTransfers } from "../services/sequential_transfer_engine";

describe("Phase 8 — Step 2: Press Conference Intel & Live News Hub Integration", () => {
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

  beforeEach(() => {
    clearGlobalAvailabilityOverrides();
  });

  describe("1. POST /api/intel/press-conference", () => {
    it("ingests raw quote, extracts signals with catchy headline and sentiment tag", async () => {
      const payload = {
        raw_quote: "Bukayo Saka felt something sharp in his hamstring. He has not trained all week and is definitely ruled out of this weekend's match.",
        coach_name: "Mikel Arteta",
        team_id: 1,
        useMockFallback: true,
      };

      const res = await fetch(`${baseUrl}/api/intel/press-conference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.version).toBe(AVAILABILITY_INTEL_VERSION);
      expect(data.status).toBe("ok");
      expect(data.signals_extracted_count).toBeGreaterThan(0);
      expect(data.signals[0].player_name).toBe("Saka");
      expect(data.signals[0].injury_status).toBe("RULED_OUT");
      expect(data.signals[0].adjusted_availability_prob).toBe(0.0);
      expect(data.signals[0].sentiment_tag).toBe("BREAKING_BAD");
      expect(data.signals[0].catchy_headline).toContain("Arteta");
      expect(data.signals[0].catchy_headline).toContain("Saka");
      expect(data.headlines[0]).toBe(data.signals[0].catchy_headline);
      expect(data.active_overrides_count).toBe(1);

      // Verify in-memory store updated
      const active = getGlobalAvailabilityOverrides();
      expect(active.size).toBe(1);
      const sakaOverride = active.get(data.signals[0].player_id);
      expect(sakaOverride).toBeDefined();
      expect(sakaOverride?.status).toBe("RULED_OUT");
      expect(sakaOverride?.adjusted_availability_prob).toBe(0.0);
    });

    it("ingests multiple statements in bulk array", async () => {
      const statements = [
        {
          coach_name: "Pep Guardiola",
          team_id: 15,
          raw_quote: "Erling Haaland trained normally today with the rest of the squad. He feels good, no pain, and is available for selection.",
          source: "Man City Presser",
        },
        {
          coach_name: "Mikel Arteta",
          team_id: 1,
          raw_quote: "Martinelli has a small issue with his groin. It's touch and go, 50-50 for Sunday.",
          source: "Arsenal Media",
        },
      ];

      const res = await fetch(`${baseUrl}/api/intel/press-conference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statements }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.signals_extracted_count).toBe(2);

      const haalandSignal = data.signals.find((s: any) => s.player_name.includes("Haaland"));
      expect(haalandSignal).toBeDefined();
      expect(haalandSignal.injury_status).toBe("AVAILABLE");
      expect(haalandSignal.sentiment_tag).toBe("POSITIVE_BOOST");
      expect(haalandSignal.adjusted_availability_prob).toBe(1.0);

      const martinelliSignal = data.signals.find((s: any) => s.player_name.includes("Martinelli"));
      expect(martinelliSignal).toBeDefined();
      expect(martinelliSignal.injury_status).toBe("FIFTY_FIFTY");
      expect(martinelliSignal.sentiment_tag).toBe("UNCERTAINTY");
      expect(martinelliSignal.adjusted_availability_prob).toBe(0.5);

      expect(data.active_overrides_count).toBe(2);
    });

    it("returns 400 when missing input text/statements", async () => {
      const res = await fetch(`${baseUrl}/api/intel/press-conference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });

  describe("2. GET /api/intel/news-feed", () => {
    beforeEach(() => {
      clearGlobalAvailabilityOverrides();
      const mockSignals: ExtractedInjurySignal[] = [
        {
          player_id: 350,
          player_name: "Saka",
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.95,
          quote_rationale: "Ruled out with hamstring issue",
          catchy_headline: "🚨 Arteta Confirms Saka Blow: Ruled Out of GW Action!",
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
          coach_name: "Mikel Arteta",
          team_id: 1,
        },
        {
          player_id: 351,
          player_name: "Haaland",
          injury_status: "AVAILABLE",
          adjusted_availability_prob: 1.0,
          confidence: 0.90,
          quote_rationale: "Trained normally and fit",
          catchy_headline: "🟢 All Clear! Haaland Fit and Available for Matchday!",
          sentiment_tag: "POSITIVE_BOOST",
          published_at: new Date().toISOString(),
          coach_name: "Pep Guardiola",
          team_id: 13,
        },
        {
          player_id: 352,
          player_name: "De Bruyne",
          injury_status: "HIGH_DOUBT",
          adjusted_availability_prob: 0.25,
          confidence: 0.85,
          quote_rationale: "Faces late fitness test",
          catchy_headline: "⚠️ Pep Roulette: De Bruyne Faces Late Fitness Test!",
          sentiment_tag: "UNCERTAINTY",
          published_at: new Date().toISOString(),
          coach_name: "Pep Guardiola",
          team_id: 13,
        },
      ];
      registerAvailabilitySignals(mockSignals);
    });

    it("returns all news items with version and total count", async () => {
      const res = await fetch(`${baseUrl}/api/intel/news-feed`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.version).toBe(AVAILABILITY_INTEL_VERSION);
      expect(data.total_count).toBe(3);
      expect(data.items.length).toBe(3);
      expect(data.items[0].catchy_headline).toBeDefined();
    });

    it("filters news items by sentiment", async () => {
      const res = await fetch(`${baseUrl}/api/intel/news-feed?sentiment=BREAKING_BAD`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.total_count).toBe(1);
      expect(data.items[0].sentiment_tag).toBe("BREAKING_BAD");
      expect(data.items[0].player_name).toBe("Saka");
    });

    it("filters news items by team", async () => {
      const res = await fetch(`${baseUrl}/api/intel/news-feed?team=13`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.total_count).toBe(2);
      for (const item of data.items) {
        expect(item.team_id).toBe(13);
      }
    });

    it("respects limit parameter", async () => {
      const res = await fetch(`${baseUrl}/api/intel/news-feed?limit=1`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.items.length).toBe(1);
    });
  });

  describe("3. GET & DELETE /api/intel/overrides", () => {
    beforeEach(() => {
      clearGlobalAvailabilityOverrides();
      const mockSignals: ExtractedInjurySignal[] = [
        {
          player_id: 101,
          player_name: "Palmer",
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.95,
          quote_rationale: "Groin strain confirmed",
          catchy_headline: "🚨 Palmer Ruled Out!",
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
        },
      ];
      registerAvailabilitySignals(mockSignals);
    });

    it("returns list of active overrides via GET /api/intel/overrides", async () => {
      const res = await fetch(`${baseUrl}/api/intel/overrides`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.count).toBe(1);
      expect(data.overrides[0].player_id).toBe(101);
      expect(data.overrides[0].status).toBe("RULED_OUT");
      expect(data.overrides[0].adjusted_availability_prob).toBe(0.0);
    });

    it("clears a single player override via DELETE /api/intel/overrides/:playerId", async () => {
      const res = await fetch(`${baseUrl}/api/intel/overrides/101`, { method: "DELETE" });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("cleared");
      expect(data.player_id).toBe(101);
      expect(data.active_overrides_remaining).toBe(0);

      const active = getGlobalAvailabilityOverrides();
      expect(active.has(101)).toBe(false);
    });

    it("clears all overrides via DELETE /api/intel/overrides", async () => {
      const res = await fetch(`${baseUrl}/api/intel/overrides`, { method: "DELETE" });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("cleared");
      expect(data.cleared_count).toBe(1);

      const active = getGlobalAvailabilityOverrides();
      expect(active.size).toBe(0);
    });
  });

  describe("4. End-to-End Pipeline Integration: Starting XI (Phase 6A)", () => {
    it("automatically benches a player in Starting XI when press conference override rules him out", async () => {
      const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrapData(),
        fetchFixtures(),
      ]);

      const teamData = await fetchTeamData(1, bootstrap.reference_gameweek);
      const playersWithFixtures = addFixtureData(
        bootstrap.players,
        fixtures,
        bootstrap.teams,
        bootstrap.gameweek_boundary
      );

      const ratedPlayers = addRatings(playersWithFixtures, {
        referenceGameweek: bootstrap.reference_gameweek,
        boundary: bootstrap.gameweek_boundary,
        snapshot: bootstrap.snapshot,
        recentHistoryByPlayer: teamData.player_histories || {},
      });

      // 1. Run baseline without overrides
      clearGlobalAvailabilityOverrides();
      const baselineResult = analyzeTeamSquad(
        ratedPlayers,
        teamData.picks,
        teamData.entry,
        teamData.gameweek,
        teamData.entry_history,
        {
          snapshot: bootstrap.snapshot,
          allFixtures: fixtures,
          allTeams: bootstrap.teams,
          playerHistories: teamData.player_histories || {},
        }
      );

      // Identify a starting player
      const starter = baselineResult.analysis.decision_engine.starting_xi[0];
      expect(starter).toBeDefined();

      // 2. Set active override ruling out this starter
      registerAvailabilitySignals([
        {
          player_id: starter.id,
          player_name: starter.web_name,
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.98,
          quote_rationale: "Coach confirmed he has torn ligaments and will miss out.",
          catchy_headline: `🚨 Breaking: ${starter.web_name} Ruled Out by Manager!`,
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
        },
      ]);

      // 3. Re-analyze team squad with active override
      const overriddenResult = analyzeTeamSquad(
        ratedPlayers,
        teamData.picks,
        teamData.entry,
        teamData.gameweek,
        teamData.entry_history,
        {
          snapshot: bootstrap.snapshot,
          allFixtures: fixtures,
          allTeams: bootstrap.teams,
          playerHistories: teamData.player_histories || {},
        }
      );

      // The ruled-out starter MUST NOT be in starting XI!
      const isStillStarting = overriddenResult.analysis.decision_engine.starting_xi.some(
        (p: any) => p.id === starter.id
      );
      expect(isStillStarting).toBe(false);

      // The ruled-out starter should be on the bench
      const onBench = overriddenResult.analysis.decision_engine.ordered_outfield_bench.some(
        (p: any) => p.id === starter.id
      ) || (overriddenResult.analysis.decision_engine.bench_goalkeeper?.id === starter.id);
      expect(onBench).toBe(true);
    });
  });

  describe("5. End-to-End Pipeline Integration: Sequential Transfer Engine (Phase 6D)", () => {
    it("incorporates availability overrides into sequential trajectory planning", async () => {
      const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrapData(),
        fetchFixtures(),
      ]);

      const teamData = await fetchTeamData(1, bootstrap.reference_gameweek);
      const snapshot = createCurrentLiveTransferSnapshot(
        bootstrap.players,
        bootstrap.teams,
        fixtures,
        bootstrap.gameweek_boundary,
        bootstrap.snapshot
      );

      const ownedPlayers = teamData.picks.map((pick) => {
        const raw = bootstrap.players.find((p) => p.id === pick.element)!;
        return {
          id: pick.element,
          web_name: raw.web_name,
          element_type: raw.element_type,
          team: raw.team,
          now_cost: raw.now_cost,
          selling_price: raw.now_cost,
          purchase_price: raw.now_cost,
          position: pick.position,
        };
      });

      const financialState: TeamFinancialState = {
        bank: teamData.entry.bank || 5,
        team_value: teamData.entry.value || 1000,
        available_free_transfers: 1,
        owned_players: ownedPlayers,
      };

      // Select an owned player and rule him out
      const playerToInjure = ownedPlayers[0];
      registerAvailabilitySignals([
        {
          player_id: playerToInjure.id,
          player_name: playerToInjure.web_name,
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.99,
          quote_rationale: "Ruled out for the next 4 weeks.",
          catchy_headline: `🚨 ${playerToInjure.web_name} Sidelined!`,
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
        },
      ]);

      const plan = optimizeSequentialTransfers({
        snapshot,
        financialState,
        allPlayers: bootstrap.players,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
        playerHistories: teamData.player_histories || {},
        horizon: 3,
        beamWidth: 3,
      });

      expect(plan).toBeDefined();
      expect(plan.trajectory_steps).toBeDefined();
      expect(plan.total_discounted_points).toBeDefined();
    });
  });

  describe("6. Public Press Room Page", () => {
    it("renders /press-room HTML page with headlines and status", async () => {
      registerAvailabilitySignals([
        {
          player_id: 1,
          player_name: "Saka",
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.95,
          quote_rationale: "Hamstring injury",
          catchy_headline: "🚨 Arteta Confirms Saka Blow: Ruled Out of GW Action!",
          sentiment_tag: "BREAKING_BAD",
          published_at: new Date().toISOString(),
          coach_name: "Mikel Arteta",
        },
      ]);

      const res = await fetch(`${baseUrl}/press-room`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Live Press Room");
      expect(text).toContain("Arteta Confirms Saka Blow");
      expect(text).toContain("BREAKING BAD");
    });
  });
});
