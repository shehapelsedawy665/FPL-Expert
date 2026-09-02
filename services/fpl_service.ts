import {
  GameweekBoundary,
  PredictionSnapshot,
  DataValidity,
  determineGameweekBoundary,
  makePredictionSnapshot,
} from "./prediction_contract";

export const FPL_BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
export const FPL_FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/";
export const FPL_ELEMENT_SUMMARY_URL =
  "https://fantasy.premierleague.com/api/element-summary/{player_id}/";
export const FPL_ENTRY_URL = "https://fantasy.premierleague.com/api/entry/{team_id}/";
export const FPL_ENTRY_PICKS_URL =
  "https://fantasy.premierleague.com/api/entry/{team_id}/event/{gameweek}/picks/";
export const FPL_CACHE_TTL_SECONDS = 300;

export const PLAYER_STATUS_LABELS: Record<string, string> = {
  a: "Available",
  d: "Doubtful",
  i: "Injured",
  n: "Not available",
  s: "Suspended",
  u: "Unavailable",
};

export class FPLDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FPLDataError";
  }
}

export class FPLTeamError extends FPLDataError {
  category: string;

  constructor(message: string, category: string) {
    super(message);
    this.name = "FPLTeamError";
    this.category = category;
  }
}

class TTLCache {
  private ttlSeconds: number;
  private entries: Map<string, { createdAt: number; value: any }> = new Map();

  constructor(ttlSeconds: number) {
    this.ttlSeconds = ttlSeconds;
  }

  get(key: string): any | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = Date.now() / 1000;
    if (now - entry.createdAt >= this.ttlSeconds) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: any): void {
    this.entries.set(key, {
      createdAt: Date.now() / 1000,
      value,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface FPLBootstrap {
  players: Array<Record<string, any>>;
  teams: Array<Record<string, any>>;
  positions: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
  reference_gameweek: number;
  gameweek_boundary: GameweekBoundary;
  snapshot: PredictionSnapshot;
}

const responseCache = new TTLCache(FPL_CACHE_TTL_SECONDS);

export function clearResponseCache(): void {
  responseCache.clear();
}

async function fetchJson(url: string, label: string): Promise<any> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FPL-Expert/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new FPLDataError(`The ${label} returned HTTP ${response.status}.`);
    }

    return await response.json();
  } catch (error: any) {
    if (error instanceof FPLDataError) {
      throw error;
    }
    throw new FPLDataError(`The ${label} could not be reached right now.`);
  }
}

function referenceGameweek(events: Array<Record<string, any>>): number {
  const boundary = determineGameweekBoundary(events);
  if (boundary.last_finished_gameweek !== null && boundary.last_finished_gameweek > 0) {
    return boundary.last_finished_gameweek;
  }
  if (boundary.prediction_gameweek !== null && boundary.prediction_gameweek > 0) {
    return boundary.prediction_gameweek;
  }
  const currentEvent = events.find((e) => e.is_current)?.id;
  if (typeof currentEvent === "number") {
    return currentEvent;
  }
  return 1;
}

export function validateTeamStrengths(teams: Array<Record<string, any>>): {
  attackValid: boolean;
  defenceValid: boolean;
} {
  let attackCount = 0;
  let attackPositive = 0;
  let defenceCount = 0;
  let defencePositive = 0;

  for (const team of teams) {
    if (!team || typeof team !== "object") continue;
    const attHome = Number(team.strength_attack_home);
    const attAway = Number(team.strength_attack_away);
    const defHome = Number(team.strength_defence_home);
    const defAway = Number(team.strength_defence_away);

    if (!isNaN(attHome) && !isNaN(attAway)) {
      attackCount++;
      if (attHome > 0 || attAway > 0) attackPositive++;
    }
    if (!isNaN(defHome) && !isNaN(defAway)) {
      defenceCount++;
      if (defHome > 0 || defAway > 0) defencePositive++;
    }
  }

  return {
    attackValid: attackCount > 0 && attackPositive > 0,
    defenceValid: defenceCount > 0 && defencePositive > 0,
  };
}

// Shared history cache across all routes
const sharedPlayerHistoryCache = new Map<number, Array<Record<string, any>>>();

export function getSharedPlayerHistories(): Record<number, Array<Record<string, any>>> {
  const result: Record<number, Array<Record<string, any>>> = {};
  for (const [id, history] of sharedPlayerHistoryCache.entries()) {
    result[id] = history;
  }
  return result;
}

export async function fetchPlayerHistories(
  playerIds: number[],
  maxConcurrency = 10
): Promise<Record<number, Array<Record<string, any>>>> {
  const result: Record<number, Array<Record<string, any>>> = {};
  const missingIds: number[] = [];

  for (const id of playerIds) {
    if (typeof id !== "number" || id <= 0) continue;
    if (sharedPlayerHistoryCache.has(id)) {
      result[id] = sharedPlayerHistoryCache.get(id)!;
    } else {
      missingIds.push(id);
    }
  }

  if (missingIds.length > 0) {
    for (let i = 0; i < missingIds.length; i += maxConcurrency) {
      const chunk = missingIds.slice(i, i + maxConcurrency);
      const promises = chunk.map(async (id) => {
        try {
          const summary = await fetchPlayerSummary(id);
          if (summary && Array.isArray(summary.history)) {
            sharedPlayerHistoryCache.set(id, summary.history);
            result[id] = summary.history;
          }
        } catch {
          // If summary fails for a single player, continue with others
        }
      });
      await Promise.all(promises);
    }
  }

  return result;
}

export async function fetchBootstrapData(): Promise<FPLBootstrap> {
  const cached = responseCache.get("bootstrap");
  if (cached) return cached;

  const payload = await fetchJson(FPL_BOOTSTRAP_URL, "FPL bootstrap service");
  if (!payload || typeof payload !== "object") {
    throw new FPLDataError("The FPL bootstrap service returned an unexpected response.");
  }

  const rawPlayers = payload.elements;
  const rawTeams = payload.teams;
  const rawPositions = payload.element_types;
  const rawEvents = payload.events;

  if (
    !Array.isArray(rawPlayers) ||
    !Array.isArray(rawTeams) ||
    !Array.isArray(rawPositions) ||
    !Array.isArray(rawEvents)
  ) {
    throw new FPLDataError("The FPL bootstrap service returned incomplete data.");
  }

  const teams = rawTeams.filter((t) => typeof t === "object");
  const positions = rawPositions.filter((p) => typeof p === "object");
  const events = rawEvents.filter((e) => typeof e === "object");

  const teamNames: Record<number, string> = {};
  const teamShortNames: Record<number, string> = {};
  for (const team of teams) {
    teamNames[team.id] = team.name || "Unknown";
    teamShortNames[team.id] = team.short_name || "";
  }

  const positionNames: Record<number, string> = {};
  const positionShortNames: Record<number, string> = {};
  for (const pos of positions) {
    positionNames[pos.id] = pos.singular_name || "Unknown";
    positionShortNames[pos.id] = pos.singular_name_short || "";
  }

  const players: Array<Record<string, any>> = [];
  for (const player of rawPlayers) {
    if (!player || typeof player !== "object") continue;
    const teamId = player.team;
    const positionId = player.element_type;

    const transfersInEvent = numberValue(player.transfers_in_event);
    const transfersOutEvent = numberValue(player.transfers_out_event);
    const cumulativeTransfersIn = numberValue(player.transfers_in);
    const cumulativeTransfersOut = numberValue(player.transfers_out);

    players.push({
      ...player,
      team_name: teamNames[teamId] || "Unknown",
      team_short_name: teamShortNames[teamId] || "",
      position_name: positionNames[positionId] || "Unknown",
      position_short_name: positionShortNames[positionId] || "",
      status_label:
        PLAYER_STATUS_LABELS[player.status] || player.status || "Unknown",
      transfers_in_event: transfersInEvent,
      transfers_out_event: transfersOutEvent,
      transfer_signal: transfersInEvent - transfersOutEvent,
      transfer_signal_horizon: "current_gameweek",
      cumulative_transfers_in: cumulativeTransfersIn,
      cumulative_transfers_out: cumulativeTransfersOut,
      cumulative_transfer_signal: cumulativeTransfersIn - cumulativeTransfersOut,
      cumulative_transfer_horizon: "season_to_date",
      transfers_in_gameweek: transfersInEvent,
      transfers_out_gameweek: transfersOutEvent,
    });
  }

  const boundary = determineGameweekBoundary(events);
  const refGw = referenceGameweek(events);
  const snapshotId = `snap_gw${boundary.prediction_gameweek ?? "next"}_cutoff${boundary.historical_cutoff_gameweek ?? 0}`;
  const snapshot = makePredictionSnapshot(snapshotId, events);

  const bootstrap: FPLBootstrap = {
    players,
    teams,
    positions,
    events,
    reference_gameweek: refGw,
    gameweek_boundary: boundary,
    snapshot,
  };

  responseCache.set("bootstrap", bootstrap);

  // Pre-warm top 50 active players in background to populate shared history cache
  const topPlayerIds = players
    .slice()
    .sort((a, b) => numberValue(b.selected_by_percent) - numberValue(a.selected_by_percent))
    .slice(0, 50)
    .map((p) => p.id);
  fetchPlayerHistories(topPlayerIds, 15).catch(() => {});

  return bootstrap;
}

export async function fetchFixtures(): Promise<Array<Record<string, any>>> {
  const cached = responseCache.get("fixtures");
  if (cached) return cached;

  const payload = await fetchJson(FPL_FIXTURES_URL, "FPL fixtures service");
  if (!Array.isArray(payload)) {
    throw new FPLDataError("The FPL fixtures service returned an unexpected response.");
  }

  const fixtures = payload.filter((f) => typeof f === "object");
  responseCache.set("fixtures", fixtures);
  return fixtures;
}

export async function fetchPlayerSummary(playerId: number): Promise<Record<string, any>> {
  if (playerId <= 0) {
    throw new FPLDataError("That player ID is not valid.");
  }

  const cacheKey = `element-summary:${playerId}`;
  const cached = responseCache.get(cacheKey);
  if (cached) {
    if (Array.isArray(cached.history)) {
      sharedPlayerHistoryCache.set(playerId, cached.history);
    }
    return cached;
  }

  const url = FPL_ELEMENT_SUMMARY_URL.replace("{player_id}", String(playerId));
  const payload = await fetchJson(url, "the player detail service");

  if (!payload || typeof payload !== "object") {
    throw new FPLDataError("The player detail service returned an unexpected response.");
  }
  if (!Array.isArray(payload.history)) {
    throw new FPLDataError("The player detail service returned incomplete history.");
  }

  sharedPlayerHistoryCache.set(playerId, payload.history);
  responseCache.set(cacheKey, payload);
  return payload;
}

export async function fetchTeamEntry(teamId: number): Promise<Record<string, any>> {
  if (teamId <= 0) {
    throw new FPLTeamError("Enter a positive numeric FPL Team ID.", "invalid");
  }

  const cacheKey = `team-entry:${teamId}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  const url = FPL_ENTRY_URL.replace("{team_id}", String(teamId));
  let payload: any;
  try {
    payload = await fetchJson(url, "the FPL team service");
  } catch (error: any) {
    if (error?.message && error.message.includes("HTTP 404")) {
      throw new FPLTeamError("That FPL Team ID could not be found.", "not_found");
    }
    throw new FPLTeamError("The FPL team service is unavailable right now.", "unavailable");
  }

  if (!payload || typeof payload !== "object" || !payload.id) {
    throw new FPLTeamError("That FPL Team ID could not be found.", "not_found");
  }

  responseCache.set(cacheKey, payload);
  return payload;
}

export async function fetchTeamPicks(
  teamId: number,
  gameweek: number
): Promise<Record<string, any>> {
  if (teamId <= 0) {
    throw new FPLTeamError("Enter a positive numeric FPL Team ID.", "invalid");
  }
  if (gameweek <= 0) {
    throw new FPLTeamError("The current FPL Gameweek is not available.", "unavailable");
  }

  const cacheKey = `team-picks:${teamId}:${gameweek}`;
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;

  const url = FPL_ENTRY_PICKS_URL.replace("{team_id}", String(teamId)).replace(
    "{gameweek}",
    String(gameweek)
  );

  let payload: any;
  try {
    payload = await fetchJson(url, "the FPL squad service");
  } catch (error: any) {
    if (error?.message && error.message.includes("HTTP 404")) {
      throw new FPLTeamError(
        "The current squad is not available for this FPL Team ID.",
        "squad_unavailable"
      );
    }
    throw new FPLTeamError("The FPL squad service is unavailable right now.", "unavailable");
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.picks)) {
    throw new FPLTeamError(
      "The current squad is not available for this FPL Team ID.",
      "squad_unavailable"
    );
  }

  responseCache.set(cacheKey, payload);
  return payload;
}

export async function fetchTeamData(
  teamId: number,
  referenceGameweekNum: number
): Promise<{
  entry: Record<string, any>;
  picks: Array<Record<string, any>>;
  gameweek: number;
  entry_history: Record<string, any>;
  player_histories: Record<number, Array<Record<string, any>>>;
}> {
  const entry = await fetchTeamEntry(teamId);
  const picksPayload = await fetchTeamPicks(teamId, referenceGameweekNum);
  const picks = (picksPayload.picks || []).filter((p: any) => typeof p === "object");
  if (picks.length === 0) {
    throw new FPLTeamError(
      "The current squad is not available for this FPL Team ID.",
      "squad_unavailable"
    );
  }

  const squadPlayerIds = picks
    .map((p: any) => p.element)
    .filter((id: any): id is number => typeof id === "number" && id > 0);

  const playerHistories = await fetchPlayerHistories(squadPlayerIds);

  return {
    entry,
    picks,
    gameweek: referenceGameweekNum,
    entry_history: picksPayload.entry_history || {},
    player_histories: playerHistories,
  };
}

function numberValue(value: any): number {
  if (value === null || value === undefined || value === "") return 0.0;
  const num = Number(value);
  return isNaN(num) ? 0.0 : num;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 100) / 100;
}

function kickoffDisplay(value: any): string {
  if (!value) return "TBC";
  try {
    const d = new Date(String(value));
    if (isNaN(d.getTime())) return "TBC";
    return d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "TBC";
  }
}

function fixtureForTeam(
  fixture: Record<string, any>,
  teamId: number,
  teamLookup: Record<number, Record<string, any>>
): Record<string, any> | null {
  const homeTeam = fixture.team_h;
  const awayTeam = fixture.team_a;

  let venue: string;
  let opponentId: number;
  let difficulty: number;

  if (homeTeam === teamId) {
    venue = "H";
    opponentId = awayTeam;
    difficulty = fixture.team_h_difficulty;
  } else if (awayTeam === teamId) {
    venue = "A";
    opponentId = homeTeam;
    difficulty = fixture.team_a_difficulty;
  } else {
    return null;
  }

  const opponent = teamLookup[opponentId] || {};
  return {
    id: fixture.id,
    gameweek: fixture.event,
    venue,
    opponent: opponent.name || "Unknown",
    opponent_short_name: opponent.short_name || "",
    difficulty,
    kickoff_time: fixture.kickoff_time,
    kickoff_display: kickoffDisplay(fixture.kickoff_time),
  };
}

export function fixtureDataForTeam(
  teamId: any,
  fixtures: Array<Record<string, any>>,
  teams: Array<Record<string, any>>,
  referenceOrBoundary: number | GameweekBoundary
): Record<string, any> {
  if (typeof teamId !== "number") {
    return {
      next_5_fixtures: [],
      next_3_avg_difficulty: null,
      next_5_avg_difficulty: null,
      team_attack_strength: null,
      team_attack_strength_validity: DataValidity.MISSING,
      team_defence_strength: null,
      team_defence_strength_validity: DataValidity.MISSING,
    };
  }

  const boundary =
    referenceOrBoundary instanceof GameweekBoundary
      ? referenceOrBoundary
      : null;

  const targetPredictionGw = boundary?.prediction_gameweek ?? (typeof referenceOrBoundary === "number" ? referenceOrBoundary : 1);
  const historicalCutoffGw = boundary?.historical_cutoff_gameweek ?? null;
  const inProgressGw = boundary?.in_progress_gameweek ?? null;

  const teamLookup: Record<number, Record<string, any>> = {};
  for (const team of teams) {
    if (typeof team.id === "number") {
      teamLookup[team.id] = team;
    }
  }

  const upcoming: Array<Record<string, any>> = [];
  for (const fixture of fixtures) {
    const event = fixture.event;
    if (typeof event !== "number") continue;
    if (fixture.finished === true) continue;

    // Prevent Gameweek Leakage:
    // If a match is in the in-progress gameweek, it is not an upcoming future gameweek prediction target
    if (inProgressGw !== null && event === inProgressGw) continue;
    // Fixtures strictly before target prediction gameweek or <= historical cutoff are excluded
    if (historicalCutoffGw !== null && event <= historicalCutoffGw) continue;
    if (event < targetPredictionGw) continue;

    const normalized = fixtureForTeam(fixture, teamId, teamLookup);
    if (normalized) {
      upcoming.push(normalized);
    }
  }

  upcoming.sort((a, b) => {
    const gwA = a.gameweek || 999;
    const gwB = b.gameweek || 999;
    if (gwA !== gwB) return gwA - gwB;
    const timeA = a.kickoff_time || "";
    const timeB = b.kickoff_time || "";
    if (timeA !== timeB) return timeA.localeCompare(timeB);
    return (a.id || 0) - (b.id || 0);
  });

  const gameweeks = upcoming
    .map((f) => f.gameweek)
    .filter((gw): gw is number => typeof gw === "number");
  const firstGameweek = gameweeks.length > 0 ? Math.min(...gameweeks) : targetPredictionGw;

  const next3Difficulties = upcoming
    .filter(
      (f) =>
        typeof f.gameweek === "number" &&
        f.gameweek <= firstGameweek + 2 &&
        f.difficulty !== null &&
        f.difficulty !== undefined
    )
    .map((f) => numberValue(f.difficulty));

  const next5Difficulties = upcoming
    .slice(0, 5)
    .filter((f) => f.difficulty !== null && f.difficulty !== undefined)
    .map((f) => numberValue(f.difficulty));

  const teamObj = teamLookup[teamId];
  const strengthsValidity = validateTeamStrengths(teams);

  let teamAttackStrength: number | null = null;
  let teamAttackValidity: DataValidity = DataValidity.INVALID;
  if (
    strengthsValidity.attackValid &&
    teamObj &&
    !isNaN(Number(teamObj.strength_attack_home)) &&
    !isNaN(Number(teamObj.strength_attack_away))
  ) {
    const home = Number(teamObj.strength_attack_home);
    const away = Number(teamObj.strength_attack_away);
    if (home > 0 || away > 0) {
      teamAttackStrength = average([home, away]);
      teamAttackValidity = DataValidity.OBSERVED;
    }
  }

  let teamDefenceStrength: number | null = null;
  let teamDefenceValidity: DataValidity = DataValidity.INVALID;
  if (
    strengthsValidity.defenceValid &&
    teamObj &&
    !isNaN(Number(teamObj.strength_defence_home)) &&
    !isNaN(Number(teamObj.strength_defence_away))
  ) {
    const home = Number(teamObj.strength_defence_home);
    const away = Number(teamObj.strength_defence_away);
    if (home > 0 || away > 0) {
      teamDefenceStrength = average([home, away]);
      teamDefenceValidity = DataValidity.OBSERVED;
    }
  }

  return {
    next_5_fixtures: upcoming.slice(0, 5),
    next_3_avg_difficulty: average(next3Difficulties),
    next_5_avg_difficulty: average(next5Difficulties),
    team_attack_strength: teamAttackStrength,
    team_attack_strength_validity: teamAttackValidity,
    team_defence_strength: teamDefenceStrength,
    team_defence_strength_validity: teamDefenceValidity,
  };
}

export function addFixtureData(
  players: Array<Record<string, any>>,
  fixtures: Array<Record<string, any>>,
  teams: Array<Record<string, any>>,
  referenceOrBoundary: number | GameweekBoundary
): Array<Record<string, any>> {
  const fixtureCache: Record<number, Record<string, any>> = {};
  const enrichedPlayers: Array<Record<string, any>> = [];

  for (const player of players) {
    const teamId = player.team;
    if (!fixtureCache[teamId]) {
      fixtureCache[teamId] = fixtureDataForTeam(
        teamId,
        fixtures,
        teams,
        referenceOrBoundary
      );
    }
    enrichedPlayers.push({
      ...player,
      ...fixtureCache[teamId],
    });
  }

  return enrichedPlayers;
}

export function addHistoryTeamNames(
  history: Array<Record<string, any>>,
  teams: Array<Record<string, any>>
): Array<Record<string, any>> {
  const teamLookup: Record<number, Record<string, any>> = {};
  for (const team of teams) {
    if (typeof team.id === "number") {
      teamLookup[team.id] = team;
    }
  }

  return history.map((item) => {
    const opponent = teamLookup[item.opponent_team] || {};
    return {
      ...item,
      opponent_name: opponent.name || item.opponent_team,
      opponent_short_name: opponent.short_name || item.opponent_team,
    };
  });
}

export function filterAndSortPlayers(
  players: Array<Record<string, any>>,
  options: {
    name?: string;
    team?: string;
    position?: string;
    sort_by?: string;
    order?: string;
  }
): Array<Record<string, any>> {
  const nameQuery = (options.name || "").trim().toLowerCase();
  const allowedSortFields = new Set([
    "now_cost",
    "total_points",
    "form",
    "goals_scored",
    "assists",
    "bonus",
    "selected_by_percent",
    "expected_goals",
    "expected_assists",
    "ict_index",
    "points_per_game",
    "transfers_in_gameweek",
    "transfers_in_event",
    "expert_score",
    "current_form_score",
    "future_fpl_score",
    "value_score",
  ]);

  let sortBy = options.sort_by || "total_points";
  if (!allowedSortFields.has(sortBy)) {
    sortBy = "total_points";
  }

  const order = options.order === "asc" ? "asc" : "desc";
  const teamFilter = options.team || "";
  const positionFilter = options.position || "";

  const filtered = players.filter((player) => {
    if (nameQuery) {
      const webName = String(player.web_name || "").toLowerCase();
      const fullName = `${player.first_name || ""} ${player.second_name || ""}`.toLowerCase();
      if (!webName.includes(nameQuery) && !fullName.includes(nameQuery)) {
        return false;
      }
    }
    if (teamFilter && String(player.team || "") !== teamFilter) {
      return false;
    }
    if (positionFilter && String(player.element_type || "") !== positionFilter) {
      return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    const valA = numberValue(a[sortBy]);
    const valB = numberValue(b[sortBy]);
    return order === "desc" ? valB - valA : valA - valB;
  });
}

