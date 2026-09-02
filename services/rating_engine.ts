import {
  DataValidity,
  DataValue,
  GameweekBoundary,
  PredictionSnapshot,
} from "./prediction_contract";

export const POSITION_LABELS: Record<number, string> = {
  1: "Goalkeeper",
  2: "Defender",
  3: "Midfielder",
  4: "Forward",
};

export const STATUS_LABELS: Record<string, string> = {
  a: "Available",
  d: "Doubtful",
  i: "Injured",
  n: "Not available",
  s: "Suspended",
  u: "Unavailable",
};

export const STATUS_AVAILABILITY: Record<string, number> = {
  a: 100.0,
  d: 55.0,
  i: 20.0,
  n: 0.0,
  s: 0.0,
  u: 0.0,
};

export const EARLY_REGRESSION_KEYS = new Set([
  "event_points",
  "form",
  "points_per_game",
  "goals_scored",
  "assists",
  "bonus",
  "expected_goals",
  "expected_assists",
  "expected_goal_involvements",
]);

export const COMPONENT_MIN = 15.0;
export const COMPONENT_MAX = 85.0;

export const CURRENT_WEIGHTS: Record<number, Record<string, number>> = {
  1: {
    event_points: 0.10,
    form: 0.10,
    points_per_game: 0.09,
    minutes: 0.15,
    clean_sheets: 0.16,
    bonus: 0.10,
    expected_goals: 0.04,
    expected_assists: 0.04,
    expected_goal_involvements: 0.04,
    ict_index: 0.04,
    influence: 0.05,
    creativity: 0.02,
    threat: 0.02,
    goals_scored: 0.03,
    assists: 0.02,
  },
  2: {
    event_points: 0.10,
    form: 0.10,
    points_per_game: 0.07,
    minutes: 0.14,
    clean_sheets: 0.15,
    bonus: 0.08,
    expected_goals: 0.07,
    expected_assists: 0.07,
    expected_goal_involvements: 0.09,
    ict_index: 0.04,
    influence: 0.02,
    creativity: 0.03,
    threat: 0.03,
    goals_scored: 0.03,
    assists: 0.01,
  },
  3: {
    event_points: 0.10,
    form: 0.10,
    points_per_game: 0.06,
    minutes: 0.09,
    clean_sheets: 0.03,
    bonus: 0.07,
    expected_goals: 0.12,
    expected_assists: 0.10,
    expected_goal_involvements: 0.15,
    ict_index: 0.05,
    influence: 0.02,
    creativity: 0.07,
    threat: 0.08,
    goals_scored: 0.03,
    assists: 0.03,
  },
  4: {
    event_points: 0.10,
    form: 0.10,
    points_per_game: 0.06,
    minutes: 0.10,
    clean_sheets: 0.01,
    bonus: 0.07,
    expected_goals: 0.18,
    expected_assists: 0.04,
    expected_goal_involvements: 0.18,
    ict_index: 0.04,
    influence: 0.02,
    creativity: 0.03,
    threat: 0.12,
    goals_scored: 0.10,
    assists: 0.05,
  },
};

export const ATTACKING_WEIGHTS: Record<number, Record<string, number>> = {
  1: {
    expected_goals: 0.15,
    expected_assists: 0.10,
    expected_goal_involvements: 0.15,
    threat: 0.10,
    bonus: 0.20,
    clean_sheets: 0.30,
  },
  2: {
    expected_goals: 0.18,
    expected_assists: 0.14,
    expected_goal_involvements: 0.22,
    threat: 0.14,
    bonus: 0.12,
    clean_sheets: 0.20,
  },
  3: {
    expected_goals: 0.24,
    expected_assists: 0.18,
    expected_goal_involvements: 0.25,
    threat: 0.13,
    creativity: 0.12,
    goals_scored: 0.08,
  },
  4: {
    expected_goals: 0.30,
    expected_assists: 0.10,
    expected_goal_involvements: 0.28,
    threat: 0.17,
    bonus: 0.08,
    goals_scored: 0.07,
  },
};

export function clamp(value: number, low = 0.0, high = 100.0): number {
  return Math.max(low, Math.min(high, value));
}

export function numberValue(value: any): number {
  if (value === null || value === undefined || value === "") return 0.0;
  const num = Number(value);
  return isNaN(num) ? 0.0 : num;
}

export function rawValue(player: Record<string, any>, key: string): number | null {
  const value = player[key];
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return isNaN(num) ? null : num;
}

export function percentile(value: number | null, peerValues: number[]): number {
  const validValues = [...peerValues].sort((a, b) => a - b);
  if (value === null) {
    return validValues.length === 0 ? 50.0 : 0.0;
  }
  if (validValues.length <= 1) {
    return 50.0;
  }
  let lessCount = 0;
  let equalCount = 0;
  for (const peer of validValues) {
    if (peer < value) lessCount++;
    else if (peer === value) equalCount++;
  }
  return clamp(((lessCount + equalCount * 0.5) / validValues.length) * 100);
}

export function reconstructPlayerForCutoff(
  player: Record<string, any>,
  history: Array<Record<string, any>> | null | undefined,
  boundary: GameweekBoundary | null | undefined
): Record<string, any> {
  const cutoff = boundary?.historical_cutoff_gameweek ?? null;
  const inProgressGw = boundary?.in_progress_gameweek ?? null;
  const copy = { ...player };

  if (cutoff !== null && Array.isArray(history) && history.length > 0) {
    const completedMatches = history.filter(
      (item) =>
        typeof item === "object" &&
        typeof item.round === "number" &&
        item.round <= cutoff
    );

    let sumMinutes = 0;
    let sumStarts = 0;
    let sumGoals = 0;
    let sumAssists = 0;
    let sumCleanSheets = 0;
    let sumBonus = 0;
    let sumTotalPoints = 0;
    let sumXG = 0;
    let sumXA = 0;
    let sumXGI = 0;
    let sumIct = 0;
    let sumInfluence = 0;
    let sumCreativity = 0;
    let sumThreat = 0;
    let appearances = 0;
    let cutoffEventPoints: number | null = null;

    for (const match of completedMatches) {
      const mins = numberValue(match.minutes);
      if (mins > 0) appearances++;
      sumMinutes += mins;

      const startsVal =
        match.starts !== undefined && match.starts !== null
          ? numberValue(match.starts)
          : mins > 0
          ? 1
          : 0;
      sumStarts += startsVal;

      sumGoals += numberValue(match.goals_scored);
      sumAssists += numberValue(match.assists);
      sumCleanSheets += numberValue(match.clean_sheets);
      sumBonus += numberValue(match.bonus);
      sumTotalPoints += numberValue(match.total_points);
      sumXG += numberValue(match.expected_goals);
      sumXA += numberValue(match.expected_assists);
      sumXGI += numberValue(
        match.expected_goal_involvements ||
          numberValue(match.expected_goals) + numberValue(match.expected_assists)
      );
      sumIct += numberValue(match.ict_index);
      sumInfluence += numberValue(match.influence);
      sumCreativity += numberValue(match.creativity);
      sumThreat += numberValue(match.threat);

      if (match.round === cutoff) {
        cutoffEventPoints = numberValue(match.total_points);
      }
    }

    copy.minutes = sumMinutes;
    copy.starts = sumStarts;
    copy.goals_scored = sumGoals;
    copy.assists = sumAssists;
    copy.clean_sheets = sumCleanSheets;
    copy.bonus = sumBonus;
    copy.total_points = sumTotalPoints;
    copy.expected_goals = Math.round(sumXG * 100) / 100;
    copy.expected_assists = Math.round(sumXA * 100) / 100;
    copy.expected_goal_involvements = Math.round(sumXGI * 100) / 100;
    copy.ict_index = Math.round(sumIct * 10) / 10;
    copy.influence = Math.round(sumInfluence * 10) / 10;
    copy.creativity = Math.round(sumCreativity * 10) / 10;
    copy.threat = Math.round(sumThreat * 10) / 10;
    copy.event_points = cutoffEventPoints ?? 0;
    copy.points_per_game =
      appearances > 0 ? Math.round((sumTotalPoints / appearances) * 10) / 10 : 0;

    if (completedMatches.length > 0) {
      const recentMatches = completedMatches.slice(-4);
      const recentPoints = recentMatches.reduce(
        (acc, m) => acc + numberValue(m.total_points),
        0
      );
      copy.form = Math.round((recentPoints / recentMatches.length) * 10) / 10;
    } else {
      copy.form = 0;
    }

    copy.appearances = appearances;
    copy._reconstructed_from_history = true;
    copy._history_rounds_used = completedMatches.map((m) => m.round);
    copy._in_progress_rounds_excluded = history
      .filter(
        (m) =>
          typeof m === "object" &&
          typeof m.round === "number" &&
          m.round > cutoff
      )
      .map((m) => m.round);
  } else if (inProgressGw !== null) {
    // When an in-progress GW is active without individual history, exclude live event_points from historical ranking
    copy.event_points = null;
  }

  return copy;
}

export function derivePlayerAppearances(
  player: Record<string, any>,
  recentHistory?: Array<Record<string, any>> | null,
  boundary?: GameweekBoundary | null
): DataValue {
  const cutoff = boundary?.historical_cutoff_gameweek ?? null;

  // 1. Official FPL player match history (element-summary history)
  if (Array.isArray(recentHistory)) {
    const historicalMatches = recentHistory.filter(
      (item) =>
        typeof item === "object" &&
        typeof item.round === "number" &&
        (cutoff === null || item.round <= cutoff)
    );

    if (historicalMatches.length > 0) {
      const appearancesCount = historicalMatches.filter(
        (m) => numberValue(m.minutes) > 0
      ).length;

      if (appearancesCount === 0) {
        return new DataValue({
          value: 0,
          validity: DataValidity.OBSERVED_ZERO,
          source: "fpl_player_history",
          as_of_gameweek: cutoff,
          reason: "Player has 0 appearances with minutes > 0 across completed matches in history.",
        });
      }
      return new DataValue({
        value: appearancesCount,
        validity: DataValidity.DERIVED,
        source: "fpl_player_history",
        as_of_gameweek: cutoff,
        reason: `Derived from ${appearancesCount} matches with minutes > 0 up to GW ${cutoff ?? "current"}.`,
      });
    }
  }

  // 2. Explicit numeric appearances in player object (if provided by custom input or already reconstructed)
  if (
    player.appearances !== undefined &&
    player.appearances !== null &&
    player.appearances !== "" &&
    !isNaN(Number(player.appearances))
  ) {
    const numericApp = Number(player.appearances);
    const source = player._reconstructed_from_history ? "fpl_player_history" : "fpl_input";
    if (numericApp === 0) {
      return new DataValue({
        value: 0,
        validity: DataValidity.OBSERVED_ZERO,
        source,
        as_of_gameweek: cutoff,
        reason: "Observed zero appearances provided in player input.",
      });
    }
    return new DataValue({
      value: numericApp,
      validity: player._reconstructed_from_history ? DataValidity.DERIVED : DataValidity.OBSERVED,
      source,
      as_of_gameweek: cutoff,
      reason: "Observed appearances provided in player input.",
    });
  }

  // 3. Fallback when appearances is genuinely missing (e.g. bootstrap static without loaded summary)
  return new DataValue({
    value: null,
    validity: DataValidity.MISSING,
    source: "fpl_missing",
    as_of_gameweek: cutoff,
    reason: "Appearances not present in FPL bootstrap-static and match history not loaded for bulk scoring.",
  });
}

function evidenceConfidenceFactor(
  player: Record<string, any>,
  referenceGameweek: number
): number {
  const minutesEvidence = clamp(numberValue(player.minutes) / 450.0, 0.0, 1.0);
  const gameweekEvidence = clamp(Math.max(referenceGameweek, 0) / 5.0, 0.0, 1.0);
  return clamp(minutesEvidence * 0.65 + gameweekEvidence * 0.35, 0.0, 1.0);
}

export function dataConfidence(
  player: Record<string, any>,
  referenceGameweek: number,
  diagnosticDetails?: {
    appearancesMissing?: boolean;
    teamStrengthInvalid?: boolean;
    excludedMetricCount?: number;
  }
): [number, string] {
  let confidence = evidenceConfidenceFactor(player, referenceGameweek);

  if (diagnosticDetails?.appearancesMissing) {
    confidence -= 0.05;
  }
  if (diagnosticDetails?.teamStrengthInvalid) {
    confidence -= 0.05;
  }
  if (diagnosticDetails?.excludedMetricCount && diagnosticDetails.excludedMetricCount > 0) {
    confidence -= Math.min(0.10, diagnosticDetails.excludedMetricCount * 0.02);
  }

  confidence = clamp(confidence, 0.0, 1.0);

  if (confidence >= 0.72) {
    return [Math.round(confidence * 1000) / 10, "High"];
  }
  if (confidence >= 0.40) {
    return [Math.round(confidence * 1000) / 10, "Medium"];
  }
  return [Math.round(confidence * 1000) / 10, "Low"];
}

export function metricScore(
  player: Record<string, any>,
  peers: Array<Record<string, any>>,
  key: string,
  referenceGameweek: number
): { score: number | null; validity: DataValidity } {
  const raw = rawValue(player, key);
  if (raw === null) {
    return { score: null, validity: DataValidity.MISSING };
  }

  const peerValues: number[] = [];
  for (const peer of peers) {
    const val = rawValue(peer, key);
    if (val !== null) peerValues.push(val);
  }

  let score = percentile(raw, peerValues);
  if (EARLY_REGRESSION_KEYS.has(key) && referenceGameweek < 5) {
    const confidence = evidenceConfidenceFactor(player, referenceGameweek);
    score = 50.0 + (score - 50.0) * confidence;
  }
  return {
    score: clamp(score, COMPONENT_MIN, COMPONENT_MAX),
    validity: raw === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED,
  };
}

export interface WeightedPercentileResult {
  score: number;
  diagnostic: {
    excluded_metrics: string[];
    original_weights: Record<string, number>;
    effective_weights: Record<string, number>;
    renormalized: boolean;
  };
}

export function weightedPercentile(
  player: Record<string, any>,
  peers: Array<Record<string, any>>,
  weights: Record<string, number>,
  referenceGameweek: number
): WeightedPercentileResult {
  const excludedMetrics: string[] = [];
  const validWeights: Record<string, number> = {};
  const effectiveWeights: Record<string, number> = {};
  const metricScores: Record<string, number> = {};

  for (const [key, originalWeight] of Object.entries(weights)) {
    const res = metricScore(player, peers, key, referenceGameweek);
    if (res.score !== null) {
      validWeights[key] = originalWeight;
      metricScores[key] = res.score;
    } else {
      excludedMetrics.push(key);
    }
  }

  const totalValidWeight = Object.values(validWeights).reduce((a, b) => a + b, 0);

  if (totalValidWeight > 0) {
    for (const [key, originalWeight] of Object.entries(validWeights)) {
      effectiveWeights[key] = originalWeight / totalValidWeight;
    }
    let score = 0.0;
    for (const [key, effWeight] of Object.entries(effectiveWeights)) {
      score += metricScores[key] * effWeight;
    }
    return {
      score: clamp(score),
      diagnostic: {
        excluded_metrics: excludedMetrics,
        original_weights: weights,
        effective_weights: effectiveWeights,
        renormalized: excludedMetrics.length > 0,
      },
    };
  }

  return {
    score: 50.0,
    diagnostic: {
      excluded_metrics: Object.keys(weights),
      original_weights: weights,
      effective_weights: {},
      renormalized: true,
    },
  };
}

export function chanceScore(player: Record<string, any>): number {
  const chance = rawValue(player, "chance_of_playing_next_round");
  if (chance !== null) {
    return clamp(chance);
  }
  const status = String(player.status || "");
  return STATUS_AVAILABILITY[status] ?? 50.0;
}

export function availabilityPenalty(player: Record<string, any>): number {
  const status = String(player.status || "");
  const chance = chanceScore(player);
  const statusPenalties: Record<string, number> = {
    a: 0.0,
    d: 10.0,
    i: 25.0,
    n: 35.0,
    s: 35.0,
    u: 35.0,
  };
  const statusPenalty = statusPenalties[status] ?? 8.0;
  const chancePenalty = Math.max(0.0, (75.0 - chance) * 0.16);
  return Math.round(clamp(statusPenalty + chancePenalty, 0.0, 45.0) * 100) / 100;
}

export interface MinutesProfileResult {
  minutesProxy: number;
  minutesSecurity: number;
  seasonMinutesRate: number;
  startsRate: number;
  appearancesRate: number | null;
  appearancesExcluded: boolean;
  renormalized: boolean;
  originalWeights: Record<string, number>;
  effectiveWeights: Record<string, number>;
}

export function minutesProfile(
  player: Record<string, any>,
  referenceGameweek: number,
  appearancesDataValue: DataValue,
  boundary?: GameweekBoundary | null
): MinutesProfileResult {
  const cutoff = boundary?.historical_cutoff_gameweek ?? referenceGameweek;
  const gameweeksPlayed = Math.max(1, cutoff > 0 ? cutoff : referenceGameweek);
  const expectedMinutes = gameweeksPlayed * 90;

  const seasonMinutesRate = clamp(
    (numberValue(player.minutes) / expectedMinutes) * 100
  );
  const startsRate = clamp(
    (numberValue(player.starts) / gameweeksPlayed) * 100
  );

  const originalWeights = {
    minutes: 0.55,
    starts: 0.30,
    appearances: 0.15,
  };

  let minutesProxy: number;
  let appearancesRate: number | null = null;
  let appearancesExcluded = false;
  let renormalized = false;
  let effectiveWeights: Record<string, number>;

  // If appearances is genuinely missing / null, exclude it and renormalize 55/85 and 30/85
  if (
    appearancesDataValue.validity === DataValidity.MISSING ||
    appearancesDataValue.validity === DataValidity.INVALID ||
    appearancesDataValue.value === null
  ) {
    appearancesExcluded = true;
    renormalized = true;
    const wMinutes = 0.55 / 0.85; // ~0.6470588
    const wStarts = 0.30 / 0.85;  // ~0.3529412
    effectiveWeights = {
      minutes: Math.round(wMinutes * 10000) / 10000,
      starts: Math.round(wStarts * 10000) / 10000,
      appearances: 0.0,
    };
    minutesProxy = seasonMinutesRate * wMinutes + startsRate * wStarts;
  } else {
    // Observed zero (value: 0) or observed / derived > 0
    const appVal = numberValue(appearancesDataValue.value);
    appearancesRate = clamp((appVal / gameweeksPlayed) * 100);
    effectiveWeights = { ...originalWeights };
    minutesProxy =
      seasonMinutesRate * 0.55 + startsRate * 0.30 + appearancesRate * 0.15;
  }

  const chance = chanceScore(player);
  // Shared scoring pipeline: recentSecurity is minutesProxy across all routes to prevent route divergence
  const recentSecurity = minutesProxy;
  const minutesSecurity = clamp(
    minutesProxy * 0.45 + recentSecurity * 0.35 + chance * 0.20
  );

  return {
    minutesProxy: clamp(minutesProxy),
    minutesSecurity: clamp(minutesSecurity),
    seasonMinutesRate,
    startsRate,
    appearancesRate,
    appearancesExcluded,
    renormalized,
    originalWeights,
    effectiveWeights,
  };
}

export function fixtureScore(player: Record<string, any>): number {
  const next3 = rawValue(player, "next_3_avg_difficulty");
  const next5 = rawValue(player, "next_5_avg_difficulty");
  const next3Score = next3 === null ? 25.0 : clamp(((5.0 - next3) / 4.0) * 100);
  const next5Score = next5 === null ? 25.0 : clamp(((5.0 - next5) / 4.0) * 100);
  const fixtures = Array.isArray(player.next_5_fixtures)
    ? player.next_5_fixtures
    : [];
  let homeAwayScore = 25.0;
  if (fixtures.length > 0) {
    const homeCount = fixtures.filter((f) => f.venue === "H").length;
    homeAwayScore = (homeCount / fixtures.length) * 100;
  }
  return clamp(next3Score * 0.50 + next5Score * 0.35 + homeAwayScore * 0.15);
}

export interface TeamContextResult {
  score: number;
  diagnostic: {
    attack_valid: boolean;
    defence_valid: boolean;
    excluded_components: string[];
    original_weights: Record<string, number>;
    effective_weights: Record<string, number>;
    renormalized: boolean;
  };
}

export function teamContextScore(
  player: Record<string, any>,
  teamPeers: Array<Record<string, any>>
): TeamContextResult {
  const position = player.element_type;
  const isDefensive = position === 1 || position === 2;

  const originalWeights: Record<string, number> = isDefensive
    ? { attack: 0.20, defence: 0.50, ownership: 0.15, transfers: 0.15 }
    : { attack: 0.45, defence: 0.10, ownership: 0.25, transfers: 0.20 };

  const attackValid =
    player.team_attack_strength !== null &&
    player.team_attack_strength !== undefined &&
    player.team_attack_strength_validity !== DataValidity.INVALID &&
    player.team_attack_strength_validity !== DataValidity.MISSING;

  const defenceValid =
    player.team_defence_strength !== null &&
    player.team_defence_strength !== undefined &&
    player.team_defence_strength_validity !== DataValidity.INVALID &&
    player.team_defence_strength_validity !== DataValidity.MISSING;

  const validWeights: Record<string, number> = {};
  const componentScores: Record<string, number> = {};
  const excludedComponents: string[] = [];

  // 1. Attack strength
  if (attackValid) {
    const attackValues = teamPeers
      .map((p) => rawValue(p, "team_attack_strength"))
      .filter((v): v is number => v !== null);
    componentScores["attack"] = percentile(
      rawValue(player, "team_attack_strength"),
      attackValues
    );
    validWeights["attack"] = originalWeights.attack;
  } else {
    excludedComponents.push("attack");
  }

  // 2. Defence strength
  if (defenceValid) {
    const defenceValues = teamPeers
      .map((p) => rawValue(p, "team_defence_strength"))
      .filter((v): v is number => v !== null);
    componentScores["defence"] = percentile(
      rawValue(player, "team_defence_strength"),
      defenceValues
    );
    validWeights["defence"] = originalWeights.defence;
  } else {
    excludedComponents.push("defence");
  }

  // 3. Ownership
  const ownershipVal = rawValue(player, "selected_by_percent");
  if (ownershipVal !== null) {
    const ownershipPeers = teamPeers
      .map((p) => rawValue(p, "selected_by_percent"))
      .filter((v): v is number => v !== null);
    componentScores["ownership"] = percentile(ownershipVal, ownershipPeers);
    validWeights["ownership"] = originalWeights.ownership;
  } else {
    excludedComponents.push("ownership");
  }

  // 4. Short-term Event Transfer Signal (current_gameweek)
  const transferVal =
    player.transfer_signal !== undefined && player.transfer_signal !== null
      ? numberValue(player.transfer_signal)
      : numberValue(player.transfers_in_event) - numberValue(player.transfers_out_event);

  const transferValues = teamPeers.map((p) =>
    p.transfer_signal !== undefined && p.transfer_signal !== null
      ? numberValue(p.transfer_signal)
      : numberValue(p.transfers_in_event) - numberValue(p.transfers_out_event)
  );

  componentScores["transfers"] = percentile(transferVal, transferValues);
  validWeights["transfers"] = originalWeights.transfers;

  // Weight Renormalization
  const totalValidWeight = Object.values(validWeights).reduce((a, b) => a + b, 0);
  const effectiveWeights: Record<string, number> = {};

  if (totalValidWeight > 0) {
    for (const [key, origWeight] of Object.entries(validWeights)) {
      effectiveWeights[key] = origWeight / totalValidWeight;
    }
    let score = 0.0;
    for (const [key, effWeight] of Object.entries(effectiveWeights)) {
      score += componentScores[key] * effWeight;
    }
    return {
      score: clamp(score),
      diagnostic: {
        attack_valid: attackValid,
        defence_valid: defenceValid,
        excluded_components: excludedComponents,
        original_weights: originalWeights,
        effective_weights: effectiveWeights,
        renormalized: excludedComponents.length > 0,
      },
    };
  }

  return {
    score: 50.0,
    diagnostic: {
      attack_valid: attackValid,
      defence_valid: defenceValid,
      excluded_components: Object.keys(originalWeights),
      original_weights: originalWeights,
      effective_weights: {},
      renormalized: true,
    },
  };
}

function ratingLabel(score: number): string {
  if (score >= 90) return "Elite";
  if (score >= 80) return "Excellent";
  if (score >= 70) return "Strong";
  if (score >= 60) return "Decent";
  if (score >= 50) return "Average";
  return "Weak";
}

function explanation(
  fixtureScoreVal: number,
  attackingScoreVal: number,
  minutesSecurityVal: number,
  valueScoreVal: number,
  availabilityPenaltyVal: number
): string {
  const drivers: string[] = [];
  if (fixtureScoreVal >= 70) drivers.push("strong upcoming fixtures");
  else if (fixtureScoreVal <= 35) drivers.push("difficult upcoming fixtures");

  if (attackingScoreVal >= 70) drivers.push("high xGI and attacking metrics");
  else if (attackingScoreVal <= 35) drivers.push("limited attacking output");

  if (minutesSecurityVal >= 70) drivers.push("secure minutes");
  else if (minutesSecurityVal <= 35) drivers.push("limited or uncertain minutes");

  if (valueScoreVal >= 70) drivers.push("good value");
  if (availabilityPenaltyVal >= 10) drivers.push("an availability concern");

  if (drivers.length === 0) drivers.push("balanced underlying numbers");
  const first = drivers[0];
  return `${first.charAt(0).toUpperCase() + first.slice(1)} are driving this score.`;
}

export function playerRating(
  player: Record<string, any>,
  positionPeers: Array<Record<string, any>>,
  allPlayers: Array<Record<string, any>>,
  referenceGameweek: number,
  options?: {
    boundary?: GameweekBoundary | null;
    snapshot?: PredictionSnapshot | null;
    recentHistory?: Array<Record<string, any>> | null;
  }
): Record<string, any> {
  const boundary = options?.boundary ?? null;
  const snapshot = options?.snapshot ?? null;
  const recentHistory = options?.recentHistory ?? null;

  // Reconstruct player for cutoff if not already reconstructed
  const activePlayer = player._reconstructed_from_history
    ? player
    : reconstructPlayerForCutoff(player, recentHistory, boundary);

  let position = activePlayer.element_type;
  if (!CURRENT_WEIGHTS[position]) {
    position = 3;
  }

  // 1. Appearances resolution
  const appearancesDataValue = derivePlayerAppearances(
    activePlayer,
    recentHistory,
    boundary
  );

  // 2. Weighted form & attacking scores
  const formResult = weightedPercentile(
    activePlayer,
    positionPeers,
    CURRENT_WEIGHTS[position],
    referenceGameweek
  );
  const currentFormScore = formResult.score;

  const attackingResult = weightedPercentile(
    activePlayer,
    positionPeers,
    ATTACKING_WEIGHTS[position],
    referenceGameweek
  );
  const attackingScore = attackingResult.score;

  // 3. Minutes Profile
  const minutesResult = minutesProfile(
    activePlayer,
    referenceGameweek,
    appearancesDataValue,
    boundary
  );
  const minutesProxy = minutesResult.minutesProxy;
  const minutesSecurity = minutesResult.minutesSecurity;

  // 4. Fixture and Context
  const fixtureScoreVal = fixtureScore(activePlayer);
  const contextResult = teamContextScore(activePlayer, allPlayers);
  const contextScore = contextResult.score;

  const chanceScoreVal = chanceScore(activePlayer);
  const availPenalty = availabilityPenalty(activePlayer);

  const futureFplScore = clamp(
    fixtureScoreVal * 0.42 +
      attackingScore * 0.34 +
      minutesSecurity * 0.20 +
      contextScore * 0.02 +
      chanceScoreVal * 0.02
  );

  const price = Math.max(numberValue(activePlayer.now_cost) / 10.0, 0.1);
  const valueRatio = futureFplScore / price;
  const valueRatios = positionPeers.map((peer) =>
    clamp(
      numberValue(peer.future_fpl_score) /
        Math.max(numberValue(peer.now_cost) / 10.0, 0.1)
    )
  );
  const valuePercentile = percentile(valueRatio, valueRatios);
  const confidenceFactor = evidenceConfidenceFactor(activePlayer, referenceGameweek);
  const valueScore = clamp(
    50.0 + (valuePercentile - 50.0) * 0.55 * Math.max(0.35, confidenceFactor)
  );

  const minutesPenalty =
    Math.round(Math.max(0.0, (50.0 - minutesProxy) * 0.16) * 100) / 100;
  const weightedScore =
    currentFormScore * 0.37 + futureFplScore * 0.55 + valueScore * 0.08;
  const expertScore = clamp(weightedScore - availPenalty - minutesPenalty);

  const allExcludedMetrics = [
    ...formResult.diagnostic.excluded_metrics,
    ...attackingResult.diagnostic.excluded_metrics,
    ...contextResult.diagnostic.excluded_components,
  ];

  const wasRenormalized =
    formResult.diagnostic.renormalized ||
    attackingResult.diagnostic.renormalized ||
    contextResult.diagnostic.renormalized ||
    minutesResult.renormalized;

  const [confScore, confLabel] = dataConfidence(activePlayer, referenceGameweek, {
    appearancesMissing: appearancesDataValue.validity === DataValidity.MISSING,
    teamStrengthInvalid:
      !contextResult.diagnostic.attack_valid || !contextResult.diagnostic.defence_valid,
    excludedMetricCount: allExcludedMetrics.length,
  });

  const breakdown = {
    form_contribution: Math.round(currentFormScore * 0.37 * 10) / 10,
    fixture_contribution: Math.round(fixtureScoreVal * 0.55 * 0.42 * 10) / 10,
    attacking_contribution: Math.round(attackingScore * 0.55 * 0.34 * 10) / 10,
    minutes_security_contribution:
      Math.round(minutesSecurity * 0.55 * 0.20 * 10) / 10,
    context_contribution: Math.round(contextScore * 0.55 * 0.02 * 10) / 10,
    value_contribution: Math.round(valueScore * 0.08 * 10) / 10,
    availability_penalty: availPenalty,
    minutes_penalty: minutesPenalty,
    weighted_before_penalties: Math.round(weightedScore * 10) / 10,
    excluded_metrics: allExcludedMetrics,
    renormalized: wasRenormalized,
    minutes_proxy_renormalized: minutesResult.renormalized,
    team_strength_valid:
      contextResult.diagnostic.attack_valid && contextResult.diagnostic.defence_valid,
  };

  const transfersInEvent =
    activePlayer.transfers_in_event !== undefined
      ? numberValue(activePlayer.transfers_in_event)
      : numberValue(activePlayer.transfers_in_gameweek);
  const transfersOutEvent =
    activePlayer.transfers_out_event !== undefined
      ? numberValue(activePlayer.transfers_out_event)
      : numberValue(activePlayer.transfers_out_gameweek);
  const transferSignal = transfersInEvent - transfersOutEvent;

  return {
    current_form_score: Math.round(currentFormScore * 10) / 10,
    future_fpl_score: Math.round(futureFplScore * 10) / 10,
    value_score: Math.round(valueScore * 10) / 10,
    expert_score: Math.round(expertScore * 10) / 10,
    rating_label: ratingLabel(expertScore),
    minutes_security: Math.round(minutesSecurity * 10) / 10,
    expected_minutes_proxy: Math.round(minutesProxy * 10) / 10,
    fixture_score: Math.round(fixtureScoreVal * 10) / 10,
    attacking_score: Math.round(attackingScore * 10) / 10,
    availability_score: Math.round(chanceScoreVal * 10) / 10,
    team_context_score: Math.round(contextScore * 10) / 10,
    rating_breakdown: breakdown,
    data_confidence_score: confScore,
    data_confidence: confLabel,
    rating_explanation: explanation(
      fixtureScoreVal,
      attackingScore,
      minutesSecurity,
      valueScore,
      availPenalty
    ),
    position_label: POSITION_LABELS[position] ?? "Unknown",

    // Phase 1 Contract and Diagnostic fields
    snapshot_id: snapshot?.snapshot_id ?? "live_runtime_snapshot",
    snapshot_created_at: snapshot?.snapshot_created_at ?? new Date().toISOString(),
    last_finished_gameweek: boundary?.last_finished_gameweek ?? null,
    in_progress_gameweek: boundary?.in_progress_gameweek ?? null,
    prediction_gameweek: boundary?.prediction_gameweek ?? null,
    historical_cutoff_gameweek: boundary?.historical_cutoff_gameweek ?? null,

    // Appearances data contract
    appearances_data_value: appearancesDataValue.toDict(),
    appearances_value: appearancesDataValue.value,
    appearances_validity: appearancesDataValue.validity,
    appearances_source: appearancesDataValue.source,

    // Historical reconstruction & leakage protection metadata
    history_rounds_used: activePlayer._history_rounds_used ?? [],
    in_progress_rounds_excluded: activePlayer._in_progress_rounds_excluded ?? [],
    reconstructed_from_history: !!activePlayer._reconstructed_from_history,

    // Transfer semantics contract
    transfer_signal: transferSignal,
    transfer_signal_horizon: "current_gameweek",
    cumulative_transfers_in: numberValue(activePlayer.transfers_in),
    cumulative_transfers_out: numberValue(activePlayer.transfers_out),
    cumulative_transfer_signal:
      numberValue(activePlayer.transfers_in) - numberValue(activePlayer.transfers_out),
    cumulative_transfer_horizon: "season_to_date",

    // Team strength validity contract
    team_strength_validity:
      contextResult.diagnostic.attack_valid && contextResult.diagnostic.defence_valid
        ? DataValidity.OBSERVED
        : DataValidity.INVALID,

    // Diagnostics
    diagnostics: {
      form_diagnostic: formResult.diagnostic,
      attacking_diagnostic: attackingResult.diagnostic,
      context_diagnostic: contextResult.diagnostic,
      minutes_profile: {
        season_minutes_rate: minutesResult.seasonMinutesRate,
        starts_rate: minutesResult.startsRate,
        appearances_rate: minutesResult.appearancesRate,
        appearances_excluded: minutesResult.appearancesExcluded,
        renormalized: minutesResult.renormalized,
        original_weights: minutesResult.originalWeights,
        effective_weights: minutesResult.effectiveWeights,
      },
      excluded_metrics: allExcludedMetrics,
      renormalized: wasRenormalized,
    },
  };
}

export function addRatings(
  players: Array<Record<string, any>>,
  options: {
    referenceGameweek: number;
    boundary?: GameweekBoundary | null;
    snapshot?: PredictionSnapshot | null;
    recentHistoryByPlayer?: Record<number, Array<Record<string, any>>> | null;
  }
): Array<Record<string, any>> {
  const {
    referenceGameweek,
    boundary = null,
    snapshot = null,
    recentHistoryByPlayer = null,
  } = options;

  // Reconstruct all players up to historical cutoff before peer grouping
  const reconstructedPlayers: Array<Record<string, any>> = [];
  for (const p of players) {
    const hist = recentHistoryByPlayer?.[p.id] ?? p._history ?? null;
    const reconstructed = reconstructPlayerForCutoff(p, hist, boundary);
    reconstructedPlayers.push(reconstructed);
  }

  const byPosition: Record<number, Array<Record<string, any>>> = {};
  for (const player of reconstructedPlayers) {
    const pos = player.element_type;
    if (!byPosition[pos]) byPosition[pos] = [];
    byPosition[pos].push(player);
  }

  // First pass: compute preliminary future_fpl_score for price-to-value percentiles
  const preparedPlayers: Array<Record<string, any>> = [];
  for (const player of reconstructedPlayers) {
    const playerCopy = { ...player };
    const position = player.element_type;
    const peers = byPosition[position] || [player];
    const fixScore = fixtureScore(playerCopy);
    const atkResult = weightedPercentile(
      playerCopy,
      peers,
      ATTACKING_WEIGHTS[position] || ATTACKING_WEIGHTS[3],
      referenceGameweek
    );
    const appDataVal = derivePlayerAppearances(
      playerCopy,
      recentHistoryByPlayer?.[playerCopy.id] ?? playerCopy._history ?? null,
      boundary
    );
    const minResult = minutesProfile(
      playerCopy,
      referenceGameweek,
      appDataVal,
      boundary
    );
    const chScore = chanceScore(playerCopy);
    const ctxResult = teamContextScore(playerCopy, reconstructedPlayers);

    playerCopy.future_fpl_score = clamp(
      fixScore * 0.42 +
        atkResult.score * 0.34 +
        minResult.minutesSecurity * 0.20 +
        ctxResult.score * 0.02 +
        chScore * 0.02
    );
    preparedPlayers.push(playerCopy);
  }

  const preparedByPosition: Record<number, Array<Record<string, any>>> = {};
  for (const player of preparedPlayers) {
    const pos = player.element_type;
    if (!preparedByPosition[pos]) preparedByPosition[pos] = [];
    preparedByPosition[pos].push(player);
  }

  // Second pass: full playerRating calculation
  const ratedPlayers: Array<Record<string, any>> = [];
  for (const player of preparedPlayers) {
    const position = player.element_type;
    const playerHist = recentHistoryByPlayer?.[player.id] ?? player._history ?? null;
    const rated = playerRating(
      player,
      preparedByPosition[position] || [player],
      preparedPlayers,
      referenceGameweek,
      {
        boundary,
        snapshot,
        recentHistory: playerHist,
      }
    );
    ratedPlayers.push({
      ...player,
      ...rated,
    });
  }

  return ratedPlayers;
}
