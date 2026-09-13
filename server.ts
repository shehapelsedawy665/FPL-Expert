import express, { Request, Response } from "express";
import path from "path";
import nunjucks from "nunjucks";
import cors from "cors";
import {
  fetchBootstrapData,
  fetchFixtures,
  fetchPlayerSummary,
  fetchTeamData,
  getSharedPlayerHistories,
  fixtureDataForTeam,
  addFixtureData,
  addHistoryTeamNames,
  filterAndSortPlayers,
  FPLTeamError,
  FPLDataError,
} from "./services/fpl_service";
import { addRatings, numberValue } from "./services/rating_engine";
import { analyzeTeamSquad } from "./services/team_analyzer";
import {
  buildPlayerPredictionFeatures,
  buildBulkPredictionFeatures,
} from "./services/prediction_features";
import { buildPlayerExpectedMinutes } from "./services/expected_minutes_model";
import {
  projectPlayerMultiGameweek,
  projectSquadMultiGameweek,
  MULTI_GW_PROJECTION_VERSION,
} from "./services/multi_gw_projection";
import {
  runTransferEngine,
  createCurrentLiveTransferSnapshot,
  TRANSFER_ENGINE_VERSION,
  FPL_TRANSFER_RULES_VERSION,
  TeamFinancialState,
} from "./services/transfer_engine";
import {
  optimizeSequentialTransfers,
  SEQUENTIAL_ENGINE_VERSION,
  SEQUENTIAL_PRICE_MODEL,
  SEQUENTIAL_SEARCH_SCOPE,
} from "./services/sequential_transfer_engine";
import {
  predictSquadPriceChanges,
  filterMarketMovers,
  PRICE_PREDICTOR_VERSION,
} from "./services/price_predictor";
import { roundTo } from "./services/decision_engine";
import {
  parsePressConferenceNotes,
  extractSignalsFromCoachStatements,
  registerAvailabilitySignals,
  getGlobalAvailabilityOverrides,
  getGlobalNewsFeed,
  clearGlobalAvailabilityOverrides,
  clearGlobalAvailabilityOverrideForPlayer,
  AVAILABILITY_INTEL_VERSION,
  CoachStatement,
  ExtractedInjurySignal,
} from "./services/availability_intelligence";
import {
  getExpertRecommendations,
  EXPERT_ADVISOR_VERSION,
} from "./services/expert_advisor";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure static file serving
const staticDir = path.join(process.cwd(), "static");
app.use("/static", express.static(staticDir));

// Configure Nunjucks view engine
const templatesDir = path.join(process.cwd(), "templates");
const env = nunjucks.configure(templatesDir, {
  autoescape: true,
  express: app,
  noCache: process.env.NODE_ENV !== "production",
});

// Custom filters matching Jinja2 filters in Python app
env.addFilter("display", (value: any) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  return value;
});

env.addFilter("decimal", (value: any, places: number = 1) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const num = Number(value);
  if (isNaN(num)) return "—";
  return num.toFixed(places);
});

env.addFilter("price", (value: any) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const num = Number(value);
  if (isNaN(num)) return "—";
  return `£${(num / 10.0).toFixed(1)}m`;
});

env.addFilter("percent", (value: any) => {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  const num = Number(value);
  if (isNaN(num)) return "—";
  return `${num.toFixed(1)}%`;
});

// URL generator helper
env.addGlobal("url_for", (endpoint: string, kwargs?: Record<string, any>) => {
  if (endpoint === "static") {
    return `/static/${kwargs?.filename || ""}`;
  }
  if (endpoint === "home" || endpoint === "index") {
    return "/";
  }
  if (endpoint === "players") {
    return "/players";
  }
  if (endpoint === "my_team") {
    return "/my-team";
  }
  if (endpoint === "press_room") {
    return "/press-room";
  }
  if (endpoint === "expert_hub") {
    return "/expert-hub";
  }
  if (endpoint === "player_detail") {
    return `/player/${kwargs?.player_id || ""}`;
  }
  return `/${endpoint}`;
});

// Health check API
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Home page
app.get("/", (_req: Request, res: Response) => {
  res.render("index.html");
});

// Helper for building request context
function buildRequestContext(req: Request) {
  const queryStr = req.url.includes("?") ? req.url.split("?")[1] : "";
  return {
    path: req.path,
    full_path: req.originalUrl,
    query_string: queryStr,
  };
}

// Players Directory
app.get("/players", async (req: Request, res: Response) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  const team = typeof req.query.team === "string" ? req.query.team : "";
  const position = typeof req.query.position === "string" ? req.query.position : "";
  const sortBy = typeof req.query.sort_by === "string" ? req.query.sort_by : "total_points";
  const order = typeof req.query.order === "string" ? req.query.order : "desc";

  const filters = {
    name,
    team,
    position,
    sort_by: sortBy,
    order,
  };

  try {
    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

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
      recentHistoryByPlayer: getSharedPlayerHistories(),
    });

    const filteredPlayers = filterAndSortPlayers(ratedPlayers, filters);

    res.render("players.html", {
      players: filteredPlayers,
      teams: bootstrap.teams,
      positions: bootstrap.positions,
      filters,
      error: null,
      request: buildRequestContext(req),
    });
  } catch (error: any) {
    res.render("players.html", {
      players: [],
      teams: [],
      positions: [],
      filters,
      error: error?.message || "Failed to load player data.",
      request: buildRequestContext(req),
    });
  }
});

// JSON API: Players
app.get("/api/players", async (req: Request, res: Response) => {
  try {
    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

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
      recentHistoryByPlayer: getSharedPlayerHistories(),
    });

    const filtered = filterAndSortPlayers(ratedPlayers, {
      name: typeof req.query.name === "string" ? req.query.name : undefined,
      team: typeof req.query.team === "string" ? req.query.team : undefined,
      position: typeof req.query.position === "string" ? req.query.position : undefined,
      sort_by: typeof req.query.sort_by === "string" ? req.query.sort_by : undefined,
      order: typeof req.query.order === "string" ? req.query.order : undefined,
    });

    res.json({
      players: filtered,
      teams: bootstrap.teams,
      positions: bootstrap.positions,
      reference_gameweek: bootstrap.reference_gameweek,
      gameweek_boundary: bootstrap.gameweek_boundary.toDict(),
      snapshot: bootstrap.snapshot.toDict(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load players" });
  }
});

// My Team squad analysis
app.get("/my-team", async (req: Request, res: Response) => {
  const teamIdRaw = req.query.team_id;
  const teamIdStr = typeof teamIdRaw === "string" ? teamIdRaw.trim() : "";

  if (!teamIdStr) {
    return res.render("my_team.html", {
      team_id: "",
      summary: null,
      analysis: null,
      squad_count: 0,
      news_feed: getGlobalNewsFeed().slice(0, 8),
      overrides_count: getGlobalAvailabilityOverrides().size,
      error: null,
      error_category: null,
      request: buildRequestContext(req),
    });
  }

  const teamId = parseInt(teamIdStr, 10);
  if (isNaN(teamId) || teamId <= 0) {
    return res.render("my_team.html", {
      team_id: teamIdStr,
      summary: null,
      analysis: null,
      squad_count: 0,
      news_feed: getGlobalNewsFeed().slice(0, 8),
      overrides_count: getGlobalAvailabilityOverrides().size,
      error: "Please enter a valid numeric FPL Team ID.",
      error_category: "invalid",
      request: buildRequestContext(req),
    });
  }

  try {
    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

    const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);

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
      recentHistoryByPlayer: {
        ...(teamData.player_histories || {}),
        ...getSharedPlayerHistories(),
      },
    });

    const result = analyzeTeamSquad(
      ratedPlayers,
      teamData.picks,
      teamData.entry,
      teamData.gameweek,
      teamData.entry_history,
      {
        snapshot: bootstrap.snapshot,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
        playerHistories: {
          ...(teamData.player_histories || {}),
          ...getSharedPlayerHistories(),
        },
      }
    );

    res.render("my_team.html", {
      team_id: teamIdStr,
      summary: result.summary,
      analysis: result.analysis,
      squad_count: result.squad_count,
      news_feed: getGlobalNewsFeed().slice(0, 8),
      overrides_count: getGlobalAvailabilityOverrides().size,
      error: null,
      error_category: null,
      request: buildRequestContext(req),
    });
  } catch (error: any) {
    const errorCategory = error instanceof FPLTeamError ? error.category : "unavailable";
    res.render("my_team.html", {
      team_id: teamIdStr,
      summary: null,
      analysis: null,
      squad_count: 0,
      news_feed: getGlobalNewsFeed().slice(0, 8),
      overrides_count: getGlobalAvailabilityOverrides().size,
      error: error?.message || "FPL team data is temporarily unavailable.",
      error_category: errorCategory,
      request: buildRequestContext(req),
    });
  }
});

// JSON API: My Team
app.get("/api/my-team", async (req: Request, res: Response) => {
  const teamIdStr = typeof req.query.team_id === "string" ? req.query.team_id.trim() : "";
  const teamId = parseInt(teamIdStr, 10);

  if (isNaN(teamId) || teamId <= 0) {
    return res.status(400).json({ error: "Invalid team_id" });
  }

  try {
    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

    const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);

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
      recentHistoryByPlayer: {
        ...(teamData.player_histories || {}),
        ...getSharedPlayerHistories(),
      },
    });

    const result = analyzeTeamSquad(
      ratedPlayers,
      teamData.picks,
      teamData.entry,
      teamData.gameweek,
      teamData.entry_history,
      {
        snapshot: bootstrap.snapshot,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
        playerHistories: {
          ...(teamData.player_histories || {}),
          ...getSharedPlayerHistories(),
        },
      }
    );

    res.json({
      ...result,
      snapshot: bootstrap.snapshot.toDict(),
      active_overrides_count: getGlobalAvailabilityOverrides().size,
      news_feed: getGlobalNewsFeed().slice(0, 10),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to analyze team" });
  }
});

// Player detail page
app.get("/player/:player_id", async (req: Request, res: Response) => {
  const playerId = parseInt(req.params.player_id, 10);
  if (isNaN(playerId) || playerId <= 0) {
    return res.render("player_detail.html", {
      player: null,
      history: [],
      error: "Invalid player ID specified.",
      request: buildRequestContext(req),
    });
  }

  try {
    const [bootstrap, fixtures, summary] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
      fetchPlayerSummary(playerId),
    ]);

    const rawPlayer = bootstrap.players.find((p) => p.id === playerId);
    if (!rawPlayer) {
      return res.render("player_detail.html", {
        player: null,
        history: [],
        error: "Player was not found in the live FPL database.",
        request: buildRequestContext(req),
      });
    }

    const recentHistory = summary.history || [];

    const playersWithFixtures = addFixtureData(
      bootstrap.players,
      fixtures,
      bootstrap.teams,
      bootstrap.gameweek_boundary
    );

    // Shared scoring pipeline: unified ratedPlayers
    const ratedPlayers = addRatings(playersWithFixtures, {
      referenceGameweek: bootstrap.reference_gameweek,
      boundary: bootstrap.gameweek_boundary,
      snapshot: bootstrap.snapshot,
      recentHistoryByPlayer: {
        ...getSharedPlayerHistories(),
        [playerId]: recentHistory,
      },
    });

    const ratedPlayer = ratedPlayers.find((p) => p.id === playerId) || rawPlayer;
    const enrichedHistory = addHistoryTeamNames(recentHistory, bootstrap.teams);

    res.render("player_detail.html", {
      player: ratedPlayer,
      history: enrichedHistory,
      error: null,
      request: buildRequestContext(req),
    });
  } catch (error: any) {
    res.render("player_detail.html", {
      player: null,
      history: [],
      error: error?.message || "Failed to load player details.",
      request: buildRequestContext(req),
    });
  }
});

// JSON API: Player Detail
app.get("/api/player/:player_id", async (req: Request, res: Response) => {
  const playerId = parseInt(req.params.player_id, 10);
  if (isNaN(playerId) || playerId <= 0) {
    return res.status(400).json({ error: "Invalid player ID" });
  }

  try {
    const [bootstrap, fixtures, summary] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
      fetchPlayerSummary(playerId),
    ]);

    const rawPlayer = bootstrap.players.find((p) => p.id === playerId);
    if (!rawPlayer) {
      return res.status(404).json({ error: "Player not found" });
    }

    const recentHistory = summary.history || [];

    const playersWithFixtures = addFixtureData(
      bootstrap.players,
      fixtures,
      bootstrap.teams,
      bootstrap.gameweek_boundary
    );

    // Shared scoring pipeline: unified ratedPlayers
    const ratedPlayers = addRatings(playersWithFixtures, {
      referenceGameweek: bootstrap.reference_gameweek,
      boundary: bootstrap.gameweek_boundary,
      snapshot: bootstrap.snapshot,
      recentHistoryByPlayer: {
        ...getSharedPlayerHistories(),
        [playerId]: recentHistory,
      },
    });

    const ratedPlayer = ratedPlayers.find((p) => p.id === playerId) || rawPlayer;
    const enrichedHistory = addHistoryTeamNames(recentHistory, bootstrap.teams);

    const predictionFeatures = buildPlayerPredictionFeatures({
      player: rawPlayer,
      snapshot: bootstrap.snapshot,
      history: recentHistory,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
    });

    const expectedMinutesResult = buildPlayerExpectedMinutes({
      player: ratedPlayer,
      features: predictionFeatures,
      snapshot: bootstrap.snapshot,
      history: recentHistory,
    });

    const multiGwResult = projectPlayerMultiGameweek({
      player: rawPlayer,
      snapshot: bootstrap.snapshot,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      history: recentHistory,
      horizon: 5,
    });

    res.json({
      player: ratedPlayer,
      history: enrichedHistory,
      prediction_features: predictionFeatures,
      expected_minutes_model: expectedMinutesResult,
      multi_gw_projection: multiGwResult,
      snapshot: bootstrap.snapshot.toDict(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load player" });
  }
});

// JSON API: Multi-Gameweek Projections (Players or Squad)
app.get("/api/projections", async (req: Request, res: Response) => {
  try {
    const horizonParam = parseInt(String(req.query.horizon || "5"), 10);
    const horizon = isNaN(horizonParam) || horizonParam <= 0 ? 5 : Math.min(horizonParam, 10);

    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

    const playerHistories = getSharedPlayerHistories();

    // Check if player_id or team_id filter was requested
    let targetPlayers = bootstrap.players;
    if (req.query.player_id) {
      const pid = parseInt(String(req.query.player_id), 10);
      targetPlayers = targetPlayers.filter((p) => p.id === pid);
    } else if (req.query.team_id) {
      const tid = parseInt(String(req.query.team_id), 10);
      targetPlayers = targetPlayers.filter((p) => p.team === tid);
    } else if (req.query.element_type) {
      const et = parseInt(String(req.query.element_type), 10);
      targetPlayers = targetPlayers.filter((p) => p.element_type === et);
    }

    const projections = projectSquadMultiGameweek({
      players: targetPlayers,
      snapshot: bootstrap.snapshot,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories,
      horizon,
    });

    res.json({
      version: MULTI_GW_PROJECTION_VERSION,
      horizon,
      start_gameweek: bootstrap.snapshot.boundary.prediction_gameweek ?? 1,
      cutoff_gameweek: bootstrap.snapshot.boundary.historical_cutoff_gameweek,
      count: projections.length,
      projections,
      snapshot: bootstrap.snapshot.toDict(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to generate multi-gw projections" });
  }
});

// JSON API: Transfer Decision Engine v1
app.get("/api/transfers", async (req: Request, res: Response) => {
  try {
    const teamIdParam = parseInt(String(req.query.team_id || "4107702"), 10);
    const teamId = isNaN(teamIdParam) || teamIdParam <= 0 ? 4107702 : teamIdParam;

    const horizonParam = parseInt(String(req.query.horizon || "5"), 10);
    const horizon = isNaN(horizonParam) || horizonParam <= 0 ? 5 : Math.min(horizonParam, 10);

    const discountParam = parseFloat(String(req.query.discount || "0.95"));
    const discountFactor = isNaN(discountParam) || discountParam <= 0 || discountParam > 1 ? 0.95 : discountParam;

    const maxTransfersParam = parseInt(String(req.query.max_transfers || "2"), 10);
    const maxTransfers = isNaN(maxTransfersParam) || maxTransfersParam < 1 ? 2 : Math.min(maxTransfersParam, 3);

    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

    const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
    const playerHistories = teamData.player_histories || getSharedPlayerHistories();

    // Map owned players with exact financial values
    const ownedPlayers = teamData.picks.map((pick: any) => {
      const p = bootstrap.players.find((pl: any) => pl.id === pick.element);
      const nowCost = p?.now_cost ?? 50;
      return {
        id: pick.element,
        web_name: p?.web_name || `Player ${pick.element}`,
        element_type: p?.element_type || pick.element_type || 1,
        team: p?.team || 1,
        now_cost: nowCost,
        selling_price: typeof pick.selling_price === "number" ? pick.selling_price : nowCost,
        purchase_price: typeof pick.purchase_price === "number" ? pick.purchase_price : nowCost,
        status: p?.status,
        news: p?.news,
        chance_of_playing_next_round: p?.chance_of_playing_next_round,
      };
    });

    const bank = typeof teamData.entry_history?.bank === "number" ? teamData.entry_history.bank : 0;
    
    // Available FTs: calculate from event_transfers or default to 1
    const eventTransfers = typeof teamData.entry_history?.event_transfers === "number" ? teamData.entry_history.event_transfers : 1;
    const availableFt = eventTransfers > 0 ? 1 : Math.min(5, 2);

    const liveSnapshot = createCurrentLiveTransferSnapshot(bootstrap.events);

    const financialState: TeamFinancialState = {
      team_id: teamId,
      snapshot_id: liveSnapshot.snapshot_id,
      bank,
      available_free_transfers: availableFt,
      owned_players: ownedPlayers,
      as_of_gameweek: bootstrap.reference_gameweek,
      is_historical: false,
    };

    const transferResult = runTransferEngine({
      financialState,
      snapshot: liveSnapshot,
      allPlayers: bootstrap.players,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories,
      horizon,
      discountFactor,
      maxTransfers,
    });

    res.json(transferResult);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to run transfer engine" });
  }
});

// JSON API: Sequential Transfer Trajectory Optimizer (Phase 6D)
app.get("/api/transfers/sequential", async (req: Request, res: Response) => {
  try {
    const teamIdParam = parseInt(String(req.query.team_id || "4107702"), 10);
    const teamId = isNaN(teamIdParam) || teamIdParam <= 0 ? 4107702 : teamIdParam;

    const horizonParam = parseInt(String(req.query.horizon || "5"), 10);
    const horizon = isNaN(horizonParam) ? 5 : Math.max(1, Math.min(8, horizonParam));

    const discountParam = parseFloat(String(req.query.discount || "0.95"));
    const discountFactor =
      isNaN(discountParam) || discountParam <= 0 || discountParam > 1
        ? 0.95
        : Math.max(0.5, Math.min(1.0, discountParam));

    const beamWidthParam = parseInt(String(req.query.beam_width || "25"), 10);
    const beamWidth = isNaN(beamWidthParam) ? 25 : Math.max(1, Math.min(50, beamWidthParam));

    const [bootstrap, fixtures] = await Promise.all([
      fetchBootstrapData(),
      fetchFixtures(),
    ]);

    const teamData = await fetchTeamData(teamId, bootstrap.reference_gameweek);
    const playerHistories = teamData.player_histories || getSharedPlayerHistories();

    // Map owned players with exact financial values
    const ownedPlayers = teamData.picks.map((pick: any) => {
      const p = bootstrap.players.find((pl: any) => pl.id === pick.element);
      const nowCost = p?.now_cost ?? 50;
      return {
        id: pick.element,
        web_name: p?.web_name || `Player ${pick.element}`,
        element_type: p?.element_type || pick.element_type || 1,
        team: p?.team || 1,
        now_cost: nowCost,
        selling_price: typeof pick.selling_price === "number" ? pick.selling_price : nowCost,
        purchase_price: typeof pick.purchase_price === "number" ? pick.purchase_price : nowCost,
        status: p?.status,
        news: p?.news,
        chance_of_playing_next_round: p?.chance_of_playing_next_round,
      };
    });

    const bank = typeof teamData.entry_history?.bank === "number" ? teamData.entry_history.bank : 0;
    const eventTransfers =
      typeof teamData.entry_history?.event_transfers === "number"
        ? teamData.entry_history.event_transfers
        : 1;
    const availableFt = eventTransfers > 0 ? 1 : Math.min(5, 2);

    const liveSnapshot = createCurrentLiveTransferSnapshot(bootstrap.events);

    const isHistorical = req.query.is_historical === "true";
    const isHistoricalVerified = req.query.is_historical_verified === "true";

    const financialState: TeamFinancialState = {
      team_id: teamId,
      snapshot_id: liveSnapshot.snapshot_id,
      bank,
      available_free_transfers: availableFt,
      owned_players: ownedPlayers,
      as_of_gameweek: bootstrap.reference_gameweek,
      is_historical: isHistorical,
      is_historical_verified: isHistoricalVerified,
    };

    // Precompute projections for owned and candidates
    const precomputedProjections = new Map<number, any>();
    for (const owned of financialState.owned_players) {
      const raw = bootstrap.players.find((p: any) => p.id === owned.id);
      const proj = projectPlayerMultiGameweek({
        player: raw,
        snapshot: liveSnapshot,
        allFixtures: fixtures,
        allTeams: bootstrap.teams,
        history: playerHistories[owned.id] || [],
        horizon: Math.max(horizon, 5),
      });
      precomputedProjections.set(owned.id, proj);
    }

    const ownedSet = new Set(financialState.owned_players.map((p) => p.id));
    const nonOwnedCandidates = bootstrap.players.filter((p: any) => {
      if (ownedSet.has(p.id)) return false;
      if (!p.element_type || p.element_type < 1 || p.element_type > 4) return false;
      const status = String(p.status || "").toLowerCase();
      if (status === "u") return false;
      return true;
    });

    const candProjs = projectSquadMultiGameweek({
      players: nonOwnedCandidates,
      snapshot: liveSnapshot,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories,
      horizon: Math.max(horizon, 5),
    });
    for (const proj of candProjs) {
      precomputedProjections.set(proj.player_id, proj);
    }

    // 1. Baseline HOLD Plan
    const baselineHoldPlan = optimizeSequentialTransfers({
      financialState,
      snapshot: liveSnapshot,
      allPlayers: bootstrap.players,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories,
      horizon,
      discountFactor,
      maxTransfersPerGw: 0,
      precomputedProjections,
    });

    // 2. Sequential Trajectory Plan
    const sequentialPlan = optimizeSequentialTransfers({
      financialState,
      snapshot: liveSnapshot,
      allPlayers: bootstrap.players,
      allFixtures: fixtures,
      allTeams: bootstrap.teams,
      playerHistories,
      horizon,
      discountFactor,
      beamWidth,
      candidateLimitPerPosition: 10,
      maxTransfersPerGw: 2,
      precomputedProjections,
    });

    const baselineHoldScore = baselineHoldPlan.total_discounted_points;
    const trajectoryScore = sequentialPlan.total_discounted_points;
    const netStrategicAdvantage = roundTo(trajectoryScore - baselineHoldScore, 2);

    res.json({
      engine_version: SEQUENTIAL_ENGINE_VERSION,
      search_scope: SEQUENTIAL_SEARCH_SCOPE,
      global_optimality: "NOT_PROVEN",
      price_model: SEQUENTIAL_PRICE_MODEL,
      team_id: teamId,
      horizon,
      discount_factor: discountFactor,
      beam_width: beamWidth,
      financial_state_validity: sequentialPlan.financial_state_validity || "VALID",
      validation_message: sequentialPlan.validation_message,
      baseline_hold_score: baselineHoldScore,
      trajectory_score: trajectoryScore,
      net_strategic_advantage: netStrategicAdvantage,
      total_hit_cost: sequentialPlan.total_hit_cost,
      total_transfers: sequentialPlan.total_transfers,
      action_plan: sequentialPlan.trajectory_steps,
      gameweek_breakdowns: sequentialPlan.gw_breakdown,
      final_state: sequentialPlan.final_state,
      plan_id: sequentialPlan.plan_id,
      urgency_assessment: sequentialPlan.urgency_assessment,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to run sequential transfer engine" });
  }
});

/**
 * GET /api/prices/movers
 *
 * Phase 7 — Price Change Predictor & Market Momentum Engine
 * Returns market movers partitioned into likely risers/fallers and at-risk players.
 */
app.get("/api/prices/movers", async (req: Request, res: Response) => {
  try {
    const bootstrap = await fetchBootstrapData();
    const rawPlayers = (bootstrap.players && bootstrap.players.length > 0)
      ? bootstrap.players
      : ((bootstrap as any).elements || []);

    const predictions = predictSquadPriceChanges(rawPlayers);
    const movers = filterMarketMovers(predictions);

    // Sort movers by momentum priority
    movers.likely_risers.sort((a, b) => b.price_target_percentage - a.price_target_percentage);
    movers.risers_at_risk.sort((a, b) => b.price_target_percentage - a.price_target_percentage);
    movers.likely_fallers.sort((a, b) => a.price_target_percentage - b.price_target_percentage);
    movers.fallers_at_risk.sort((a, b) => a.price_target_percentage - b.price_target_percentage);

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = limitParam && !isNaN(limitParam) && limitParam > 0 ? limitParam : undefined;

    res.json({
      version: PRICE_PREDICTOR_VERSION,
      timestamp: new Date().toISOString(),
      likely_risers: limit ? movers.likely_risers.slice(0, limit) : movers.likely_risers,
      risers_at_risk: limit ? movers.risers_at_risk.slice(0, limit) : movers.risers_at_risk,
      likely_fallers: limit ? movers.likely_fallers.slice(0, limit) : movers.likely_fallers,
      fallers_at_risk: limit ? movers.fallers_at_risk.slice(0, limit) : movers.fallers_at_risk,
      total_tracked_players: predictions.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to predict price market movers" });
  }
});

// ============================================================================
// PHASE 8 — PRESS CONFERENCE & LIVE AVAILABILITY INTELLIGENCE ENDPOINTS
// ============================================================================

/**
 * POST /api/intel/press-conference
 *
 * Ingests coach press conference notes or quotes, extracts injury/availability signals,
 * updates in-memory availability overrides, and pushes breaking news items to the feed.
 */
app.post("/api/intel/press-conference", async (req: Request, res: Response) => {
  try {
    const {
      notesText,
      statements,
      coach_name,
      team_id,
      raw_quote,
      useMockFallback,
      geminiApiKey,
    } = req.body;

    const bootstrap = await fetchBootstrapData();
    const rawPlayers = (bootstrap.players && bootstrap.players.length > 0)
      ? bootstrap.players
      : ((bootstrap as any).elements || []);

    const activeSquadPlayers = rawPlayers.map((p: any) => ({
      id: p.id,
      web_name: p.web_name,
      team: p.team,
    }));

    let extractedSignals: ExtractedInjurySignal[] = [];

    if (Array.isArray(statements) && statements.length > 0) {
      extractedSignals = extractSignalsFromCoachStatements(statements, activeSquadPlayers);
    } else if (typeof notesText === "string" && notesText.trim()) {
      extractedSignals = await parsePressConferenceNotes(notesText, activeSquadPlayers, {
        geminiApiKey,
        useMockFallback,
        coachName: coach_name,
        teamId: team_id,
      });
    } else if (typeof raw_quote === "string" && raw_quote.trim()) {
      const stmt: CoachStatement = {
        coach_name: coach_name || "Manager",
        team_id: Number(team_id) || 1,
        raw_quote: raw_quote.trim(),
        source: "Press Conference",
        timestamp: new Date().toISOString(),
      };
      extractedSignals = extractSignalsFromCoachStatements([stmt], activeSquadPlayers);
    } else {
      return res.status(400).json({
        error: "Missing press conference input. Provide 'notesText', 'statements', or 'raw_quote'.",
      });
    }

    // Register signals into global overrides ledger and news feed
    const newsItems = registerAvailabilitySignals(
      extractedSignals,
      coach_name,
      team_id ? Number(team_id) : undefined
    );

    const activeOverrides = getGlobalAvailabilityOverrides();

    res.json({
      version: AVAILABILITY_INTEL_VERSION,
      status: "ok",
      signals_extracted_count: extractedSignals.length,
      signals: extractedSignals,
      headlines: extractedSignals.map((s) => s.catchy_headline),
      registered_news_items: newsItems,
      active_overrides_count: activeOverrides.size,
    });
  } catch (error: any) {
    console.error("[AvailabilityIntel] Error ingesting press conference:", error);
    res.status(500).json({ error: error?.message || "Failed to process press conference intel" });
  }
});

/**
 * GET /api/intel/news-feed
 *
 * Public live breaking news feed with optional filters:
 * - sentiment: "BREAKING_BAD" | "UNCERTAINTY" | "POSITIVE_BOOST"
 * - team: team ID number
 * - player_id: player ID number
 * - limit: max number of news items to return
 */
app.get("/api/intel/news-feed", (req: Request, res: Response) => {
  try {
    let items = getGlobalNewsFeed();

    const sentiment = typeof req.query.sentiment === "string" ? req.query.sentiment.toUpperCase() : undefined;
    if (sentiment) {
      items = items.filter((item) => item.sentiment_tag === sentiment);
    }

    const teamParam = req.query.team ? parseInt(req.query.team as string, 10) : undefined;
    if (teamParam && !isNaN(teamParam)) {
      items = items.filter((item) => item.team_id === teamParam);
    }

    const playerParam = req.query.player_id ? parseInt(req.query.player_id as string, 10) : undefined;
    if (playerParam && !isNaN(playerParam)) {
      items = items.filter((item) => item.player_id === playerParam);
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = limitParam && !isNaN(limitParam) && limitParam > 0 ? limitParam : 50;

    res.json({
      version: AVAILABILITY_INTEL_VERSION,
      timestamp: new Date().toISOString(),
      total_count: items.length,
      items: items.slice(0, limit),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to retrieve news feed" });
  }
});

/**
 * GET /api/intel/overrides
 *
 * Returns list of all active player availability overrides.
 */
app.get("/api/intel/overrides", (_req: Request, res: Response) => {
  try {
    const overridesMap = getGlobalAvailabilityOverrides();
    const overridesList: Array<any> = [];
    for (const [playerId, override] of overridesMap.entries()) {
      overridesList.push({
        player_id: playerId,
        ...override,
      });
    }

    res.json({
      version: AVAILABILITY_INTEL_VERSION,
      timestamp: new Date().toISOString(),
      count: overridesList.length,
      overrides: overridesList,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to retrieve active overrides" });
  }
});

/**
 * DELETE /api/intel/overrides
 *
 * Clears all active player availability overrides (e.g. for testing or GW reset).
 */
app.delete("/api/intel/overrides", (_req: Request, res: Response) => {
  try {
    const overridesMap = getGlobalAvailabilityOverrides();
    const clearedCount = overridesMap.size;
    clearGlobalAvailabilityOverrides();

    res.json({
      version: AVAILABILITY_INTEL_VERSION,
      status: "cleared",
      message: "All active availability overrides and news items have been reset",
      cleared_count: clearedCount,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to clear availability overrides" });
  }
});

/**
 * DELETE /api/intel/overrides/:playerId
 *
 * Clears active availability override for a specific player.
 */
app.delete("/api/intel/overrides/:playerId", (req: Request, res: Response) => {
  try {
    const playerId = parseInt(req.params.playerId, 10);
    if (isNaN(playerId)) {
      return res.status(400).json({ error: "Invalid player ID" });
    }

    const existed = clearGlobalAvailabilityOverrideForPlayer(playerId);
    const overridesMap = getGlobalAvailabilityOverrides();

    res.json({
      version: AVAILABILITY_INTEL_VERSION,
      status: existed ? "cleared" : "not_found",
      player_id: playerId,
      active_overrides_remaining: overridesMap.size,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to clear player availability override" });
  }
});

/**
 * GET /press-room
 *
 * User-facing Live Press Room & Breaking News Feed hub.
 */
app.get("/press-room", async (req: Request, res: Response) => {
  try {
    const bootstrap = await fetchBootstrapData();
    const newsFeed = getGlobalNewsFeed();
    const overridesMap = getGlobalAvailabilityOverrides();

    const overridesList: Array<any> = [];
    for (const [playerId, override] of overridesMap.entries()) {
      const playerMatch = bootstrap.players.find((p) => p.id === playerId);
      overridesList.push({
        player_id: playerId,
        player_name: playerMatch?.web_name || `Player ${playerId}`,
        team_name: playerMatch?.team_short_name || "",
        ...override,
      });
    }

    res.render("press_room.html", {
      news_feed: newsFeed,
      overrides: overridesList,
      teams: bootstrap.teams,
      request: buildRequestContext(req),
    });
  } catch (error: any) {
    res.render("press_room.html", {
      news_feed: [],
      overrides: [],
      teams: [],
      error: error?.message || "Failed to load press room",
      request: buildRequestContext(req),
    });
  }
});

/**
 * GET /api/expert/recommendations
 *
 * Contract Version: expert-advisor.v1
 * Returns curated Top Targets, Differentials, Value Picks, and Captaincy Matrix.
 * Supports filtering by position (element_type / position) and maximum budget (max_cost / budget).
 */
app.get("/api/expert/recommendations", async (req: Request, res: Response) => {
  try {
    const horizonParam = parseInt(String(req.query.horizon || "5"), 10);
    const horizon = isNaN(horizonParam) || horizonParam <= 0 ? 5 : Math.min(horizonParam, 10);

    let elementType: number | null = null;
    if (req.query.element_type) {
      const parsed = parseInt(String(req.query.element_type), 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 4) {
        elementType = parsed;
      }
    } else if (req.query.position) {
      const pos = String(req.query.position).toUpperCase();
      if (pos === "GKP" || pos === "GK") elementType = 1;
      else if (pos === "DEF") elementType = 2;
      else if (pos === "MID") elementType = 3;
      else if (pos === "FWD") elementType = 4;
    }

    let maxCost: number | null = null;
    if (req.query.max_cost) {
      const parsed = parseFloat(String(req.query.max_cost));
      if (!isNaN(parsed) && parsed > 0) maxCost = parsed;
    } else if (req.query.budget) {
      const parsed = parseFloat(String(req.query.budget));
      if (!isNaN(parsed) && parsed > 0) maxCost = parsed;
    }

    const recommendations = await getExpertRecommendations({
      elementType,
      maxCost,
      horizon,
      playerHistories: getSharedPlayerHistories(),
    });

    res.json(recommendations);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to generate expert recommendations" });
  }
});

/**
 * GET /expert-hub
 *
 * User-facing Expert Advisory & Differential Radar dashboard.
 */
app.get("/expert-hub", async (req: Request, res: Response) => {
  try {
    let elementType: number | null = null;
    if (req.query.element_type) {
      const parsed = parseInt(String(req.query.element_type), 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 4) {
        elementType = parsed;
      }
    }

    let maxCost: number | null = null;
    if (req.query.max_cost) {
      const parsed = parseFloat(String(req.query.max_cost));
      if (!isNaN(parsed) && parsed > 0) maxCost = parsed;
    }

    const recommendations = await getExpertRecommendations({
      elementType,
      maxCost,
      horizon: 5,
      playerHistories: getSharedPlayerHistories(),
    });

    res.render("expert_hub.html", {
      recommendations,
      filters: {
        element_type: elementType,
        max_cost: maxCost,
      },
      request: buildRequestContext(req),
    });
  } catch (error: any) {
    res.status(500).render("press_room.html", {
      news_feed: [],
      overrides: [],
      teams: [],
      error: error?.message || "Failed to load Expert Hub",
      request: buildRequestContext(req),
    });
  }
});

// Catch-all route to home
app.get("*", (_req: Request, res: Response) => {
  res.redirect("/");
});

if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FPL Expert server running on http://0.0.0.0:${PORT}`);
  });
}

export { app };
