import {
  DataValidity,
  DataValue,
  DataValueDict,
  GameweekBoundary,
  PredictionSnapshot,
  PredictionOutput,
  PredictionRange,
  EXPECTED_POINTS_UNAVAILABLE_REASON,
  LEGACY_RANK_SCORE_SOURCE,
} from "./prediction_contract.js";
import {
  CanonicalPlayerFeatures,
  FixtureContextItem,
} from "./prediction_features.js";

export const MINUTES_MODEL_VERSION = "expected-minutes.v1";

export interface StatusAvailabilityFallback {
  probability: number;
  validity: DataValidity;
  reason: string;
}

export const STATUS_AVAILABILITY_CONFIG: Record<string, StatusAvailabilityFallback> = {
  a: {
    probability: 0.95,
    validity: DataValidity.DERIVED,
    reason: "Status 'a' (Available); heuristic fallback probability 0.95 (official chance missing).",
  },
  d: {
    probability: 0.50,
    validity: DataValidity.DERIVED,
    reason: "Status 'd' (Doubtful); heuristic fallback probability 0.50 (official chance missing).",
  },
  i: {
    probability: 0.00,
    validity: DataValidity.OBSERVED_ZERO,
    reason: "Status 'i' (Injured); 0.00 availability.",
  },
  s: {
    probability: 0.00,
    validity: DataValidity.OBSERVED_ZERO,
    reason: "Status 's' (Suspended); 0.00 availability.",
  },
  n: {
    probability: 0.00,
    validity: DataValidity.OBSERVED_ZERO,
    reason: "Status 'n' (Not available); 0.00 availability.",
  },
  u: {
    probability: 0.00,
    validity: DataValidity.OBSERVED_ZERO,
    reason: "Status 'u' (Unavailable); 0.00 availability.",
  },
};

export interface PositionPriorConfig {
  prior_appearance_rate: number;
  prior_start_rate: number;
  prior_60plus_rate_given_start: number;
  default_expected_mins_when_started: number;
  default_expected_mins_as_sub: number;
  prior_sample_weight: number;
}

export const POSITION_PRIORS: Record<number, PositionPriorConfig> = {
  // Goalkeepers: higher role stability, lower prior sample weight, 90 mins standard
  1: {
    prior_appearance_rate: 0.50,
    prior_start_rate: 0.50,
    prior_60plus_rate_given_start: 0.98,
    default_expected_mins_when_started: 90.0,
    default_expected_mins_as_sub: 30.0,
    prior_sample_weight: 1.0,
  },
  // Defenders
  2: {
    prior_appearance_rate: 0.50,
    prior_start_rate: 0.45,
    prior_60plus_rate_given_start: 0.88,
    default_expected_mins_when_started: 85.0,
    default_expected_mins_as_sub: 22.0,
    prior_sample_weight: 1.5,
  },
  // Midfielders
  3: {
    prior_appearance_rate: 0.55,
    prior_start_rate: 0.45,
    prior_60plus_rate_given_start: 0.80,
    default_expected_mins_when_started: 80.0,
    default_expected_mins_as_sub: 24.0,
    prior_sample_weight: 1.5,
  },
  // Forwards
  4: {
    prior_appearance_rate: 0.55,
    prior_start_rate: 0.45,
    prior_60plus_rate_given_start: 0.78,
    default_expected_mins_when_started: 78.0,
    default_expected_mins_as_sub: 22.0,
    prior_sample_weight: 1.5,
  },
};

const DEFAULT_PRIORS: PositionPriorConfig = {
  prior_appearance_rate: 0.50,
  prior_start_rate: 0.45,
  prior_60plus_rate_given_start: 0.85,
  default_expected_mins_when_started: 80.0,
  default_expected_mins_as_sub: 22.0,
  prior_sample_weight: 1.5,
};

export interface SupportingHistoryEvidence {
  completed_gameweeks_count: number;
  season_appearances: number;
  season_starts: number;
  season_sub_appearances: number;
  season_sixty_plus_appearances: number;
  season_zero_minute_gws: number;
  consecutive_starts: number;
  consecutive_appearances: number;
  consecutive_zero_minute_gws: number;
  effective_starts: number;
  effective_appearances: number;
  total_match_weight: number;
  recency_start_rate: number | null;
  recency_appearance_rate: number | null;
  minutes_completeness_ratio: number;
  starts_sample_size: number;
  substitute_appearance_sample_size: number;
  average_minutes_when_started: number;
  average_minutes_as_substitute: number;
  starts_fallback_used: boolean;
  sub_fallback_used: boolean;
  recent_3_gw_start_rate: number | null;
  recent_5_gw_start_rate: number | null;
  recent_3_gw_appearance_rate: number | null;
  recent_5_gw_appearance_rate: number | null;
  recent_3_gw_60_plus_rate: number | null;
  recent_5_gw_60_plus_rate: number | null;
}

export interface MinutesModelBreakdown {
  player_id: number;
  model_version: string;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  position_id: number;
  fixture_count: number;
  gameweek_type: string;

  availability: {
    status: string;
    official_chance_next: number | null;
    fallback_used: boolean;
    fallback_reason: string | null;
    probability_available: number;
  };

  historical_evidence: SupportingHistoryEvidence;

  shrinkage: {
    prior_sample_weight: number;
    sample_size: number;
    total_match_weight: number;
    prior_appearance_rate: number;
    raw_appearance_rate: number;
    recency_appearance_rate: number;
    shrunk_appearance_rate: number;
    prior_start_rate: number;
    raw_start_rate: number;
    recency_start_rate: number;
    shrunk_start_rate: number;
    prior_60plus_rate: number;
    raw_60plus_rate: number;
    shrunk_60plus_rate: number;
  };

  conditional_probabilities: {
    probability_appearance_given_available: number;
    probability_start_given_available: number;
    probability_60_plus_given_available: number;
  };

  probabilities: {
    probability_available: number;
    probability_appearance: number;
    probability_start: number;
    probability_60_plus_minutes: number;
  };

  playing_time_confidence: {
    value: number;
    sample_factor: number;
    availability_factor: number;
    role_clarity_factor: number;
    validity: DataValidity;
  };

  minutes_decomposition: {
    expected_minutes_when_started: number;
    expected_minutes_as_substitute: number;
    start_contribution: number;
    substitute_contribution: number;
    single_fixture_expected_minutes: number;
    total_expected_minutes: number;
  };

  per_fixture_breakdown?: Array<{
    fixture_id: number;
    opponent_team_id: number;
    is_home: boolean;
    expected_minutes: number;
    probability_appearance: number;
    probability_start: number;
    probability_60_plus_minutes: number;
  }>;
}

export interface PlayerMinutesModelResult {
  player_id: number;
  model_version: string;
  expected_minutes: DataValueDict;
  probability_available: DataValueDict;
  probability_appearance: DataValueDict;
  probability_start: DataValueDict;
  probability_60_plus_minutes: DataValueDict;
  playing_time_confidence: DataValueDict;
  breakdown: MinutesModelBreakdown;
  prediction_output: Record<string, any>;
}

function num(val: any): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

function createDataValueEnvelope(
  value: any,
  validity: DataValidity,
  source: string | null,
  asOfGw: number | null,
  reason: string | null = null
): DataValueDict {
  let adjustedValidity = validity;
  let adjustedValue = value;

  if (
    adjustedValidity === DataValidity.MISSING ||
    adjustedValidity === DataValidity.INVALID ||
    adjustedValidity === DataValidity.NOT_APPLICABLE
  ) {
    adjustedValue = null;
  } else if (
    (adjustedValidity === DataValidity.OBSERVED || adjustedValidity === DataValidity.DERIVED) &&
    adjustedValue === 0
  ) {
    adjustedValidity = DataValidity.OBSERVED_ZERO;
  }

  return new DataValue({
    value: adjustedValue,
    validity: adjustedValidity,
    source,
    as_of_gameweek: asOfGw,
    reason,
  }).toDict();
}

export function deriveSupportingHistoryEvidence(
  history: Array<Record<string, any>> | null,
  cutoffGw: number | null,
  priors: PositionPriorConfig
): SupportingHistoryEvidence {
  if (!history || history.length === 0) {
    return {
      completed_gameweeks_count: 0,
      season_appearances: 0,
      season_starts: 0,
      season_sub_appearances: 0,
      season_sixty_plus_appearances: 0,
      season_zero_minute_gws: 0,
      consecutive_starts: 0,
      consecutive_appearances: 0,
      consecutive_zero_minute_gws: 0,
      effective_starts: 0,
      effective_appearances: 0,
      total_match_weight: 0,
      recency_start_rate: null,
      recency_appearance_rate: null,
      minutes_completeness_ratio: 1.0,
      starts_sample_size: 0,
      substitute_appearance_sample_size: 0,
      average_minutes_when_started: priors.default_expected_mins_when_started,
      average_minutes_as_substitute: priors.default_expected_mins_as_sub,
      starts_fallback_used: true,
      sub_fallback_used: true,
      recent_3_gw_start_rate: null,
      recent_5_gw_start_rate: null,
      recent_3_gw_appearance_rate: null,
      recent_5_gw_appearance_rate: null,
      recent_3_gw_60_plus_rate: null,
      recent_5_gw_60_plus_rate: null,
    };
  }

  // Filter completed matches through cutoff
  const completedMatches: Array<Record<string, any>> = [];
  const matchesByRound = new Map<number, Array<Record<string, any>>>();

  for (const m of history) {
    if (typeof m === "object" && m !== null && typeof m.round === "number") {
      if (cutoffGw === null || m.round <= cutoffGw) {
        completedMatches.push(m);
        const list = matchesByRound.get(m.round) || [];
        list.push(m);
        matchesByRound.set(m.round, list);
      }
    }
  }

  const distinctRounds = Array.from(matchesByRound.keys()).sort((a, b) => a - b);
  const completedGwCount = distinctRounds.length;

  let totalStarts = 0;
  let totalApps = 0;
  let totalSubs = 0;
  let total60Plus = 0;
  let zeroMinuteGwCount = 0;

  let sumStartMins = 0;
  let sumSubMins = 0;

  // Track per-round summary for recency & streak calculations
  const roundSummaries: Array<{
    round: number;
    mins: number;
    isStart: boolean;
    isApp: boolean;
    is60Plus: boolean;
  }> = [];

  for (const round of distinctRounds) {
    const rows = matchesByRound.get(round) || [];
    let roundMins = 0;
    let roundIsStart = false;
    let roundIsApp = false;
    let roundIs60 = false;

    for (const m of rows) {
      const mins = num(m.minutes);
      roundMins += mins;
      const isStart = m.starts !== undefined && m.starts !== null ? num(m.starts) > 0 : mins > 0;

      if (mins > 0) {
        roundIsApp = true;
        totalApps++;
        if (isStart) {
          roundIsStart = true;
          totalStarts++;
          sumStartMins += mins;
        } else {
          totalSubs++;
          sumSubMins += mins;
        }
        if (mins >= 60) {
          roundIs60 = true;
          total60Plus++;
        }
      }
    }

    if (roundMins === 0) {
      zeroMinuteGwCount++;
    }

    roundSummaries.push({
      round,
      mins: roundMins,
      isStart: roundIsStart,
      isApp: roundIsApp,
      is60Plus: roundIs60,
    });
  }

  // Calculate consecutive streaks at the end of cutoff history (from newest backwards)
  let consecutiveStarts = 0;
  let consecutiveApps = 0;
  let consecutiveZero = 0;

  for (let i = roundSummaries.length - 1; i >= 0; i--) {
    if (roundSummaries[i].isStart) {
      consecutiveStarts++;
    } else {
      break;
    }
  }

  for (let i = roundSummaries.length - 1; i >= 0; i--) {
    if (roundSummaries[i].isApp) {
      consecutiveApps++;
    } else {
      break;
    }
  }

  for (let i = roundSummaries.length - 1; i >= 0; i--) {
    if (roundSummaries[i].mins === 0) {
      consecutiveZero++;
    } else {
      break;
    }
  }

  // Recency weighting: linear progression w_k = 0.5 + 0.5 * (k / N)
  let totalMatchWeight = 0;
  let effectiveStarts = 0;
  let effectiveApps = 0;

  const N = roundSummaries.length;
  for (let i = 0; i < N; i++) {
    const k = i + 1;
    const w = N > 1 ? 0.5 + 0.5 * (k / N) : 1.0;
    totalMatchWeight += w;
    if (roundSummaries[i].isStart) effectiveStarts += w;
    if (roundSummaries[i].isApp) effectiveApps += w;
  }

  const recencyStartRate = totalMatchWeight > 0 ? roundTo(effectiveStarts / totalMatchWeight, 4) : null;
  const recencyAppRate = totalMatchWeight > 0 ? roundTo(effectiveApps / totalMatchWeight, 4) : null;

  const avgMinsStarted = totalStarts > 0
    ? roundTo(sumStartMins / totalStarts, 1)
    : priors.default_expected_mins_when_started;

  const avgMinsSub = totalSubs > 0
    ? roundTo(sumSubMins / totalSubs, 1)
    : priors.default_expected_mins_as_sub;

  const completenessRatio = roundTo(Math.min(1.0, Math.max(0.3, avgMinsStarted / 90.0)), 3);

  // Recent 3 & 5 GW rates
  const getRecentRates = (numGws: number) => {
    const targetRounds = distinctRounds.slice(-numGws);
    if (targetRounds.length === 0) return { startRate: null, appRate: null, sixtyRate: null };

    let rStarts = 0;
    let rApps = 0;
    let rSixty = 0;

    for (const r of targetRounds) {
      const rows = matchesByRound.get(r) || [];
      for (const m of rows) {
        const mins = num(m.minutes);
        const isStart = m.starts !== undefined && m.starts !== null ? num(m.starts) > 0 : mins > 0;
        if (isStart) rStarts++;
        if (mins > 0) rApps++;
        if (mins >= 60) rSixty++;
      }
    }

    return {
      startRate: roundTo(rStarts / targetRounds.length, 3),
      appRate: roundTo(rApps / targetRounds.length, 3),
      sixtyRate: roundTo(rSixty / targetRounds.length, 3),
    };
  };

  const recent3 = getRecentRates(3);
  const recent5 = getRecentRates(5);

  return {
    completed_gameweeks_count: completedGwCount,
    season_appearances: totalApps,
    season_starts: totalStarts,
    season_sub_appearances: totalSubs,
    season_sixty_plus_appearances: total60Plus,
    season_zero_minute_gws: zeroMinuteGwCount,
    consecutive_starts: consecutiveStarts,
    consecutive_appearances: consecutiveApps,
    consecutive_zero_minute_gws: consecutiveZero,
    effective_starts: roundTo(effectiveStarts, 3),
    effective_appearances: roundTo(effectiveApps, 3),
    total_match_weight: roundTo(totalMatchWeight, 3),
    recency_start_rate: recencyStartRate,
    recency_appearance_rate: recencyAppRate,
    minutes_completeness_ratio: completenessRatio,
    starts_sample_size: totalStarts,
    substitute_appearance_sample_size: totalSubs,
    average_minutes_when_started: avgMinsStarted,
    average_minutes_as_substitute: avgMinsSub,
    starts_fallback_used: totalStarts === 0,
    sub_fallback_used: totalSubs === 0,
    recent_3_gw_start_rate: recent3.startRate,
    recent_5_gw_start_rate: recent5.startRate,
    recent_3_gw_appearance_rate: recent3.appRate,
    recent_5_gw_appearance_rate: recent5.appRate,
    recent_3_gw_60_plus_rate: recent3.sixtyRate,
    recent_5_gw_60_plus_rate: recent5.sixtyRate,
  };
}

export function buildPlayerExpectedMinutes(options: {
  player: Record<string, any>;
  features: CanonicalPlayerFeatures;
  snapshot: PredictionSnapshot;
  history?: Array<Record<string, any>> | null;
}): PlayerMinutesModelResult {
  const { player, features, snapshot, history = null } = options;
  const cutoffGw = snapshot.boundary.historical_cutoff_gameweek;
  const predGw = snapshot.boundary.prediction_gameweek;
  const positionId = num(player.element_type || features.team_position.player_position.value || 3);
  const priors = POSITION_PRIORS[positionId] || DEFAULT_PRIORS;

  const supportingEvidence = deriveSupportingHistoryEvidence(history, cutoffGw, priors);

  // 1. Availability Layer
  const statusStr = typeof player.status === "string" ? player.status : "a";
  const officialChance = features.availability.chance_of_playing_next_round.value;
  let probAvailable = 0.0;
  let availValidity = DataValidity.DERIVED;
  let availSource = "fpl_bootstrap";
  let availReason: string | null = null;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;

  if (officialChance !== null && officialChance !== undefined) {
    probAvailable = roundTo(Number(officialChance) / 100.0, 4);
    availValidity = probAvailable === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED;
    availSource = "fpl_bootstrap";
    availReason = "Official FPL chance_of_playing_next_round probability.";
  } else {
    const config = STATUS_AVAILABILITY_CONFIG[statusStr] || STATUS_AVAILABILITY_CONFIG.a;
    probAvailable = config.probability;
    availValidity = config.validity;
    availSource = "status_availability_fallback";
    availReason = config.reason;
    fallbackUsed = true;
    fallbackReason = config.reason;
  }

  // 2. Shrinkage & Conditional Selection Estimation (P(event | available))
  const sampleSize = supportingEvidence.completed_gameweeks_count;
  const matchWeight = supportingEvidence.total_match_weight;
  const priorWeight = priors.prior_sample_weight;

  // Base shrunk rates (incorporating recency weights)
  const rawAppRate = sampleSize > 0
    ? roundTo(supportingEvidence.season_appearances / sampleSize, 4)
    : priors.prior_appearance_rate;
  const recencyAppRate = supportingEvidence.recency_appearance_rate ?? rawAppRate;
  const shrunkAppBase = sampleSize > 0
    ? roundTo((supportingEvidence.effective_appearances + priorWeight * priors.prior_appearance_rate) / (matchWeight + priorWeight), 4)
    : priors.prior_appearance_rate;

  const rawStartRate = sampleSize > 0
    ? roundTo(supportingEvidence.season_starts / sampleSize, 4)
    : priors.prior_start_rate;
  const recencyStartRate = supportingEvidence.recency_start_rate ?? rawStartRate;
  const shrunkStartBase = sampleSize > 0
    ? roundTo((supportingEvidence.effective_starts + priorWeight * priors.prior_start_rate) / (matchWeight + priorWeight), 4)
    : priors.prior_start_rate;

  // 60+ Rate Given Start
  const raw60PlusRate = supportingEvidence.season_starts > 0
    ? roundTo(supportingEvidence.season_sixty_plus_appearances / supportingEvidence.season_starts, 4)
    : priors.prior_60plus_rate_given_start;
  const shrunk60PlusRate = supportingEvidence.season_starts > 0
    ? roundTo((supportingEvidence.season_starts * raw60PlusRate + priorWeight * priors.prior_60plus_rate_given_start) / (supportingEvidence.season_starts + priorWeight), 4)
    : priors.prior_60plus_rate_given_start;

  // Role-state & Streak Adjustments for Conditional Probabilities
  let condStartProb = priors.prior_start_rate;
  let condAppProb = priors.prior_appearance_rate;
  let cond60Prob = priors.prior_start_rate * shrunk60PlusRate;

  if (sampleSize === 0) {
    condStartProb = priors.prior_start_rate;
    condAppProb = priors.prior_appearance_rate;
    cond60Prob = roundTo(condStartProb * priors.prior_60plus_rate_given_start, 4);
  } else {
    const cStarts = supportingEvidence.consecutive_starts;
    const cApps = supportingEvidence.consecutive_appearances;
    const cZero = supportingEvidence.consecutive_zero_minute_gws;
    const minsRatio = supportingEvidence.minutes_completeness_ratio;

    let deltaStart = 0.0;
    let deltaBench = 0.0;
    let deltaApp = 0.0;
    let deltaAppBench = 0.0;

    if (positionId === 1) {
      // Goalkeepers: almost 0 rotation for designated starting keeper
      if (cStarts >= 1) {
        deltaStart = Math.min(0.25, 0.10 * cStarts);
      }
      if (cZero >= 1) {
        deltaBench = Math.min(0.30, 0.15 * cZero);
      }
      if (cApps >= 1) {
        deltaApp = Math.min(0.25, 0.10 * cApps);
      }
      if (cZero >= 1) {
        deltaAppBench = Math.min(0.30, 0.15 * cZero);
      }
    } else {
      // Outfielders (DEF, MID, FWD)
      if (cStarts >= 1) {
        deltaStart = Math.min(0.18, 0.06 * cStarts * minsRatio);
      }
      if (cZero >= 1) {
        deltaBench = Math.min(0.20, 0.08 * cZero);
      }
      if (cApps >= 1) {
        deltaApp = Math.min(0.12, 0.04 * cApps);
      }
      if (cZero >= 1) {
        deltaAppBench = Math.min(0.20, 0.08 * cZero);
      }
    }

    condStartProb = roundTo(Math.min(0.98, Math.max(0.02, shrunkStartBase + deltaStart - deltaBench)), 4);
    condAppProb = roundTo(Math.min(0.99, Math.max(0.05, Math.max(condStartProb, shrunkAppBase + deltaApp - deltaAppBench))), 4);
    cond60Prob = roundTo(Math.min(condStartProb, condStartProb * shrunk60PlusRate), 4);
  }

  // Enforce conditional invariant: 0 <= P(60+|avail) <= P(start|avail) <= P(app|avail) <= 1.0
  if (condStartProb > condAppProb) condStartProb = condAppProb;
  if (cond60Prob > condStartProb) cond60Prob = condStartProb;

  // 3. Final Unconditional Probabilities (Availability applied EXACTLY ONCE)
  let probAppearance = 0.0;
  let probStart = 0.0;
  let prob60Plus = 0.0;

  if (probAvailable > 0) {
    probAppearance = roundTo(probAvailable * condAppProb, 4);
    probStart = roundTo(probAvailable * condStartProb, 4);
    prob60Plus = roundTo(probAvailable * cond60Prob, 4);
  }

  // Strict Unconditional Invariant Enforcement:
  // 0 <= P(60+) <= P(start) <= P(appearance) <= P(available) <= 1.0
  if (probStart > probAppearance) probStart = probAppearance;
  if (prob60Plus > probStart) prob60Plus = probStart;
  if (probAppearance > probAvailable) probAppearance = probAvailable;
  if (probAvailable === 0) {
    probAppearance = 0.0;
    probStart = 0.0;
    prob60Plus = 0.0;
  }

  // 4. Playing-Time Confidence (Separated from probability)
  let ptConfidenceVal = 0.0;
  let sampleFactor = 0.0;
  let availFactor = 1.0;
  let roleClarityFactor = 0.8;
  let confidenceValidity = DataValidity.DERIVED;

  if (sampleSize === 0) {
    ptConfidenceVal = 0.0;
    confidenceValidity = DataValidity.MISSING;
  } else {
    sampleFactor = roundTo(1.0 - Math.exp(-sampleSize / 3.5), 3);
    availFactor = fallbackUsed ? 0.85 : 1.0;
    const startClarity = supportingEvidence.recency_start_rate !== null
      ? Math.max(supportingEvidence.recency_start_rate, 1.0 - supportingEvidence.recency_start_rate)
      : 0.5;
    roleClarityFactor = roundTo(0.80 + 0.20 * startClarity, 3);
    ptConfidenceVal = roundTo(sampleFactor * availFactor * roleClarityFactor, 3);
  }

  // 5. Expected Minutes Decomposition for Single Fixture
  const expMinsWhenStarted = supportingEvidence.average_minutes_when_started;
  const expMinsAsSub = supportingEvidence.average_minutes_as_substitute;

  const startContrib = roundTo(probStart * expMinsWhenStarted, 2);
  const subProb = Math.max(0, roundTo(probAppearance - probStart, 4));
  const subContrib = roundTo(subProb * expMinsAsSub, 2);
  let singleFixtureExpMins = roundTo(startContrib + subContrib, 1);
  if (singleFixtureExpMins > 90.0) singleFixtureExpMins = 90.0;
  if (singleFixtureExpMins < 0.0) singleFixtureExpMins = 0.0;

  // 6. Normal / BGW / DGW Behavior
  const fixtureCount = features.fixtures.prediction_gw_fixture_count;
  const gwType = features.fixtures.gameweek_type;

  let finalExpectedMinutes = 0.0;
  let finalProbAvailable = probAvailable;
  let finalProbApp = probAppearance;
  let finalProbStart = probStart;
  let finalProb60 = prob60Plus;

  let minutesValidity = DataValidity.DERIVED;
  let minutesReason: string | null = null;
  let probsValidity = DataValidity.DERIVED;
  let probsReason: string | null = null;

  let perFixtureBreakdown: Array<{
    fixture_id: number;
    opponent_team_id: number;
    is_home: boolean;
    expected_minutes: number;
    probability_appearance: number;
    probability_start: number;
    probability_60_plus_minutes: number;
  }> | undefined;

  if (fixtureCount === 0) {
    // Blank Gameweek (BGW)
    finalExpectedMinutes = 0.0;
    finalProbApp = 0.0;
    finalProbStart = 0.0;
    finalProb60 = 0.0;
    minutesValidity = DataValidity.NOT_APPLICABLE;
    minutesReason = "Blank gameweek; player has no scheduled fixtures.";
    probsValidity = DataValidity.NOT_APPLICABLE;
    probsReason = "Blank gameweek; player has no scheduled fixtures.";
  } else if (fixtureCount === 1) {
    // Normal single-fixture Gameweek
    finalExpectedMinutes = singleFixtureExpMins;
    if (finalExpectedMinutes === 0) minutesValidity = DataValidity.OBSERVED_ZERO;
    if (finalProbApp === 0) probsValidity = DataValidity.OBSERVED_ZERO;
    minutesReason = "Single-fixture expectation decomposed into starting and substitute contributions.";
  } else {
    // Double / Multiple Gameweek (DGW)
    perFixtureBreakdown = features.fixtures.prediction_gw_fixtures.map((fix: FixtureContextItem) => ({
      fixture_id: fix.fixture_id,
      opponent_team_id: fix.opponent_team_id,
      is_home: fix.is_home,
      expected_minutes: singleFixtureExpMins,
      probability_appearance: probAppearance,
      probability_start: probStart,
      probability_60_plus_minutes: prob60Plus,
    }));

    finalExpectedMinutes = roundTo(singleFixtureExpMins * fixtureCount, 1);
    const maxPossibleMins = 90.0 * fixtureCount;
    if (finalExpectedMinutes > maxPossibleMins) finalExpectedMinutes = maxPossibleMins;

    // Gameweek-level appearance probability: 1 - (1 - P(app))^N
    finalProbApp = roundTo(1.0 - Math.pow(1.0 - probAppearance, fixtureCount), 4);
    finalProbStart = roundTo(1.0 - Math.pow(1.0 - probStart, fixtureCount), 4);
    finalProb60 = roundTo(prob60Plus * fixtureCount, 4);
    if (finalProb60 > 1.0) finalProb60 = 1.0;

    minutesReason = `Aggregated across ${fixtureCount} fixtures in Double Gameweek (max ${maxPossibleMins} minutes).`;
  }

  // 7. Value Envelopes
  const expMinsEnvelope = createDataValueEnvelope(
    minutesValidity === DataValidity.NOT_APPLICABLE ? null : finalExpectedMinutes,
    minutesValidity,
    "expected_minutes_model",
    cutoffGw,
    minutesReason
  );

  const probAvailEnvelope = createDataValueEnvelope(
    probAvailable,
    availValidity,
    availSource,
    cutoffGw,
    availReason
  );

  const probAppEnvelope = createDataValueEnvelope(
    probsValidity === DataValidity.NOT_APPLICABLE ? null : finalProbApp,
    probsValidity,
    "expected_minutes_model",
    cutoffGw,
    probsReason || "Appearance probability derived from conditional rate and availability."
  );

  const probStartEnvelope = createDataValueEnvelope(
    probsValidity === DataValidity.NOT_APPLICABLE ? null : finalProbStart,
    probsValidity,
    "expected_minutes_model",
    cutoffGw,
    probsReason || "Start probability derived from conditional start rate and availability."
  );

  const prob60Envelope = createDataValueEnvelope(
    probsValidity === DataValidity.NOT_APPLICABLE ? null : finalProb60,
    probsValidity,
    "expected_minutes_model",
    cutoffGw,
    probsReason || "Probability of playing 60+ minutes derived from start probability and historical completion rate."
  );

  const confidenceEnvelope = createDataValueEnvelope(
    confidenceValidity === DataValidity.MISSING ? null : ptConfidenceVal,
    confidenceValidity,
    "expected_minutes_model",
    cutoffGw,
    sampleSize === 0 ? "No historical evidence available." : `Confidence based on ${sampleSize} GW sample and role clarity.`
  );

  const breakdown: MinutesModelBreakdown = {
    player_id: player.id,
    model_version: MINUTES_MODEL_VERSION,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    position_id: positionId,
    fixture_count: fixtureCount,
    gameweek_type: gwType,

    availability: {
      status: statusStr,
      official_chance_next: officialChance !== null ? Number(officialChance) : null,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      probability_available: probAvailable,
    },

    historical_evidence: supportingEvidence,

    shrinkage: {
      prior_sample_weight: priorWeight,
      sample_size: sampleSize,
      total_match_weight: matchWeight,
      prior_appearance_rate: priors.prior_appearance_rate,
      raw_appearance_rate: rawAppRate,
      recency_appearance_rate: recencyAppRate,
      shrunk_appearance_rate: shrunkAppBase,
      prior_start_rate: priors.prior_start_rate,
      raw_start_rate: rawStartRate,
      recency_start_rate: recencyStartRate,
      shrunk_start_rate: shrunkStartBase,
      prior_60plus_rate: priors.prior_60plus_rate_given_start,
      raw_60plus_rate: raw60PlusRate,
      shrunk_60plus_rate: shrunk60PlusRate,
    },

    conditional_probabilities: {
      probability_appearance_given_available: condAppProb,
      probability_start_given_available: condStartProb,
      probability_60_plus_given_available: cond60Prob,
    },

    probabilities: {
      probability_available: probAvailable,
      probability_appearance: finalProbApp,
      probability_start: finalProbStart,
      probability_60_plus_minutes: finalProb60,
    },

    playing_time_confidence: {
      value: ptConfidenceVal,
      sample_factor: sampleFactor,
      availability_factor: availFactor,
      role_clarity_factor: roleClarityFactor,
      validity: confidenceValidity,
    },

    minutes_decomposition: {
      expected_minutes_when_started: expMinsWhenStarted,
      expected_minutes_as_substitute: expMinsAsSub,
      start_contribution: startContrib,
      substitute_contribution: subContrib,
      single_fixture_expected_minutes: singleFixtureExpMins,
      total_expected_minutes: finalExpectedMinutes,
    },

    per_fixture_breakdown: perFixtureBreakdown,
  };

  // Prediction output envelope
  const unavailableExpPoints = new DataValue({
    value: null,
    validity: DataValidity.MISSING,
    source: "prediction_engine_v2",
    as_of_gameweek: cutoffGw,
    reason: EXPECTED_POINTS_UNAVAILABLE_REASON,
  });

  const legacyScoreVal = player.expert_score !== undefined ? Number(player.expert_score) : null;
  const legacyScoreEnvelope = new DataValue({
    value: legacyScoreVal,
    validity: legacyScoreVal !== null ? DataValidity.DERIVED : DataValidity.MISSING,
    source: LEGACY_RANK_SCORE_SOURCE,
    as_of_gameweek: cutoffGw,
    reason: "Legacy relative ranking score; not expected FPL points.",
  });

  const predictionOutputObj = new PredictionOutput({
    player_id: player.id,
    snapshot_id: snapshot.snapshot_id,
    last_finished_gameweek: snapshot.boundary.last_finished_gameweek,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    expected_points_next_gameweek: unavailableExpPoints,
    expert_rank_score: legacyScoreEnvelope,
    expected_minutes: new DataValue({
      value: expMinsEnvelope.value,
      validity: expMinsEnvelope.validity as DataValidity,
      source: expMinsEnvelope.source,
      as_of_gameweek: expMinsEnvelope.as_of_gameweek,
      reason: expMinsEnvelope.reason,
    }),
    probability_available: new DataValue({
      value: probAvailEnvelope.value,
      validity: probAvailEnvelope.validity as DataValidity,
      source: probAvailEnvelope.source,
      as_of_gameweek: probAvailEnvelope.as_of_gameweek,
      reason: probAvailEnvelope.reason,
    }),
    probability_appearance: new DataValue({
      value: probAppEnvelope.value,
      validity: probAppEnvelope.validity as DataValidity,
      source: probAppEnvelope.source,
      as_of_gameweek: probAppEnvelope.as_of_gameweek,
      reason: probAppEnvelope.reason,
    }),
    probability_start: new DataValue({
      value: probStartEnvelope.value,
      validity: probStartEnvelope.validity as DataValidity,
      source: probStartEnvelope.source,
      as_of_gameweek: probStartEnvelope.as_of_gameweek,
      reason: probStartEnvelope.reason,
    }),
    probability_60_plus_minutes: new DataValue({
      value: prob60Envelope.value,
      validity: prob60Envelope.validity as DataValidity,
      source: prob60Envelope.source,
      as_of_gameweek: prob60Envelope.as_of_gameweek,
      reason: prob60Envelope.reason,
    }),
    prediction_confidence: new DataValue({
      value: confidenceEnvelope.value,
      validity: confidenceEnvelope.validity as DataValidity,
      source: confidenceEnvelope.source,
      as_of_gameweek: confidenceEnvelope.as_of_gameweek,
      reason: confidenceEnvelope.reason,
    }),
    prediction_range: new PredictionRange({
      lower: null,
      upper: null,
      validity: DataValidity.MISSING,
      reason: EXPECTED_POINTS_UNAVAILABLE_REASON,
    }),
  });

  return {
    player_id: player.id,
    model_version: MINUTES_MODEL_VERSION,
    expected_minutes: expMinsEnvelope,
    probability_available: probAvailEnvelope,
    probability_appearance: probAppEnvelope,
    probability_start: probStartEnvelope,
    probability_60_plus_minutes: prob60Envelope,
    playing_time_confidence: confidenceEnvelope,
    breakdown,
    prediction_output: predictionOutputObj.toDict(),
  };
}

export function buildBulkExpectedMinutes(options: {
  players: Array<Record<string, any>>;
  featuresByPlayer: Record<number, CanonicalPlayerFeatures>;
  snapshot: PredictionSnapshot;
  recentHistoryByPlayer?: Record<number, Array<Record<string, any>>> | null;
}): Record<number, PlayerMinutesModelResult> {
  const { players, featuresByPlayer, snapshot, recentHistoryByPlayer = null } = options;
  const result: Record<number, PlayerMinutesModelResult> = {};

  for (const p of players) {
    const feat = featuresByPlayer[p.id];
    if (feat) {
      const hist = recentHistoryByPlayer?.[p.id] ?? p._history ?? null;
      result[p.id] = buildPlayerExpectedMinutes({
        player: p,
        features: feat,
        snapshot,
        history: hist,
      });
    }
  }

  return result;
}
