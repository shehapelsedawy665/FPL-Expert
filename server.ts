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

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure static file serving
const staticDir = path.join(__dirname, "static");
app.use("/static", express.static(staticDir));

// Configure Nunjucks view engine
const templatesDir = path.join(__dirname, "templates");
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
      teamData.entry_history
    );

    res.render("my_team.html", {
      team_id: teamIdStr,
      summary: result.summary,
      analysis: result.analysis,
      squad_count: result.squad_count,
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
      teamData.entry_history
    );

    res.json({
      ...result,
      snapshot: bootstrap.snapshot.toDict(),
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

    res.json({
      player: ratedPlayer,
      history: enrichedHistory,
      prediction_features: predictionFeatures,
      expected_minutes_model: expectedMinutesResult,
      snapshot: bootstrap.snapshot.toDict(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load player" });
  }
});

// Catch-all route to home
app.get("*", (_req: Request, res: Response) => {
  res.redirect("/");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FPL Expert server running on http://0.0.0.0:${PORT}`);
});
