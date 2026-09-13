import { describe, it, expect } from "vitest";
import {
  AVAILABILITY_INTEL_VERSION,
  INJURY_STATUS_PROBABILITIES,
  applyAvailabilityOverrides,
  applyAvailabilityOverrideToPlayer,
  parsePressConferenceNotesOffline,
  extractSignalsFromCoachStatements,
  parsePressConferenceNotes,
  CoachStatement,
  ExtractedInjurySignal,
} from "../services/availability_intelligence.js";
import {
  buildPlayerExpectedMinutes,
  MINUTES_MODEL_VERSION_V1_1,
} from "../services/expected_minutes_model.js";
import {
  buildPlayerPredictionFeatures,
} from "../services/prediction_features.js";
import {
  DataValidity,
  PredictionSnapshot,
  GameweekBoundary,
} from "../services/prediction_contract.js";

describe("Phase 8 — Press Conference & Live Availability Intelligence", () => {
  const sampleSquad = [
    { id: 101, web_name: "Saka", team: 1 },
    { id: 102, web_name: "Haaland", team: 11 },
    { id: 103, web_name: "Palmer", team: 6 },
    { id: 104, web_name: "Salah", team: 10 },
    { id: 105, web_name: "Son", team: 17 },
  ];

  describe("1. Contract and Data Types", () => {
    it("exports contract version availability-intel.v1", () => {
      expect(AVAILABILITY_INTEL_VERSION).toBe("availability-intel.v1");
    });

    it("verifies accurate probability mappings for all standard injury statuses", () => {
      expect(INJURY_STATUS_PROBABILITIES.RULED_OUT).toBe(0.0);
      expect(INJURY_STATUS_PROBABILITIES.HIGH_DOUBT).toBe(0.25);
      expect(INJURY_STATUS_PROBABILITIES.FIFTY_FIFTY).toBe(0.50);
      expect(INJURY_STATUS_PROBABILITIES.MINOR_KNOCK_FIT).toBe(0.75);
      expect(INJURY_STATUS_PROBABILITIES.AVAILABLE).toBe(1.0);
    });
  });

  describe("2. Offline Coach Statement Extraction", () => {
    it("extracts RULED_OUT mapping (Arteta confirms Saka will miss tomorrow's match -> 0.0)", () => {
      const text = "Arteta confirms Saka will miss tomorrow's match with a hamstring injury.";
      const signals = parsePressConferenceNotesOffline(text, sampleSquad);

      expect(signals.length).toBe(1);
      expect(signals[0]).toMatchObject({
        player_id: 101,
        player_name: "Saka",
        injury_status: "RULED_OUT",
        adjusted_availability_prob: 0.0,
      });
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.9);
      expect(signals[0].quote_rationale).toContain("Saka will miss tomorrow's match");
    });

    it("extracts FIFTY_FIFTY mapping (Pep says Haaland faces a late fitness test -> 0.50)", () => {
      const text = "Pep Guardiola: 'Haaland faces a late fitness test tomorrow morning, we will assess him.'";
      const signals = parsePressConferenceNotesOffline(text, sampleSquad);

      expect(signals.length).toBe(1);
      expect(signals[0]).toMatchObject({
        player_id: 102,
        player_name: "Haaland",
        injury_status: "FIFTY_FIFTY",
        adjusted_availability_prob: 0.50,
      });
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.8);
      expect(signals[0].quote_rationale).toContain("late fitness test");
    });

    it("extracts HIGH_DOUBT mapping (Postecoglou confirms Son is a major doubt -> 0.25)", () => {
      const text = "Ange Postecoglou confirmed Son is a major doubt for Sunday due to adductor pain.";
      const signals = parsePressConferenceNotesOffline(text, sampleSquad);

      expect(signals.length).toBe(1);
      expect(signals[0]).toMatchObject({
        player_id: 105,
        player_name: "Son",
        injury_status: "HIGH_DOUBT",
        adjusted_availability_prob: 0.25,
      });
    });

    it("extracts MINOR_KNOCK_FIT mapping (Palmer suffered a minor knock but should be fine -> 0.75)", () => {
      const text = "Maresca reported Cole Palmer suffered a minor knock, but it is just a precaution and should be fine.";
      const signals = parsePressConferenceNotesOffline(text, sampleSquad);

      expect(signals.length).toBe(1);
      expect(signals[0]).toMatchObject({
        player_id: 103,
        player_name: "Palmer",
        injury_status: "MINOR_KNOCK_FIT",
        adjusted_availability_prob: 0.75,
      });
    });

    it("extracts AVAILABLE mapping (Slot says Salah trained all week and is available -> 1.0)", () => {
      const text = "Arne Slot confirms Mohamed Salah trained all week and is available to start.";
      const signals = parsePressConferenceNotesOffline(text, sampleSquad);

      expect(signals.length).toBe(1);
      expect(signals[0]).toMatchObject({
        player_id: 104,
        player_name: "Salah",
        injury_status: "AVAILABLE",
        adjusted_availability_prob: 1.0,
      });
    });

    it("parses multiple player mentions across multi-sentence press summaries", () => {
      const summary = `
        Mikel Arteta: "Bukayo Saka will miss tomorrow's match. We will monitor his recovery."
        Pep Guardiola: "Erling Haaland had a late fitness test and we will see tomorrow."
        Arne Slot: "Salah is completely fit and available."
      `;
      const signals = parsePressConferenceNotesOffline(summary, sampleSquad);

      expect(signals.length).toBe(3);
      const saka = signals.find((s) => s.player_id === 101);
      const haaland = signals.find((s) => s.player_id === 102);
      const salah = signals.find((s) => s.player_id === 104);

      expect(saka?.injury_status).toBe("RULED_OUT");
      expect(haaland?.injury_status).toBe("FIFTY_FIFTY");
      expect(salah?.injury_status).toBe("AVAILABLE");
    });

    it("parses structured CoachStatement items via extractSignalsFromCoachStatements", () => {
      const statements: CoachStatement[] = [
        {
          coach_name: "Mikel Arteta",
          team_id: 1,
          raw_quote: "Saka is ruled out for the weekend fixture.",
          source: "Arsenal Official",
        },
        {
          coach_name: "Enzo Maresca",
          team_id: 6,
          raw_quote: "Palmer has passed fit and trained with the group.",
          source: "Chelsea TV",
        },
      ];

      const signals = extractSignalsFromCoachStatements(statements, sampleSquad);
      expect(signals.length).toBe(2);

      const saka = signals.find((s) => s.player_id === 101);
      expect(saka?.injury_status).toBe("RULED_OUT");
      expect(saka?.adjusted_availability_prob).toBe(0.0);

      const palmer = signals.find((s) => s.player_id === 103);
      expect(palmer?.injury_status).toBe("AVAILABLE");
      expect(palmer?.adjusted_availability_prob).toBe(1.0);
    });
  });

  describe("3. Edge Cases and Graceful Fallback", () => {
    it("returns empty array for empty or whitespace notes", () => {
      expect(parsePressConferenceNotesOffline("", sampleSquad)).toEqual([]);
      expect(parsePressConferenceNotesOffline("   ", sampleSquad)).toEqual([]);
      expect(parsePressConferenceNotesOffline(null as any, sampleSquad)).toEqual([]);
    });

    it("ignores players not present in activeSquadPlayers roster", () => {
      const notes = "Kieran Trippier is ruled out for Newcastle.";
      const signals = parsePressConferenceNotesOffline(notes, sampleSquad);
      expect(signals).toEqual([]);
    });

    it("gracefully returns empty when text mentions players but without injury/availability context", () => {
      const notes = "Saka played brilliantly in the previous match and smiled in training.";
      const signals = parsePressConferenceNotesOffline(notes, sampleSquad);
      expect(signals).toEqual([]);
    });

    it("falls back to offline parser when calling parsePressConferenceNotes with useMockFallback: true", async () => {
      const text = "Arteta confirms Saka will miss tomorrow's match.";
      const signals = await parsePressConferenceNotes(text, sampleSquad, { useMockFallback: true });
      expect(signals.length).toBe(1);
      expect(signals[0].injury_status).toBe("RULED_OUT");
      expect(signals[0].adjusted_availability_prob).toBe(0.0);
    });
  });

  describe("4. Availability Override Engine (applyAvailabilityOverrides)", () => {
    const rawPlayers = [
      {
        id: 101,
        web_name: "Saka",
        status: "a",
        chance_of_playing_next_round: 100,
        news: "",
      },
      {
        id: 102,
        web_name: "Haaland",
        status: "a",
        chance_of_playing_next_round: 100,
        news: "",
      },
      {
        id: 103,
        web_name: "Palmer",
        status: "a",
        chance_of_playing_next_round: 100,
        news: "",
      },
    ];

    it("updates player availability with LIVE_PRESS_CONFERENCE provenance and overrides FPL status", () => {
      const signals: ExtractedInjurySignal[] = [
        {
          player_id: 101,
          player_name: "Saka",
          injury_status: "RULED_OUT",
          adjusted_availability_prob: 0.0,
          confidence: 0.95,
          quote_rationale: "Arteta confirms Saka will miss tomorrow's match.",
        },
      ];

      const enhanced = applyAvailabilityOverrides(rawPlayers, signals);

      const saka = enhanced.find((p) => p.id === 101)!;
      expect(saka.availability_provenance).toBe("LIVE_PRESS_CONFERENCE");
      expect(saka.chance_of_playing_next_round).toBe(0);
      expect(saka.status).toBe("i");
      expect(saka.news).toContain("Arteta confirms Saka will miss tomorrow's match");
      expect(saka.availability_override).toMatchObject({
        status: "RULED_OUT",
        adjusted_availability_prob: 0.0,
        confidence: 0.95,
        provenance: "LIVE_PRESS_CONFERENCE",
      });

      // Other players retain OFFICIAL_FPL_BOOTSTRAP provenance
      const haaland = enhanced.find((p) => p.id === 102)!;
      expect(haaland.availability_provenance).toBe("OFFICIAL_FPL_BOOTSTRAP");
      expect(haaland.chance_of_playing_next_round).toBe(100);
      expect(haaland.status).toBe("a");
      expect(haaland.availability_override).toBeUndefined();
    });

    it("correctly sets status 'd' for FIFTY_FIFTY signals", () => {
      const signals: ExtractedInjurySignal[] = [
        {
          player_id: 102,
          player_name: "Haaland",
          injury_status: "FIFTY_FIFTY",
          adjusted_availability_prob: 0.50,
          confidence: 0.85,
          quote_rationale: "Late fitness test tomorrow morning.",
        },
      ];

      const enhanced = applyAvailabilityOverrides(rawPlayers, signals);
      const haaland = enhanced.find((p) => p.id === 102)!;

      expect(haaland.availability_provenance).toBe("LIVE_PRESS_CONFERENCE");
      expect(haaland.chance_of_playing_next_round).toBe(50);
      expect(haaland.status).toBe("d");
    });

    it("supports blendMode: 'BLEND' weighting by confidence", () => {
      const playerWithChance = [
        {
          id: 102,
          web_name: "Haaland",
          status: "a",
          chance_of_playing_next_round: 100, // official 100%
        },
      ];

      const signals: ExtractedInjurySignal[] = [
        {
          player_id: 102,
          player_name: "Haaland",
          injury_status: "FIFTY_FIFTY",
          adjusted_availability_prob: 0.50,
          confidence: 0.80, // 80% signal (0.50) + 20% official (1.00) = 0.40 + 0.20 = 0.60
          quote_rationale: "Late fitness test.",
        },
      ];

      const blended = applyAvailabilityOverrides(playerWithChance, signals, { blendMode: "BLEND" });
      const haaland = blended[0];
      expect(haaland.chance_of_playing_next_round).toBe(60);
      expect(haaland.availability_override?.adjusted_availability_prob).toBe(0.60);
    });

    it("single player helper applyAvailabilityOverrideToPlayer works consistently", () => {
      const player = { id: 103, web_name: "Palmer", status: "a", chance_of_playing_next_round: 100 };
      const signal: ExtractedInjurySignal = {
        player_id: 103,
        player_name: "Palmer",
        injury_status: "MINOR_KNOCK_FIT",
        adjusted_availability_prob: 0.75,
        confidence: 0.85,
        quote_rationale: "Minor knock in training, should be fine.",
      };

      const result = applyAvailabilityOverrideToPlayer(player, signal);
      expect(result.availability_provenance).toBe("LIVE_PRESS_CONFERENCE");
      expect(result.chance_of_playing_next_round).toBe(75);
      expect(result.status).toBe("a");
    });
  });

  describe("5. Phase 3.1 Expected Minutes Integration", () => {
    // Setup standard player and mock snapshot
    const basePlayer = {
      id: 350,
      web_name: "Saka",
      team: 1,
      element_type: 3, // Midfielder
      status: "a",
      chance_of_playing_next_round: 100,
      minutes: 1800,
      starts: 20,
    };

    const boundary: GameweekBoundary = {
      prediction_gameweek: 25,
      historical_cutoff_gameweek: 24,
      boundary_timestamp: new Date().toISOString(),
      is_locked: false,
    };

    const snapshot: PredictionSnapshot = {
      snapshot_id: "snap_gw25_test",
      snapshot_created_at: new Date().toISOString(),
      contract_version: "canonical-features.v1",
      boundary,
      data_sources: {
        fpl_bootstrap: true,
        fpl_fixtures: true,
        fpl_live_gameweeks: [],
      },
    };

    const singleFixture = [
      { id: 241, event: 25, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 },
    ];

    // 10 matches of consistent 90-minute starts
    const consistentHistory = Array.from({ length: 10 }, (_, i) => ({
      round: i + 15,
      minutes: 90,
      starts: 1,
      goals_scored: 0,
      assists: 1,
    }));

    it("calculates baseline expected minutes for fit starter (~80-84 mins)", () => {
      const features = buildPlayerPredictionFeatures({
        player: basePlayer,
        snapshot,
        allFixtures: singleFixture,
        history: consistentHistory,
      });

      const minutesResult = buildPlayerExpectedMinutes({
        player: basePlayer,
        features,
        snapshot,
        history: consistentHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      });

      expect(minutesResult.expected_minutes.value).toBeGreaterThan(75);
      expect(minutesResult.breakdown.availability.provenance).toBe("OFFICIAL_FPL_BOOTSTRAP");
      expect(minutesResult.breakdown.availability.override_applied).toBe(false);
      expect(minutesResult.breakdown.probabilities.probability_available).toBe(1.0);
    });

    it("reduces expected minutes to 0.0 when RULED_OUT press conference override is applied", () => {
      const signal: ExtractedInjurySignal = {
        player_id: 350,
        player_name: "Saka",
        injury_status: "RULED_OUT",
        adjusted_availability_prob: 0.0,
        confidence: 0.95,
        quote_rationale: "Arteta confirms Saka will miss tomorrow's match with a hamstring tear.",
      };

      const overriddenPlayer = applyAvailabilityOverrideToPlayer(basePlayer, signal);
      expect(overriddenPlayer.status).toBe("i");
      expect(overriddenPlayer.chance_of_playing_next_round).toBe(0);

      const features = buildPlayerPredictionFeatures({
        player: overriddenPlayer,
        snapshot,
        allFixtures: singleFixture,
        history: consistentHistory,
      });

      const minutesResult = buildPlayerExpectedMinutes({
        player: overriddenPlayer,
        features,
        snapshot,
        history: consistentHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      });

      // Strict Expected Minutes outcome: 0.0
      expect(minutesResult.expected_minutes.value).toBe(0.0);
      expect(minutesResult.probability_appearance.value).toBe(0.0);
      expect(minutesResult.probability_start.value).toBe(0.0);
      expect(minutesResult.probability_60_plus_minutes.value).toBe(0.0);

      // Provenance & Breakdown verification
      expect(minutesResult.breakdown.availability.provenance).toBe("LIVE_PRESS_CONFERENCE");
      expect(minutesResult.breakdown.availability.override_applied).toBe(true);
      expect(minutesResult.breakdown.availability.probability_available).toBe(0.0);
      expect(minutesResult.breakdown.availability.quote_rationale).toContain("hamstring tear");
    });

    it("halves expected minutes proportionally when 'Late fitness test' (FIFTY_FIFTY) is applied", () => {
      // Baseline minutes
      const baselineFeatures = buildPlayerPredictionFeatures({
        player: basePlayer,
        snapshot,
        allFixtures: singleFixture,
        history: consistentHistory,
      });
      const baselineMinutes = buildPlayerExpectedMinutes({
        player: basePlayer,
        features: baselineFeatures,
        snapshot,
        history: consistentHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      }).expected_minutes.value!;

      // Apply late fitness test (prob = 0.50)
      const signal: ExtractedInjurySignal = {
        player_id: 350,
        player_name: "Saka",
        injury_status: "FIFTY_FIFTY",
        adjusted_availability_prob: 0.50,
        confidence: 0.85,
        quote_rationale: "Arteta says Saka faces a late fitness test tomorrow morning.",
      };

      const overriddenPlayer = applyAvailabilityOverrideToPlayer(basePlayer, signal);
      const features = buildPlayerPredictionFeatures({
        player: overriddenPlayer,
        snapshot,
        allFixtures: singleFixture,
        history: consistentHistory,
      });

      const minutesResult = buildPlayerExpectedMinutes({
        player: overriddenPlayer,
        features,
        snapshot,
        history: consistentHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      });

      expect(minutesResult.breakdown.availability.probability_available).toBe(0.50);
      expect(minutesResult.breakdown.availability.provenance).toBe("LIVE_PRESS_CONFERENCE");
      // Minutes should be approximately half of baseline (within 1 min margin of rounding)
      expect(minutesResult.expected_minutes.value).toBeCloseTo(baselineMinutes * 0.5, 0);
    });

    it("restores expected minutes to full starter levels when manager announces player is AVAILABLE despite yellow/orange FPL flag", () => {
      // Player flagged as doubtful in official FPL bootstrap (e.g. 25% chance)
      const doubtfulPlayer = {
        ...basePlayer,
        status: "d",
        chance_of_playing_next_round: 25,
      };

      // Coach announces player has trained all week and is passed fit (AVAILABLE)
      const signal: ExtractedInjurySignal = {
        player_id: 350,
        player_name: "Saka",
        injury_status: "AVAILABLE",
        adjusted_availability_prob: 1.0,
        confidence: 0.95,
        quote_rationale: "Arteta: Saka has trained all week and is 100% fit to start.",
      };

      const overriddenPlayer = applyAvailabilityOverrideToPlayer(doubtfulPlayer, signal);
      const features = buildPlayerPredictionFeatures({
        player: overriddenPlayer,
        snapshot,
        allFixtures: singleFixture,
        history: consistentHistory,
      });

      const minutesResult = buildPlayerExpectedMinutes({
        player: overriddenPlayer,
        features,
        snapshot,
        history: consistentHistory,
        modelVersion: MINUTES_MODEL_VERSION_V1_1,
      });

      expect(minutesResult.breakdown.availability.provenance).toBe("LIVE_PRESS_CONFERENCE");
      expect(minutesResult.breakdown.availability.probability_available).toBe(1.0);
      expect(minutesResult.expected_minutes.value).toBeGreaterThan(75);
    });
  });
});
