import {
  DataValidity,
  DataValue,
  DataValueDict,
  GameweekBoundary,
  PredictionSnapshot,
} from "./prediction_contract.js";

export const FEATURE_SCHEMA_VERSION = "prediction-features.v1";

export interface FixtureContextItem {
  fixture_id: number;
  event: number;
  team_h: number;
  team_a: number;
  opponent_team_id: number;
  is_home: boolean;
  difficulty: number;
}

export interface WindowMetrics {
  window_type: "appearances" | "gameweeks";
  window_size: number;
  window_label: string;
  matches_evaluated_count: number;
  fixture_rows_count: number;
  rounds_included: number[];
  minutes: DataValueDict;
  starts: DataValueDict;
  appearances: DataValueDict;
  points: DataValueDict;
  goals: DataValueDict;
  assists: DataValueDict;
  bonus: DataValueDict;
  clean_sheets: DataValueDict;
  expected_goals: DataValueDict;
  expected_assists: DataValueDict;
  expected_goal_involvements: DataValueDict;
  threat: DataValueDict;
  creativity: DataValueDict;
  influence: DataValueDict;
  ict: DataValueDict;
}

export interface MinutesEvidenceFeatures {
  season_minutes: DataValueDict;
  season_starts: DataValueDict;
  season_appearances: DataValueDict;
  recent_3_appearance_minutes: DataValueDict;
  recent_5_appearance_minutes: DataValueDict;
  recent_3_gw_minutes: DataValueDict;
  recent_5_gw_minutes: DataValueDict;
  average_minutes_per_appearance: DataValueDict;
  start_rate: DataValueDict;
  appearance_rate: DataValueDict;
  sixty_plus_minute_rate: DataValueDict;
  bench_appearance_count: DataValueDict;
  zero_minute_completed_gw_count: DataValueDict;
  consecutive_starts: DataValueDict;
  consecutive_appearances: DataValueDict;
}

export interface Per90Features {
  sample_minutes: number;
  is_applicable: boolean;
  goals_per90: DataValueDict;
  assists_per90: DataValueDict;
  xg_per90: DataValueDict;
  xa_per90: DataValueDict;
  xgi_per90: DataValueDict;
  points_per90: DataValueDict;
  bonus_per90: DataValueDict;
  threat_per90: DataValueDict;
  creativity_per90: DataValueDict;
  influence_per90: DataValueDict;
  ict_per90: DataValueDict;
}

export interface FixtureFeatures {
  prediction_gameweek: number | null;
  prediction_gw_fixture_count: number;
  fixture_count: number;
  gameweek_type: "normal" | "blank" | "double" | "multiple" | "unknown";
  prediction_gw_fixtures: FixtureContextItem[];
  fixtures: FixtureContextItem[];

  prediction_gw_opponent: DataValueDict;
  prediction_gw_is_home: DataValueDict;
  prediction_gw_difficulty: DataValueDict;
  next_fixture_opponent: DataValueDict;
  is_home: DataValueDict;
  next_fixture_difficulty: DataValueDict;

  first_prediction_gw_fixture_opponent: DataValueDict;
  first_prediction_gw_fixture_is_home: DataValueDict;
  first_prediction_gw_fixture_difficulty: DataValueDict;

  next_scheduled_fixture: FixtureContextItem | null;
  next_scheduled_fixture_gameweek: DataValueDict;
  next_scheduled_opponent: DataValueDict;
  next_scheduled_is_home: DataValueDict;
  next_scheduled_difficulty: DataValueDict;

  next_3_avg_difficulty: DataValueDict;
  next_5_avg_difficulty: DataValueDict;
}

export enum SetPieceRole {
  FIRST_CHOICE = "first_choice",
  SECONDARY = "secondary",
  RANKED = "ranked",
  UNKNOWN = "unknown",
  NOT_APPLICABLE = "not_applicable",
}

export interface SetPieceFeatures {
  penalty_role: SetPieceRole;
  penalties_order_raw: DataValueDict;
  freekick_role: SetPieceRole;
  direct_freekicks_order_raw: DataValueDict;
  corner_role: SetPieceRole;
  corners_and_indirect_freekicks_order_raw: DataValueDict;
}

export interface AvailabilityFeatures {
  status: DataValueDict;
  chance_of_playing_next_round: DataValueDict;
  chance_of_playing_this_round: DataValueDict;
  news: DataValueDict;
  news_added: DataValueDict;
  heuristic_availability_fallback: DataValueDict;
}

export interface TransferFeatures {
  selected_by_percent: DataValueDict;
  transfers_in_event: DataValueDict;
  transfers_out_event: DataValueDict;
  event_net_transfers: DataValueDict;
  cumulative_transfers_in: DataValueDict;
  cumulative_transfers_out: DataValueDict;
  cumulative_net_transfers: DataValueDict;
}

export interface TeamPositionFeatures {
  player_position: DataValueDict;
  team_id: DataValueDict;
  now_cost: DataValueDict;
  price_millions: DataValueDict;
  team_strength_valid: boolean;
  team_strength_overall_home: DataValueDict;
  team_strength_overall_away: DataValueDict;
  team_strength_attack_home: DataValueDict;
  team_strength_attack_away: DataValueDict;
  team_strength_defence_home: DataValueDict;
  team_strength_defence_away: DataValueDict;
}

export interface FeatureProvenance {
  player_id: number;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  snapshot_id: string;
  snapshot_created_at: string;
  feature_schema_version: string;
  history_available: boolean;
  gameweek_rounds_used: number[];
  completed_rounds_used: number[];
  fixture_rows_used: number;
  in_progress_rounds_excluded: number[];
  fixtures_evaluated_count: number;
}

export interface CanonicalPlayerFeatures {
  feature_schema_version: string;
  player_id: number;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  snapshot_id: string;
  snapshot_created_at: string;
  provenance: FeatureProvenance;
  windows: {
    last_3_appearances: WindowMetrics;
    last_5_appearances: WindowMetrics;
    last_3_gameweeks: WindowMetrics;
    last_5_gameweeks: WindowMetrics;
  };
  minutes_evidence: MinutesEvidenceFeatures;
  per_90: Per90Features;
  fixtures: FixtureFeatures;
  set_pieces: SetPieceFeatures;
  availability: AvailabilityFeatures;
  transfers: TransferFeatures;
  team_position: TeamPositionFeatures;
}

function num(val: any): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function createDataValue(
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

function aggregateAppearanceWindow(
  matches: Array<Record<string, any>>,
  windowSize: number,
  asOfGw: number | null,
  hasHistory: boolean
): WindowMetrics {
  const windowLabel = `last_${windowSize}_appearances`;
  if (!hasHistory) {
    const makeMissing = () =>
      createDataValue(null, DataValidity.MISSING, "fpl_player_history", asOfGw, "No player match history available.");
    return {
      window_type: "appearances",
      window_size: windowSize,
      window_label: windowLabel,
      matches_evaluated_count: 0,
      fixture_rows_count: 0,
      rounds_included: [],
      minutes: makeMissing(),
      starts: makeMissing(),
      appearances: makeMissing(),
      points: makeMissing(),
      goals: makeMissing(),
      assists: makeMissing(),
      bonus: makeMissing(),
      clean_sheets: makeMissing(),
      expected_goals: makeMissing(),
      expected_assists: makeMissing(),
      expected_goal_involvements: makeMissing(),
      threat: makeMissing(),
      creativity: makeMissing(),
      influence: makeMissing(),
      ict: makeMissing(),
    };
  }

  let sumMin = 0;
  let sumStarts = 0;
  let sumApps = 0;
  let sumPts = 0;
  let sumG = 0;
  let sumA = 0;
  let sumB = 0;
  let sumCs = 0;
  let sumXg = 0;
  let sumXa = 0;
  let sumXgi = 0;
  let sumThreat = 0;
  let sumCreativity = 0;
  let sumInfluence = 0;
  let sumIct = 0;

  for (const m of matches) {
    const mins = num(m.minutes);
    sumMin += mins;
    if (mins > 0) sumApps++;
    const startsVal = m.starts !== undefined && m.starts !== null ? num(m.starts) : (mins > 0 ? 1 : 0);
    sumStarts += startsVal;
    sumPts += num(m.total_points);
    sumG += num(m.goals_scored);
    sumA += num(m.assists);
    sumB += num(m.bonus);
    sumCs += num(m.clean_sheets);
    sumXg += num(m.expected_goals);
    sumXa += num(m.expected_assists);
    sumXgi += num(m.expected_goal_involvements || (num(m.expected_goals) + num(m.expected_assists)));
    sumThreat += num(m.threat);
    sumCreativity += num(m.creativity);
    sumInfluence += num(m.influence);
    sumIct += num(m.ict_index);
  }

  const rounds = matches.map((m) => m.round).filter((r): r is number => typeof r === "number");

  const makeDerived = (val: number, decimals = 0) => {
    const rounded = decimals > 0 ? Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals) : Math.round(val);
    const validity = rounded === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED;
    return createDataValue(rounded, validity, "fpl_player_history", asOfGw);
  };

  return {
    window_type: "appearances",
    window_size: windowSize,
    window_label: windowLabel,
    matches_evaluated_count: matches.length,
    fixture_rows_count: matches.length,
    rounds_included: rounds,
    minutes: makeDerived(sumMin),
    starts: makeDerived(sumStarts),
    appearances: makeDerived(sumApps),
    points: makeDerived(sumPts),
    goals: makeDerived(sumG),
    assists: makeDerived(sumA),
    bonus: makeDerived(sumB),
    clean_sheets: makeDerived(sumCs),
    expected_goals: makeDerived(sumXg, 2),
    expected_assists: makeDerived(sumXa, 2),
    expected_goal_involvements: makeDerived(sumXgi, 2),
    threat: makeDerived(sumThreat, 1),
    creativity: makeDerived(sumCreativity, 1),
    influence: makeDerived(sumInfluence, 1),
    ict: makeDerived(sumIct, 1),
  };
}

function aggregateGameweekWindow(
  selectedRounds: number[],
  matchesByRound: Map<number, Array<Record<string, any>>>,
  windowSize: number,
  asOfGw: number | null,
  hasHistory: boolean
): WindowMetrics {
  const windowLabel = `last_${windowSize}_gameweeks`;
  if (!hasHistory) {
    const makeMissing = () =>
      createDataValue(null, DataValidity.MISSING, "fpl_player_history", asOfGw, "No player match history available.");
    return {
      window_type: "gameweeks",
      window_size: windowSize,
      window_label: windowLabel,
      matches_evaluated_count: 0,
      fixture_rows_count: 0,
      rounds_included: [],
      minutes: makeMissing(),
      starts: makeMissing(),
      appearances: makeMissing(),
      points: makeMissing(),
      goals: makeMissing(),
      assists: makeMissing(),
      bonus: makeMissing(),
      clean_sheets: makeMissing(),
      expected_goals: makeMissing(),
      expected_assists: makeMissing(),
      expected_goal_involvements: makeMissing(),
      threat: makeMissing(),
      creativity: makeMissing(),
      influence: makeMissing(),
      ict: makeMissing(),
    };
  }

  let totalFixtureRows = 0;
  let sumMin = 0;
  let sumStarts = 0;
  let sumApps = 0;
  let sumPts = 0;
  let sumG = 0;
  let sumA = 0;
  let sumB = 0;
  let sumCs = 0;
  let sumXg = 0;
  let sumXa = 0;
  let sumXgi = 0;
  let sumThreat = 0;
  let sumCreativity = 0;
  let sumInfluence = 0;
  let sumIct = 0;

  for (const round of selectedRounds) {
    const rows = matchesByRound.get(round) || [];
    totalFixtureRows += rows.length;
    for (const m of rows) {
      const mins = num(m.minutes);
      sumMin += mins;
      if (mins > 0) sumApps++;
      const startsVal = m.starts !== undefined && m.starts !== null ? num(m.starts) : (mins > 0 ? 1 : 0);
      sumStarts += startsVal;
      sumPts += num(m.total_points);
      sumG += num(m.goals_scored);
      sumA += num(m.assists);
      sumB += num(m.bonus);
      sumCs += num(m.clean_sheets);
      sumXg += num(m.expected_goals);
      sumXa += num(m.expected_assists);
      sumXgi += num(m.expected_goal_involvements || (num(m.expected_goals) + num(m.expected_assists)));
      sumThreat += num(m.threat);
      sumCreativity += num(m.creativity);
      sumInfluence += num(m.influence);
      sumIct += num(m.ict_index);
    }
  }

  const makeDerived = (val: number, decimals = 0) => {
    const rounded = decimals > 0 ? Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals) : Math.round(val);
    const validity = rounded === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED;
    return createDataValue(rounded, validity, "fpl_player_history", asOfGw);
  };

  return {
    window_type: "gameweeks",
    window_size: windowSize,
    window_label: windowLabel,
    matches_evaluated_count: selectedRounds.length,
    fixture_rows_count: totalFixtureRows,
    rounds_included: selectedRounds,
    minutes: makeDerived(sumMin),
    starts: makeDerived(sumStarts),
    appearances: makeDerived(sumApps),
    points: makeDerived(sumPts),
    goals: makeDerived(sumG),
    assists: makeDerived(sumA),
    bonus: makeDerived(sumB),
    clean_sheets: makeDerived(sumCs),
    expected_goals: makeDerived(sumXg, 2),
    expected_assists: makeDerived(sumXa, 2),
    expected_goal_involvements: makeDerived(sumXgi, 2),
    threat: makeDerived(sumThreat, 1),
    creativity: makeDerived(sumCreativity, 1),
    influence: makeDerived(sumInfluence, 1),
    ict: makeDerived(sumIct, 1),
  };
}

export function deriveSetPieceRole(orderValue: any): { role: SetPieceRole; validity: DataValidity; order: number | null } {
  if (orderValue === null || orderValue === undefined || orderValue === "") {
    return {
      role: SetPieceRole.UNKNOWN,
      validity: DataValidity.MISSING,
      order: null,
    };
  }
  const orderNum = Number(orderValue);
  if (isNaN(orderNum) || orderNum <= 0) {
    return {
      role: SetPieceRole.UNKNOWN,
      validity: DataValidity.INVALID,
      order: null,
    };
  }
  if (orderNum === 1) {
    return {
      role: SetPieceRole.FIRST_CHOICE,
      validity: DataValidity.OBSERVED,
      order: 1,
    };
  }
  if (orderNum === 2) {
    return {
      role: SetPieceRole.SECONDARY,
      validity: DataValidity.OBSERVED,
      order: 2,
    };
  }
  return {
    role: SetPieceRole.RANKED,
    validity: DataValidity.OBSERVED,
    order: orderNum,
  };
}

export function buildPlayerPredictionFeatures(options: {
  player: Record<string, any>;
  snapshot: PredictionSnapshot;
  history?: Array<Record<string, any>> | null;
  allFixtures?: Array<Record<string, any>> | null;
  allTeams?: Array<Record<string, any>> | null;
}): CanonicalPlayerFeatures {
  const { player, snapshot, history = null, allFixtures = null, allTeams = null } = options;
  const boundary = snapshot.boundary;
  const cutoffGw = boundary.historical_cutoff_gameweek;
  const predGw = boundary.prediction_gameweek;
  const hasHistory = Array.isArray(history) && history.length > 0;

  // 1. Cutoff-safe match history partition
  const completedMatches: Array<Record<string, any>> = [];
  const inProgressExcludedRounds: number[] = [];
  const matchesByRound = new Map<number, Array<Record<string, any>>>();

  if (hasHistory && history) {
    for (const m of history) {
      if (typeof m === "object" && m !== null && typeof m.round === "number") {
        if (cutoffGw === null || m.round <= cutoffGw) {
          completedMatches.push(m);
          const list = matchesByRound.get(m.round) || [];
          list.push(m);
          matchesByRound.set(m.round, list);
        } else {
          if (!inProgressExcludedRounds.includes(m.round)) {
            inProgressExcludedRounds.push(m.round);
          }
        }
      }
    }
  }

  // Sort completed matches chronologically by round / kick-off
  completedMatches.sort((a, b) => (a.round || 0) - (b.round || 0));
  const completedRoundsUsed = completedMatches.map((m) => m.round).filter((r): r is number => typeof r === "number");
  const distinctRoundsCompleted = Array.from(matchesByRound.keys()).sort((a, b) => a - b);

  // 2. Rolling Windows
  // Appearance-based windows: only matches where minutes > 0
  const appearanceMatches = completedMatches.filter((m) => num(m.minutes) > 0);
  const last3AppearancesMatches = appearanceMatches.slice(-3);
  const last5AppearancesMatches = appearanceMatches.slice(-5);

  // Distinct Gameweek-based windows: last N distinct completed Gameweek rounds through cutoff
  const last3Rounds = distinctRoundsCompleted.slice(-3);
  const last5Rounds = distinctRoundsCompleted.slice(-5);

  const windowLast3Apps = aggregateAppearanceWindow(last3AppearancesMatches, 3, cutoffGw, hasHistory);
  const windowLast5Apps = aggregateAppearanceWindow(last5AppearancesMatches, 5, cutoffGw, hasHistory);
  const windowLast3Gws = aggregateGameweekWindow(last3Rounds, matchesByRound, 3, cutoffGw, hasHistory);
  const windowLast5Gws = aggregateGameweekWindow(last5Rounds, matchesByRound, 5, cutoffGw, hasHistory);

  // 3. Minutes & Starting Evidence Features
  let seasonMinutes = 0;
  let seasonStarts = 0;
  let seasonApps = 0;
  let sixtyPlusCount = 0;
  let benchAppCount = 0;
  let zeroMinuteCompletedGwCount = 0;

  if (hasHistory) {
    for (const round of distinctRoundsCompleted) {
      const rows = matchesByRound.get(round) || [];
      let roundMinutes = 0;
      let roundStarts = 0;
      let roundApps = 0;

      for (const m of rows) {
        const mins = num(m.minutes);
        roundMinutes += mins;
        seasonMinutes += mins;
        const isStart = m.starts !== undefined && m.starts !== null ? num(m.starts) > 0 : mins > 0;
        if (isStart) {
          seasonStarts++;
          roundStarts++;
        }
        if (mins > 0) {
          seasonApps++;
          roundApps++;
          if (!isStart) benchAppCount++;
        }
        if (mins >= 60) sixtyPlusCount++;
      }

      if (roundMinutes === 0) {
        zeroMinuteCompletedGwCount++;
      }
    }
  } else {
    seasonMinutes = num(player.minutes);
    seasonStarts = num(player.starts);
    seasonApps = player.appearances !== undefined && player.appearances !== null && player.appearances !== ""
      ? Number(player.appearances)
      : (player._reconstructed_from_history ? num(player.appearances) : 0);
  }

  // Consecutive starts & consecutive appearances backwards from latest completed match
  let consecutiveStarts = 0;
  let consecutiveAppearances = 0;
  if (hasHistory && completedMatches.length > 0) {
    for (let i = completedMatches.length - 1; i >= 0; i--) {
      const m = completedMatches[i];
      const mins = num(m.minutes);
      const isStart = m.starts !== undefined && m.starts !== null ? num(m.starts) > 0 : mins > 0;
      if (isStart && consecutiveStarts === (completedMatches.length - 1 - i)) {
        consecutiveStarts++;
      }
      if (mins > 0 && consecutiveAppearances === (completedMatches.length - 1 - i)) {
        consecutiveAppearances++;
      }
    }
  }

  const distinctGwCount = distinctRoundsCompleted.length;
  const startRate = distinctGwCount > 0 ? Math.round((seasonStarts / distinctGwCount) * 1000) / 10 : (hasHistory ? 0 : null);
  const appRate = distinctGwCount > 0 ? Math.round((seasonApps / distinctGwCount) * 1000) / 10 : (hasHistory ? 0 : null);
  const sixtyPlusRate = distinctGwCount > 0 ? Math.round((sixtyPlusCount / distinctGwCount) * 1000) / 10 : (hasHistory ? 0 : null);
  const avgMinsPerApp = seasonApps > 0 ? Math.round((seasonMinutes / seasonApps) * 10) / 10 : (hasHistory ? 0 : null);

  const makeMinutesVal = (val: number | null, isMissing = false, decimals = 0, isDerived = false) => {
    if (isMissing || val === null) {
      return createDataValue(null, DataValidity.MISSING, hasHistory ? "fpl_player_history" : "fpl_input", cutoffGw, "Missing history or unobserved metric.");
    }
    const rounded = decimals > 0 ? Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals) : Math.round(val);
    const validity = rounded === 0 ? DataValidity.OBSERVED_ZERO : (isDerived || decimals > 0 ? DataValidity.DERIVED : DataValidity.OBSERVED);
    return createDataValue(rounded, validity, hasHistory ? "fpl_player_history" : "fpl_input", cutoffGw);
  };

  const minutesEvidence: MinutesEvidenceFeatures = {
    season_minutes: makeMinutesVal(seasonMinutes, false, 0, hasHistory),
    season_starts: makeMinutesVal(seasonStarts, false, 0, hasHistory),
    season_appearances: hasHistory
      ? makeMinutesVal(seasonApps, false, 0, true)
      : (player.appearances !== undefined && player.appearances !== null ? makeMinutesVal(num(player.appearances)) : makeMinutesVal(null, true)),
    recent_3_appearance_minutes: windowLast3Apps.minutes,
    recent_5_appearance_minutes: windowLast5Apps.minutes,
    recent_3_gw_minutes: windowLast3Gws.minutes,
    recent_5_gw_minutes: windowLast5Gws.minutes,
    average_minutes_per_appearance: hasHistory ? makeMinutesVal(avgMinsPerApp, false, 1, true) : makeMinutesVal(null, true),
    start_rate: hasHistory ? makeMinutesVal(startRate, false, 1, true) : makeMinutesVal(null, true),
    appearance_rate: hasHistory ? makeMinutesVal(appRate, false, 1, true) : makeMinutesVal(null, true),
    sixty_plus_minute_rate: hasHistory ? makeMinutesVal(sixtyPlusRate, false, 1, true) : makeMinutesVal(null, true),
    bench_appearance_count: hasHistory ? makeMinutesVal(benchAppCount, false, 0, true) : makeMinutesVal(null, true),
    zero_minute_completed_gw_count: hasHistory ? makeMinutesVal(zeroMinuteCompletedGwCount, false, 0, true) : makeMinutesVal(null, true),
    consecutive_starts: hasHistory ? makeMinutesVal(consecutiveStarts, false, 0, true) : makeMinutesVal(null, true),
    consecutive_appearances: hasHistory ? makeMinutesVal(consecutiveAppearances, false, 0, true) : makeMinutesVal(null, true),
  };

  // 4. Per-90 Performance Features
  // Per90 = metric / minutes * 90
  const totalMinForPer90 = hasHistory ? seasonMinutes : num(player.minutes);
  const isPer90Applicable = totalMinForPer90 > 0;

  const derivePer90 = (metricTotal: number, decimals = 2): DataValueDict => {
    if (!isPer90Applicable) {
      return createDataValue(
        null,
        DataValidity.NOT_APPLICABLE,
        hasHistory ? "fpl_player_history" : "fpl_input",
        cutoffGw,
        "Zero minutes played; per-90 rate is not applicable."
      );
    }
    const val = (metricTotal / totalMinForPer90) * 90;
    const rounded = Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals);
    const validity = rounded === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED;
    return createDataValue(rounded, validity, hasHistory ? "fpl_player_history" : "fpl_input", cutoffGw);
  };

  let sumG = 0, sumA = 0, sumXg = 0, sumXa = 0, sumXgi = 0, sumPts = 0, sumB = 0, sumThr = 0, sumCre = 0, sumInf = 0, sumIct = 0;
  if (hasHistory) {
    for (const m of completedMatches) {
      sumG += num(m.goals_scored);
      sumA += num(m.assists);
      sumXg += num(m.expected_goals);
      sumXa += num(m.expected_assists);
      sumXgi += num(m.expected_goal_involvements || (num(m.expected_goals) + num(m.expected_assists)));
      sumPts += num(m.total_points);
      sumB += num(m.bonus);
      sumThr += num(m.threat);
      sumCre += num(m.creativity);
      sumInf += num(m.influence);
      sumIct += num(m.ict_index);
    }
  } else {
    sumG = num(player.goals_scored);
    sumA = num(player.assists);
    sumXg = num(player.expected_goals);
    sumXa = num(player.expected_assists);
    sumXgi = num(player.expected_goal_involvements || (num(player.expected_goals) + num(player.expected_assists)));
    sumPts = num(player.total_points);
    sumB = num(player.bonus);
    sumThr = num(player.threat);
    sumCre = num(player.creativity);
    sumInf = num(player.influence);
    sumIct = num(player.ict_index);
  }

  const per90Features: Per90Features = {
    sample_minutes: totalMinForPer90,
    is_applicable: isPer90Applicable,
    goals_per90: derivePer90(sumG),
    assists_per90: derivePer90(sumA),
    xg_per90: derivePer90(sumXg),
    xa_per90: derivePer90(sumXa),
    xgi_per90: derivePer90(sumXgi),
    points_per90: derivePer90(sumPts),
    bonus_per90: derivePer90(sumB),
    threat_per90: derivePer90(sumThr, 1),
    creativity_per90: derivePer90(sumCre, 1),
    influence_per90: derivePer90(sumInf, 1),
    ict_per90: derivePer90(sumIct, 1),
  };

  // 5. Fixture Features (Structured, BGW, DGW support)
  const playerTeamId = num(player.team);
  const predictionGwFixtures: FixtureContextItem[] = [];
  const futureUpcomingFixtures: FixtureContextItem[] = [];

  if (Array.isArray(allFixtures) && playerTeamId > 0) {
    for (const fix of allFixtures) {
      if (fix.team_h === playerTeamId || fix.team_a === playerTeamId) {
        const isHome = fix.team_h === playerTeamId;
        const opponentId = isHome ? fix.team_a : fix.team_h;
        const difficulty = isHome ? num(fix.team_h_difficulty || 3) : num(fix.team_a_difficulty || 3);
        const item: FixtureContextItem = {
          fixture_id: fix.id,
          event: fix.event,
          team_h: fix.team_h,
          team_a: fix.team_a,
          opponent_team_id: opponentId,
          is_home: isHome,
          difficulty,
        };

        if (predGw !== null && fix.event === predGw) {
          predictionGwFixtures.push(item);
        }
        if (predGw !== null && fix.event >= predGw) {
          futureUpcomingFixtures.push(item);
        }
      }
    }
  }

  // Sort upcoming fixtures by event
  futureUpcomingFixtures.sort((a, b) => a.event - b.event);

  const fixtureCount = predictionGwFixtures.length;
  let gwType: "normal" | "blank" | "double" | "multiple" | "unknown" = "unknown";
  if (predGw !== null) {
    if (fixtureCount === 0) gwType = "blank";
    else if (fixtureCount === 1) gwType = "normal";
    else if (fixtureCount === 2) gwType = "double";
    else gwType = "multiple";
  }

  // Next 3 and Next 5 average difficulty across future upcoming fixtures
  const next3Fixtures = futureUpcomingFixtures.slice(0, 3);
  const next5Fixtures = futureUpcomingFixtures.slice(0, 5);

  const avgDiff = (list: FixtureContextItem[]) =>
    list.length > 0 ? Math.round((list.reduce((acc, f) => acc + f.difficulty, 0) / list.length) * 10) / 10 : null;

  const next3AvgDiff = avgDiff(next3Fixtures);
  const next5AvgDiff = avgDiff(next5Fixtures);

  // Single-fixture convenience fields: strictly valid ONLY when fixtureCount === 1
  let predGwOpponent: DataValueDict;
  let predGwIsHome: DataValueDict;
  let predGwDifficulty: DataValueDict;

  if (fixtureCount === 1) {
    const singleFix = predictionGwFixtures[0];
    predGwOpponent = createDataValue(singleFix.opponent_team_id, DataValidity.OBSERVED, "fpl_fixtures", predGw);
    predGwIsHome = createDataValue(singleFix.is_home, DataValidity.OBSERVED, "fpl_fixtures", predGw);
    predGwDifficulty = createDataValue(singleFix.difficulty, DataValidity.OBSERVED, "fpl_fixtures", predGw);
  } else if (fixtureCount === 0) {
    predGwOpponent = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Blank gameweek; no fixture scheduled.");
    predGwIsHome = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Blank gameweek; no fixture scheduled.");
    predGwDifficulty = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Blank gameweek; no fixture scheduled.");
  } else {
    // Double or multiple fixtures
    predGwOpponent = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Multiple fixtures in gameweek; refer to prediction_gw_fixtures list.");
    predGwIsHome = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Multiple fixtures in gameweek; refer to prediction_gw_fixtures list.");
    predGwDifficulty = createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "Multiple fixtures in gameweek; refer to prediction_gw_fixtures list.");
  }

  // First fixture in prediction GW (if fixture_count >= 1)
  const firstPredictionGwFix = predictionGwFixtures.length > 0 ? predictionGwFixtures[0] : null;
  const firstPredGwOpponent = firstPredictionGwFix
    ? createDataValue(firstPredictionGwFix.opponent_team_id, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "No prediction-GW fixture scheduled.");
  const firstPredGwIsHome = firstPredictionGwFix
    ? createDataValue(firstPredictionGwFix.is_home, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "No prediction-GW fixture scheduled.");
  const firstPredGwDifficulty = firstPredictionGwFix
    ? createDataValue(firstPredictionGwFix.difficulty, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.NOT_APPLICABLE, "fpl_fixtures", predGw, "No prediction-GW fixture scheduled.");

  // Next chronological scheduled fixture (at or after prediction_gameweek)
  const nextScheduledFix = futureUpcomingFixtures.length > 0 ? futureUpcomingFixtures[0] : null;
  const nextScheduledGw = nextScheduledFix
    ? createDataValue(nextScheduledFix.event, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw, "No upcoming scheduled fixtures.");
  const nextScheduledOpponent = nextScheduledFix
    ? createDataValue(nextScheduledFix.opponent_team_id, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw, "No upcoming scheduled fixtures.");
  const nextScheduledIsHome = nextScheduledFix
    ? createDataValue(nextScheduledFix.is_home, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw, "No upcoming scheduled fixtures.");
  const nextScheduledDifficulty = nextScheduledFix
    ? createDataValue(nextScheduledFix.difficulty, DataValidity.OBSERVED, "fpl_fixtures", predGw)
    : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw, "No upcoming scheduled fixtures.");

  const fixtureFeatures: FixtureFeatures = {
    prediction_gameweek: predGw,
    prediction_gw_fixture_count: fixtureCount,
    fixture_count: fixtureCount,
    gameweek_type: gwType,
    prediction_gw_fixtures: predictionGwFixtures,
    fixtures: predictionGwFixtures,

    prediction_gw_opponent: predGwOpponent,
    prediction_gw_is_home: predGwIsHome,
    prediction_gw_difficulty: predGwDifficulty,
    next_fixture_opponent: predGwOpponent,
    is_home: predGwIsHome,
    next_fixture_difficulty: predGwDifficulty,

    first_prediction_gw_fixture_opponent: firstPredGwOpponent,
    first_prediction_gw_fixture_is_home: firstPredGwIsHome,
    first_prediction_gw_fixture_difficulty: firstPredGwDifficulty,

    next_scheduled_fixture: nextScheduledFix,
    next_scheduled_fixture_gameweek: nextScheduledGw,
    next_scheduled_opponent: nextScheduledOpponent,
    next_scheduled_is_home: nextScheduledIsHome,
    next_scheduled_difficulty: nextScheduledDifficulty,

    next_3_avg_difficulty: next3AvgDiff !== null
      ? createDataValue(next3AvgDiff, DataValidity.DERIVED, "fpl_fixtures", predGw)
      : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw),
    next_5_avg_difficulty: next5AvgDiff !== null
      ? createDataValue(next5AvgDiff, DataValidity.DERIVED, "fpl_fixtures", predGw)
      : createDataValue(null, DataValidity.MISSING, "fpl_fixtures", predGw),
  };

  // 6. Set-Piece Role Features
  const penOrder = deriveSetPieceRole(player.penalties_order);
  const fkOrder = deriveSetPieceRole(player.direct_freekicks_order);
  const cornerOrder = deriveSetPieceRole(player.corners_and_indirect_freekicks_order);

  const setPieces: SetPieceFeatures = {
    penalty_role: penOrder.role,
    penalties_order_raw: createDataValue(penOrder.order, penOrder.validity, "fpl_bootstrap", cutoffGw),
    freekick_role: fkOrder.role,
    direct_freekicks_order_raw: createDataValue(fkOrder.order, fkOrder.validity, "fpl_bootstrap", cutoffGw),
    corner_role: cornerOrder.role,
    corners_and_indirect_freekicks_order_raw: createDataValue(cornerOrder.order, cornerOrder.validity, "fpl_bootstrap", cutoffGw),
  };

  // 7. Availability Features
  const statusStr = typeof player.status === "string" ? player.status : "u";
  const chanceNext = player.chance_of_playing_next_round !== undefined && player.chance_of_playing_next_round !== null && player.chance_of_playing_next_round !== ""
    ? Number(player.chance_of_playing_next_round)
    : null;
  const chanceThis = player.chance_of_playing_this_round !== undefined && player.chance_of_playing_this_round !== null && player.chance_of_playing_this_round !== ""
    ? Number(player.chance_of_playing_this_round)
    : null;

  // Explicit heuristic fallback clearly labeled as non-official fallback
  let heuristicAvailability = 1.0;
  if (statusStr === "i" || statusStr === "s") heuristicAvailability = 0.0;
  else if (statusStr === "u" || statusStr === "n") heuristicAvailability = 0.0;
  else if (chanceNext !== null) heuristicAvailability = chanceNext / 100.0;
  else if (statusStr === "d") heuristicAvailability = 0.5;

  const availability: AvailabilityFeatures = {
    status: createDataValue(statusStr, DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    chance_of_playing_next_round: chanceNext !== null
      ? createDataValue(chanceNext, chanceNext === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw)
      : createDataValue(null, DataValidity.MISSING, "fpl_bootstrap", cutoffGw, "No chance_of_playing_next_round provided by FPL."),
    chance_of_playing_this_round: chanceThis !== null
      ? createDataValue(chanceThis, chanceThis === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw)
      : createDataValue(null, DataValidity.MISSING, "fpl_bootstrap", cutoffGw, "No chance_of_playing_this_round provided by FPL."),
    news: player.news ? createDataValue(player.news, DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw) : createDataValue(null, DataValidity.MISSING, "fpl_bootstrap", cutoffGw),
    news_added: player.news_added ? createDataValue(player.news_added, DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw) : createDataValue(null, DataValidity.MISSING, "fpl_bootstrap", cutoffGw),
    heuristic_availability_fallback: createDataValue(heuristicAvailability, heuristicAvailability === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED, "heuristic_status_fallback", cutoffGw, "Heuristic fallback derived from status; not an official FPL probability."),
  };

  // 8. Transfer / Ownership Context Features
  const transfersInEvent = player.transfers_in_event !== undefined
    ? num(player.transfers_in_event)
    : num(player.transfers_in_gameweek);
  const transfersOutEvent = player.transfers_out_event !== undefined
    ? num(player.transfers_out_event)
    : num(player.transfers_out_gameweek);
  const eventNet = transfersInEvent - transfersOutEvent;

  const cumIn = num(player.transfers_in);
  const cumOut = num(player.transfers_out);
  const cumNet = cumIn - cumOut;

  const transfers: TransferFeatures = {
    selected_by_percent: createDataValue(num(player.selected_by_percent), DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    transfers_in_event: createDataValue(transfersInEvent, transfersInEvent === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    transfers_out_event: createDataValue(transfersOutEvent, transfersOutEvent === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    event_net_transfers: createDataValue(eventNet, eventNet === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED, "fpl_bootstrap", cutoffGw),
    cumulative_transfers_in: createDataValue(cumIn, cumIn === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    cumulative_transfers_out: createDataValue(cumOut, cumOut === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    cumulative_net_transfers: createDataValue(cumNet, cumNet === 0 ? DataValidity.OBSERVED_ZERO : DataValidity.DERIVED, "fpl_bootstrap", cutoffGw),
  };

  // 9. Team / Position Context & Strength Validity
  const playerTeam = Array.isArray(allTeams) ? allTeams.find((t) => t.id === playerTeamId) : null;
  const strengthOverallH = playerTeam ? num(playerTeam.strength_overall_home) : num(player.team_strength_overall_home);
  const strengthOverallA = playerTeam ? num(playerTeam.strength_overall_away) : num(player.team_strength_overall_away);
  const strengthAttackH = playerTeam ? num(playerTeam.strength_attack_home) : num(player.team_strength_attack_home || player.team_attack_strength);
  const strengthAttackA = playerTeam ? num(playerTeam.strength_attack_away) : num(player.team_strength_attack_away);
  const strengthDefH = playerTeam ? num(playerTeam.strength_defence_home) : num(player.team_strength_defence_home || player.team_defence_strength);
  const strengthDefA = playerTeam ? num(playerTeam.strength_defence_away) : num(player.team_strength_defence_away);

  // Validate team strength: informative non-zero values with variation
  const strengths = [strengthOverallH, strengthOverallA, strengthAttackH, strengthAttackA, strengthDefH, strengthDefA];
  const isStrengthInformative = strengths.some((s) => s > 0) && new Set(strengths.filter((s) => s > 0)).size > 1;

  const teamPosition: TeamPositionFeatures = {
    player_position: createDataValue(num(player.element_type), DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    team_id: createDataValue(playerTeamId, DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    now_cost: createDataValue(num(player.now_cost), DataValidity.OBSERVED, "fpl_bootstrap", cutoffGw),
    price_millions: createDataValue(Math.round((num(player.now_cost) / 10.0) * 10) / 10, DataValidity.DERIVED, "fpl_bootstrap", cutoffGw),
    team_strength_valid: isStrengthInformative,
    team_strength_overall_home: isStrengthInformative
      ? createDataValue(strengthOverallH, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
    team_strength_overall_away: isStrengthInformative
      ? createDataValue(strengthOverallA, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
    team_strength_attack_home: isStrengthInformative
      ? createDataValue(strengthAttackH, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
    team_strength_attack_away: isStrengthInformative
      ? createDataValue(strengthAttackA, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
    team_strength_defence_home: isStrengthInformative
      ? createDataValue(strengthDefH, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
    team_strength_defence_away: isStrengthInformative
      ? createDataValue(strengthDefA, DataValidity.OBSERVED, "fpl_teams", cutoffGw)
      : createDataValue(null, DataValidity.INVALID, "fpl_teams", cutoffGw, "Team strength values are uninformative/zero."),
  };

  // 10. Provenance Object
  const provenance: FeatureProvenance = {
    player_id: player.id,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    snapshot_id: snapshot.snapshot_id,
    snapshot_created_at: snapshot.snapshot_created_at,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    history_available: hasHistory,
    gameweek_rounds_used: distinctRoundsCompleted,
    completed_rounds_used: completedRoundsUsed,
    fixture_rows_used: completedMatches.length,
    in_progress_rounds_excluded: inProgressExcludedRounds,
    fixtures_evaluated_count: predictionGwFixtures.length,
  };

  return {
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    player_id: player.id,
    prediction_gameweek: predGw,
    historical_cutoff_gameweek: cutoffGw,
    snapshot_id: snapshot.snapshot_id,
    snapshot_created_at: snapshot.snapshot_created_at,
    provenance,
    windows: {
      last_3_appearances: windowLast3Apps,
      last_5_appearances: windowLast5Apps,
      last_3_gameweeks: windowLast3Gws,
      last_5_gameweeks: windowLast5Gws,
    },
    minutes_evidence: minutesEvidence,
    per_90: per90Features,
    fixtures: fixtureFeatures,
    set_pieces: setPieces,
    availability: availability,
    transfers: transfers,
    team_position: teamPosition,
  };
}

export function buildBulkPredictionFeatures(options: {
  players: Array<Record<string, any>>;
  snapshot: PredictionSnapshot;
  recentHistoryByPlayer?: Record<number, Array<Record<string, any>>> | null;
  allFixtures?: Array<Record<string, any>> | null;
  allTeams?: Array<Record<string, any>> | null;
}): Record<number, CanonicalPlayerFeatures> {
  const { players, snapshot, recentHistoryByPlayer = null, allFixtures = null, allTeams = null } = options;
  const result: Record<number, CanonicalPlayerFeatures> = {};

  for (const p of players) {
    const hist = recentHistoryByPlayer?.[p.id] ?? p._history ?? null;
    result[p.id] = buildPlayerPredictionFeatures({
      player: p,
      snapshot,
      history: hist,
      allFixtures,
      allTeams,
    });
  }

  return result;
}
