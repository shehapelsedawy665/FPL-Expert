import { describe, it, expect } from "vitest";
import {
  evaluateCaptaincyPairs,
  DecisionSquadPlayer,
  APP_PROB_EPSILON,
  EPSILON,
} from "../services/decision_engine.js";

function mockCapPlayer(overrides: Partial<DecisionSquadPlayer>): DecisionSquadPlayer {
  return {
    id: 1,
    web_name: "MockPlayer",
    element_type: 3,
    position_short_name: "MID",
    team_id: 1,
    team_short_name: "ARS",
    cost: 10.0,
    status: "a",
    chance_of_playing_next_round: 100,
    fixture_count: 1,
    fixtures_summary: [],
    expected_minutes: 80,
    probability_available: 0.95,
    probability_appearance: 0.93,
    probability_start: 0.90,
    probability_60_plus_minutes: 0.85,
    raw_expected_points: 5.0,
    calibrated_expected_points: null,
    calibration_status: "insufficient_data",
    decision_expected_points: 5.0,
    expected_points_confidence: {
      value: 0.8,
      source: "derived_from_features",
      sample_size_matches: 10,
      playing_time_confidence: 0.8,
      confidence_interval: [4.0, 6.0],
    },
    expert_score: 65,
    future_fpl_score: 65,
    current_form_score: 65,
    expected_minutes_proxy: 80,
    ...overrides,
  };
}

describe("Captain / Vice Mathematical Validation", () => {
  it("1. Verifies exact mathematical identity X_C + (1 - p_C) * X_V", () => {
    const p1 = mockCapPlayer({ id: 101, web_name: "P1", decision_expected_points: 5.54, probability_appearance: 0.931 });
    const p2 = mockCapPlayer({ id: 102, web_name: "P2", decision_expected_points: 4.92, probability_appearance: 0.931 });
    const pFillers = Array.from({ length: 9 }, (_, i) => mockCapPlayer({ id: 200 + i, decision_expected_points: 2.0, probability_appearance: 0.95 }));

    const res = evaluateCaptaincyPairs([p1, p2, ...pFillers]);
    const best = res.best_pair;
    expect(best.captain.id).toBe(p1.id);
    expect(best.vice_captain.id).toBe(p2.id);

    // Exact identity calculation
    const q_C = Math.round((p1.decision_expected_points / p1.probability_appearance) * 1000) / 1000;
    const q_V = Math.round((p2.decision_expected_points / p2.probability_appearance) * 1000) / 1000;
    const cContrib = Math.round(p1.probability_appearance * q_C * 10000) / 10000;
    const vContrib = Math.round((1.0 - p1.probability_appearance) * (p2.probability_appearance * q_V) * 10000) / 10000;
    const expectedBonus = Math.round((cContrib + vContrib) * 1000) / 1000;

    expect(best.expected_captaincy_bonus).toBe(expectedBonus);
    expect(best.expected_captaincy_bonus).toBe(5.88);
  });

  it("2. Independent Oracle verifies all 110 pairs match production exactly", () => {
    const players = Array.from({ length: 11 }, (_, i) =>
      mockCapPlayer({
        id: 1000 + i,
        web_name: `Player_${i}`,
        decision_expected_points: 2.0 + i * 0.4,
        probability_appearance: 0.60 + (i % 5) * 0.08,
      })
    );

    const prodResult = evaluateCaptaincyPairs(players);

    // Independent Oracle Calculation
    const oraclePairs: { cId: number; vId: number; bonus: number }[] = [];
    for (let i = 0; i < players.length; i++) {
      for (let j = 0; j < players.length; j++) {
        if (i === j) continue;
        const c = players[i];
        const v = players[j];

        const pC = c.probability_appearance;
        const pV = v.probability_appearance;
        const xC = c.decision_expected_points;
        const xV = v.decision_expected_points;

        const qC = pC >= APP_PROB_EPSILON ? Math.round((xC / pC) * 1000) / 1000 : xC;
        const qV = pV >= APP_PROB_EPSILON ? Math.round((xV / pV) * 1000) / 1000 : xV;

        const cCont = Math.round((pC >= APP_PROB_EPSILON ? pC * qC : xC) * 10000) / 10000;
        const vCont = Math.round((1 - pC) * (pV >= APP_PROB_EPSILON ? pV * qV : xV) * 10000) / 10000;
        const bonus = Math.round((cCont + vCont) * 1000) / 1000;

        oraclePairs.push({ cId: c.id, vId: v.id, bonus });
      }
    }

    expect(oraclePairs.length).toBe(110);
    expect(prodResult.all_pairs.length).toBe(110);

    // Verify all 110 pairs match
    for (const prodPair of prodResult.all_pairs) {
      const match = oraclePairs.find((op) => op.cId === prodPair.captain.id && op.vId === prodPair.vice_captain.id);
      expect(match).toBeDefined();
      expect(Math.abs(match!.bonus - prodPair.expected_captaincy_bonus)).toBeLessThanOrEqual(EPSILON);
    }

    oraclePairs.sort((a, b) => b.bonus - a.bonus);
    expect(prodResult.best_pair.captain.id).toBe(oraclePairs[0].cId);
    expect(prodResult.best_pair.vice_captain.id).toBe(oraclePairs[0].vId);
    expect(prodResult.best_pair.expected_captaincy_bonus).toBe(oraclePairs[0].bonus);
  });

  it("3. Critical Hedging Scenario: Lower unconditional xPts player selected as Captain due to high upside + reliable Vice", () => {
    // Player A: Lower unconditional xPts (4.80) due to 40% appearance, but huge conditional upside (12.0 xPts if playing)
    const pA = mockCapPlayer({
      id: 301,
      web_name: "Player_A_HighUpside",
      decision_expected_points: 4.80,
      probability_appearance: 0.40,
    });
    // Player B: Higher unconditional xPts (5.00) with 100% certainty (5.00 conditional xPts)
    const pB = mockCapPlayer({
      id: 302,
      web_name: "Player_B_Reliable",
      decision_expected_points: 5.00,
      probability_appearance: 1.00,
    });
    const fillers = Array.from({ length: 9 }, (_, i) =>
      mockCapPlayer({ id: 400 + i, decision_expected_points: 2.0, probability_appearance: 0.95 })
    );

    const res = evaluateCaptaincyPairs([pA, pB, ...fillers]);

    // Expected values:
    // Pair (A, B): 4.80 + (1 - 0.40) * 5.00 = 4.80 + 3.00 = 7.80
    // Pair (B, A): 5.00 + (1 - 1.00) * 4.80 = 5.00 + 0.00 = 5.00
    expect(res.best_pair.captain.id).toBe(pA.id); // Player A is chosen as Captain despite lower unconditional xPts!
    expect(res.best_pair.vice_captain.id).toBe(pB.id);
    expect(res.best_pair.expected_captaincy_bonus).toBe(7.80);
  });

  it("4. Zero / Tiny P(appearance) safety at epsilon boundaries", () => {
    const eps = APP_PROB_EPSILON; // 0.05
    const pZero = mockCapPlayer({ id: 501, web_name: "P_Zero", decision_expected_points: 0.0, probability_appearance: 0.0 });
    const pTiny = mockCapPlayer({ id: 502, web_name: "P_Tiny", decision_expected_points: 0.001, probability_appearance: 1e-12 });
    const pBelow = mockCapPlayer({ id: 503, web_name: "P_Below", decision_expected_points: 0.20, probability_appearance: eps - 0.001 });
    const pExact = mockCapPlayer({ id: 504, web_name: "P_Exact", decision_expected_points: 0.25, probability_appearance: eps });
    const pAbove = mockCapPlayer({ id: 505, web_name: "P_Above", decision_expected_points: 0.30, probability_appearance: eps + 0.001 });
    const pSolid = mockCapPlayer({ id: 506, web_name: "P_Solid", decision_expected_points: 5.0, probability_appearance: 0.95 });
    const fillers = Array.from({ length: 5 }, (_, i) =>
      mockCapPlayer({ id: 600 + i, decision_expected_points: 2.0, probability_appearance: 0.95 })
    );

    const res = evaluateCaptaincyPairs([pZero, pTiny, pBelow, pExact, pAbove, pSolid, ...fillers]);

    for (const pair of res.all_pairs) {
      expect(Number.isNaN(pair.expected_captaincy_bonus)).toBe(false);
      expect(Number.isFinite(pair.expected_captaincy_bonus)).toBe(true);
      expect(pair.expected_captaincy_bonus).toBeGreaterThanOrEqual(0);
    }
  });

  it("5. Unavailable player exclusion: P(available) = 0 / status = 'i' excluded from captaincy", () => {
    const pInjured = mockCapPlayer({
      id: 701,
      web_name: "Injured_Star",
      status: "i",
      decision_expected_points: 8.0,
      probability_appearance: 0.0,
    });
    const pValid1 = mockCapPlayer({ id: 702, web_name: "Valid_1", decision_expected_points: 5.0, probability_appearance: 0.95 });
    const pValid2 = mockCapPlayer({ id: 703, web_name: "Valid_2", decision_expected_points: 4.5, probability_appearance: 0.95 });
    const fillers = Array.from({ length: 8 }, (_, i) =>
      mockCapPlayer({ id: 800 + i, decision_expected_points: 2.0, probability_appearance: 0.95 })
    );

    const res = evaluateCaptaincyPairs([pInjured, pValid1, pValid2, ...fillers]);
    expect(res.best_pair.captain.id).not.toBe(pInjured.id);
    expect(res.best_pair.vice_captain.id).not.toBe(pInjured.id);
    expect(res.all_pairs.some((p) => p.captain.id === pInjured.id || p.vice_captain.id === pInjured.id)).toBe(false);
  });

  it("6. Captain / Vice deterministic tiebreaker cascade", () => {
    // 1. Same bonus, differentiated by captain decision xPts
    const pA = mockCapPlayer({ id: 901, decision_expected_points: 5.0, probability_appearance: 0.90 });
    const pB = mockCapPlayer({ id: 902, decision_expected_points: 4.0, probability_appearance: 0.90 });
    const pC = mockCapPlayer({ id: 903, decision_expected_points: 3.0, probability_appearance: 0.90 });
    const fillers = Array.from({ length: 8 }, (_, i) => mockCapPlayer({ id: 910 + i, decision_expected_points: 1.0 }));

    const res = evaluateCaptaincyPairs([pA, pB, pC, ...fillers]);
    expect(res.best_pair.captain.id).toBe(pA.id);

    // 2. Exact tie in scores and appearances, broken deterministically by player ID
    const pTie1 = mockCapPlayer({ id: 10, decision_expected_points: 5.0, probability_appearance: 0.95, probability_60_plus_minutes: 0.90 });
    const pTie2 = mockCapPlayer({ id: 20, decision_expected_points: 5.0, probability_appearance: 0.95, probability_60_plus_minutes: 0.90 });
    const pTie3 = mockCapPlayer({ id: 30, decision_expected_points: 5.0, probability_appearance: 0.95, probability_60_plus_minutes: 0.90 });

    const tieRes = evaluateCaptaincyPairs([pTie2, pTie1, pTie3, ...fillers]);
    expect(tieRes.best_pair.captain.id).toBe(pTie1.id); // lower ID (10 < 20 < 30)
    expect(tieRes.best_pair.vice_captain.id).toBe(pTie2.id); // lower vice ID (20 < 30)
  });
});
