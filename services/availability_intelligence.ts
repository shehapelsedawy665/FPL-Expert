import { GoogleGenAI, Type } from "@google/genai";

/**
 * Phase 8: Live Press Conference & Availability Intelligence
 * Contract version: availability-intel.v1
 */
export const AVAILABILITY_INTEL_VERSION = "availability-intel.v1";

export type InjuryStatus =
  | "RULED_OUT"
  | "HIGH_DOUBT"
  | "FIFTY_FIFTY"
  | "MINOR_KNOCK_FIT"
  | "AVAILABLE"
  | "UNKNOWN";

export type SentimentTag = "BREAKING_BAD" | "UNCERTAINTY" | "POSITIVE_BOOST";

export type AvailabilityProvenance =
  | "LIVE_PRESS_CONFERENCE"
  | "OFFICIAL_FPL_BOOTSTRAP";

export const INJURY_STATUS_PROBABILITIES: Record<InjuryStatus, number> = {
  RULED_OUT: 0.0,
  HIGH_DOUBT: 0.25,
  FIFTY_FIFTY: 0.50,
  MINOR_KNOCK_FIT: 0.75,
  AVAILABLE: 1.0,
  UNKNOWN: 1.0,
};

export function getSentimentTagForStatus(status: InjuryStatus): SentimentTag {
  switch (status) {
    case "RULED_OUT":
      return "BREAKING_BAD";
    case "HIGH_DOUBT":
    case "FIFTY_FIFTY":
    case "UNKNOWN":
      return "UNCERTAINTY";
    case "MINOR_KNOCK_FIT":
    case "AVAILABLE":
      return "POSITIVE_BOOST";
  }
}

export function generateCatchyHeadline(
  playerName: string,
  status: InjuryStatus,
  coachName?: string
): string {
  const coach = coachName ? coachName.trim() : "";
  switch (status) {
    case "RULED_OUT":
      return coach
        ? `🚨 ${coach} Confirms ${playerName} Blow: Ruled Out of GW Action!`
        : `🚨 ${playerName} Injury Blow: Ruled Out of Upcoming Match!`;
    case "HIGH_DOUBT":
      return coach
        ? `⚠️ ${coach} Alerts on ${playerName}: Major Doubt for Weekend`
        : `⚠️ Major Doubt: ${playerName} Struggling for Fitness Ahead of Match`;
    case "FIFTY_FIFTY":
      return coach
        ? `⚠️ ${coach} Roulette: ${playerName} Faces Late Fitness Test`
        : `⚠️ Late Fitness Test: ${playerName} Touch-and-Go for GW Fixture`;
    case "MINOR_KNOCK_FIT":
      return coach
        ? `🟢 ${coach} Relieved: Minor Knock Precaution for ${playerName}`
        : `🟢 Minor Knock Precaution for ${playerName}: Expected Fit`;
    case "AVAILABLE":
      return coach
        ? `🟢 ${coach} Gives ${playerName} Green Light: 100% Fit & Ready to Start!`
        : `🟢 Green Light: ${playerName} Passed Fit & Available to Play!`;
    default:
      return `ℹ️ Availability Update: ${playerName}`;
  }
}

export interface CoachStatement {
  coach_name: string;
  team_id: number;
  raw_quote: string;
  source?: string;
  timestamp?: string;
}

export interface ExtractedInjurySignal {
  player_id: number;
  player_name: string;
  injury_status: InjuryStatus;
  adjusted_availability_prob: number; // e.g. RULED_OUT: 0.0, HIGH_DOUBT: 0.25, FIFTY_FIFTY: 0.50, MINOR_KNOCK_FIT: 0.75, AVAILABLE: 1.0
  confidence: number; // 0.0 to 1.0
  quote_rationale: string;
  catchy_headline: string;
  sentiment_tag: SentimentTag;
  published_at: string; // ISO timestamp
  coach_name?: string;
  team_id?: number;
}

export interface PlayerAvailabilityOverride {
  status: InjuryStatus;
  adjusted_availability_prob: number;
  confidence: number;
  provenance: AvailabilityProvenance;
  quote_rationale: string;
  catchy_headline?: string;
  sentiment_tag?: SentimentTag;
  published_at?: string;
  original_chance_of_playing?: number | null;
  original_status?: string;
}

export interface NewsFeedItem {
  id: string;
  player_id: number;
  player_name: string;
  coach_name?: string;
  team_id?: number;
  injury_status: InjuryStatus;
  adjusted_availability_prob: number;
  confidence: number;
  quote_rationale: string;
  catchy_headline: string;
  sentiment_tag: SentimentTag;
  published_at: string;
  provenance: AvailabilityProvenance;
}

// In-Memory Global Override Ledger & News Feed Store
const globalAvailabilityOverrides = new Map<number, PlayerAvailabilityOverride>();
const globalNewsFeed: NewsFeedItem[] = [];

export function getGlobalAvailabilityOverrides(): Map<number, PlayerAvailabilityOverride> {
  return globalAvailabilityOverrides;
}

export function getGlobalNewsFeed(): NewsFeedItem[] {
  return [...globalNewsFeed];
}

export function registerAvailabilitySignals(
  signals: ExtractedInjurySignal[],
  coachName?: string,
  teamId?: number
): NewsFeedItem[] {
  const registeredItems: NewsFeedItem[] = [];

  for (const sig of signals) {
    const override: PlayerAvailabilityOverride = {
      status: sig.injury_status,
      adjusted_availability_prob: sig.adjusted_availability_prob,
      confidence: sig.confidence,
      provenance: "LIVE_PRESS_CONFERENCE",
      quote_rationale: sig.quote_rationale,
      catchy_headline: sig.catchy_headline,
      sentiment_tag: sig.sentiment_tag,
      published_at: sig.published_at,
    };
    globalAvailabilityOverrides.set(sig.player_id, override);

    const newsItem: NewsFeedItem = {
      id: `news_${sig.player_id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      player_id: sig.player_id,
      player_name: sig.player_name,
      coach_name: coachName || sig.coach_name,
      team_id: teamId || sig.team_id,
      injury_status: sig.injury_status,
      adjusted_availability_prob: sig.adjusted_availability_prob,
      confidence: sig.confidence,
      quote_rationale: sig.quote_rationale,
      catchy_headline: sig.catchy_headline,
      sentiment_tag: sig.sentiment_tag,
      published_at: sig.published_at,
      provenance: "LIVE_PRESS_CONFERENCE",
    };

    // Prepend so newest updates appear first
    globalNewsFeed.unshift(newsItem);
    registeredItems.push(newsItem);
  }

  return registeredItems;
}

export { globalAvailabilityOverrides, globalNewsFeed };

export function clearGlobalAvailabilityOverrides(): void {
  globalAvailabilityOverrides.clear();
  globalNewsFeed.length = 0;
}

export function clearGlobalAvailabilityOverrideForPlayer(playerId: number): boolean {
  return globalAvailabilityOverrides.delete(playerId);
}

export interface OverriddenPlayerFields {
  availability_provenance: AvailabilityProvenance;
  availability_override?: PlayerAvailabilityOverride;
  availability_signal?: ExtractedInjurySignal;
}

export interface ApplyAvailabilityOverridesOptions {
  blendMode?: "OVERRIDE" | "BLEND";
  minConfidence?: number;
}

/**
 * Apply live press conference injury availability overrides or blending to player objects.
 * Exposes clear provenance (LIVE_PRESS_CONFERENCE vs OFFICIAL_FPL_BOOTSTRAP).
 */
export function applyAvailabilityOverrides<T extends Record<string, any>>(
  players: T[],
  signals: ExtractedInjurySignal[],
  options: ApplyAvailabilityOverridesOptions = {}
): Array<T & OverriddenPlayerFields> {
  const { blendMode = "OVERRIDE", minConfidence = 0.5 } = options;

  const signalMap = new Map<number, ExtractedInjurySignal>();
  const signalNameMap = new Map<string, ExtractedInjurySignal>();

  for (const sig of signals) {
    if (sig.injury_status !== "UNKNOWN" && sig.confidence >= minConfidence) {
      signalMap.set(sig.player_id, sig);
      if (sig.player_name) {
        signalNameMap.set(sig.player_name.toLowerCase().trim(), sig);
      }
    }
  }

  return players.map((p) => {
    const playerCopy = { ...p } as T & OverriddenPlayerFields;
    const matchedSignal =
      signalMap.get(p.id) ||
      (p.web_name ? signalNameMap.get(String(p.web_name).toLowerCase().trim()) : undefined);

    if (matchedSignal) {
      let finalProb = matchedSignal.adjusted_availability_prob;
      if (
        blendMode === "BLEND" &&
        p.chance_of_playing_next_round !== null &&
        p.chance_of_playing_next_round !== undefined
      ) {
        const officialProb = Number(p.chance_of_playing_next_round) / 100.0;
        finalProb =
          Math.round(
            (matchedSignal.confidence * matchedSignal.adjusted_availability_prob +
              (1.0 - matchedSignal.confidence) * officialProb) *
              100
          ) / 100;
      }

      const override: PlayerAvailabilityOverride = {
        status: matchedSignal.injury_status,
        adjusted_availability_prob: finalProb,
        confidence: matchedSignal.confidence,
        provenance: "LIVE_PRESS_CONFERENCE",
        quote_rationale: matchedSignal.quote_rationale,
        catchy_headline: matchedSignal.catchy_headline,
        sentiment_tag: matchedSignal.sentiment_tag,
        published_at: matchedSignal.published_at,
        original_chance_of_playing: p.chance_of_playing_next_round ?? null,
        original_status: p.status,
      };

      playerCopy.availability_provenance = "LIVE_PRESS_CONFERENCE";
      playerCopy.availability_signal = matchedSignal;
      playerCopy.availability_override = override;
      (playerCopy as any).chance_of_playing_next_round = Math.round(finalProb * 100);

      if (matchedSignal.injury_status === "RULED_OUT") {
        (playerCopy as any).status = "i";
      } else if (
        matchedSignal.injury_status === "HIGH_DOUBT" ||
        matchedSignal.injury_status === "FIFTY_FIFTY"
      ) {
        (playerCopy as any).status = "d";
      } else if (
        matchedSignal.injury_status === "AVAILABLE" ||
        matchedSignal.injury_status === "MINOR_KNOCK_FIT"
      ) {
        (playerCopy as any).status = "a";
      }
      (playerCopy as any).news = matchedSignal.quote_rationale;
    } else {
      playerCopy.availability_provenance = "OFFICIAL_FPL_BOOTSTRAP";
      playerCopy.availability_override = undefined;
      playerCopy.availability_signal = undefined;
    }

    return playerCopy;
  });
}

/**
 * Apply availability override to a single player object.
 */
export function applyAvailabilityOverrideToPlayer<T extends Record<string, any>>(
  player: T,
  signal?: ExtractedInjurySignal | null,
  options: ApplyAvailabilityOverridesOptions = {}
): T & OverriddenPlayerFields {
  const result = applyAvailabilityOverrides([player], signal ? [signal] : [], options);
  return result[0];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mock / Offline Rule-Based Fallback Parser.
 * Maps standard coach statements and English availability patterns without external network calls.
 */
export function parsePressConferenceNotesOffline(
  notesText: string,
  activeSquadPlayers: Array<{ id: number; web_name: string; team: number }>,
  options?: { coachName?: string; teamId?: number }
): ExtractedInjurySignal[] {
  if (!notesText || !notesText.trim() || !activeSquadPlayers || activeSquadPlayers.length === 0) {
    return [];
  }

  const results: ExtractedInjurySignal[] = [];

  // Patterns for availability classification
  const ruledOutRegex =
    /\b(will miss|ruled out|out for|sidelined|won'?t feature|will not feature|won'?t play|will not play|definitely out|unavailable|not available|broken|acl|hamstring tear|surgery|out of contention)\b/i;
  const highDoubtRegex =
    /\b(major doubt|huge doubt|very doubtful|unlikely to play|unlikely to feature|struggling to be fit|not looking good|unlikely)\b/i;
  const fiftyFiftyRegex =
    /\b(small issue|late fitness test|touch and go|50[\s/-]?50|fifty[\s/-]fifty|assess (him|them|player)?\s*tomorrow|will assess|decision tomorrow|face a test|fitness test|doubtful|doubt|question mark|day to day)\b/i;
  const minorKnockRegex =
    /\b(minor knock|slight knock|niggle|slight niggle|precaution|some fatigue|slight problem|should be fine|hopeful|optimistic)\b/i;
  const availableRegex =
    /\b(available|passed fit|trained normally|trained with the squad|trained with the team|trained with the group|trained all week|ready to start|ready to play|100% fit|fully fit|good to go|completely fit|back in contention|fit to start|fit to play|in the squad|no pain|feels good)\b/i;

  // Split into lines/paragraphs or sentence units to maintain conversational context
  const linesOrParagraphs = notesText
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const nowIso = new Date().toISOString();

  for (const player of activeSquadPlayers) {
    const nameRegex = new RegExp(`\\b${escapeRegex(player.web_name)}\\b`, "i");

    // Check which lines/paragraphs contain this player
    let matchingBlocks = linesOrParagraphs.filter((block) => nameRegex.test(block));
    if (matchingBlocks.length === 0) {
      // Fallback: search across all sentences in single-line blobs
      const sentences = notesText
        .split(/[.!?]+(?:\s+|$)|;\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      matchingBlocks = sentences.filter((s) => nameRegex.test(s));
    }
    if (matchingBlocks.length === 0) continue;

    const combinedQuote = matchingBlocks.join(". ");

    let status: InjuryStatus = "UNKNOWN";
    let prob = 1.0;
    let confidence = 0.5;

    // Prioritized classification
    if (ruledOutRegex.test(combinedQuote)) {
      status = "RULED_OUT";
      prob = 0.0;
      confidence = 0.95;
    } else if (highDoubtRegex.test(combinedQuote)) {
      status = "HIGH_DOUBT";
      prob = 0.25;
      confidence = 0.85;
    } else if (fiftyFiftyRegex.test(combinedQuote)) {
      status = "FIFTY_FIFTY";
      prob = 0.50;
      confidence = 0.85;
    } else if (availableRegex.test(combinedQuote)) {
      status = "AVAILABLE";
      prob = 1.0;
      confidence = 0.95;
    } else if (minorKnockRegex.test(combinedQuote)) {
      status = "MINOR_KNOCK_FIT";
      prob = 0.75;
      confidence = 0.85;
    } else {
      status = "UNKNOWN";
      prob = 1.0;
      confidence = 0.4;
    }

    if (status !== "UNKNOWN") {
      const headline = generateCatchyHeadline(player.web_name, status, options?.coachName);
      const sentiment = getSentimentTagForStatus(status);
      results.push({
        player_id: player.id,
        player_name: player.web_name,
        injury_status: status,
        adjusted_availability_prob: prob,
        confidence,
        quote_rationale: combinedQuote,
        catchy_headline: headline,
        sentiment_tag: sentiment,
        published_at: nowIso,
        coach_name: options?.coachName,
        team_id: options?.teamId ?? player.team,
      });
    }
  }

  return results;
}

/**
 * Extract signals from structured CoachStatement objects.
 */
export function extractSignalsFromCoachStatements(
  statements: CoachStatement[],
  activeSquadPlayers: Array<{ id: number; web_name: string; team: number }>
): ExtractedInjurySignal[] {
  const allSignals: ExtractedInjurySignal[] = [];
  for (const s of statements) {
    const sigs = parsePressConferenceNotesOffline(s.raw_quote, activeSquadPlayers, {
      coachName: s.coach_name,
      teamId: s.team_id,
    });
    allSignals.push(...sigs);
  }
  return allSignals;
}

/**
 * Real Gemini Extractor utilizing @google/genai SDK with structured schema.
 */
export async function parsePressConferenceNotesWithGemini(
  notesText: string,
  activeSquadPlayers: Array<{ id: number; web_name: string; team: number }>,
  apiKey?: string,
  options?: { coachName?: string; teamId?: number }
): Promise<ExtractedInjurySignal[]> {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const rosterContext = activeSquadPlayers.map((p) => ({
    player_id: p.id,
    player_name: p.web_name,
    team_id: p.team,
  }));

  const prompt = `Active Squad Roster:\n${JSON.stringify(
    rosterContext
  )}\n\nPress Conference / Injury News Text:\n${notesText}`;

  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: prompt,
    config: {
      systemInstruction:
        "You are an authoritative Premier League sports medicine and tactical availability analyst. " +
        "Analyze the provided coach press conference statements and injury news text. " +
        "Extract availability signals ONLY for players present in the provided active squad roster. " +
        "Map each player to one of the following exact injury statuses: " +
        "- RULED_OUT: Coach explicitly ruled the player out, confirmed missing the match, surgery, or severe injury (availability probability: 0.0). " +
        "- HIGH_DOUBT: Coach reported player is a major doubt, very unlikely to play, or struggling significantly (availability probability: 0.25). " +
        "- FIFTY_FIFTY: Late fitness test required, touch-and-go, day-to-day decision (availability probability: 0.50). " +
        "- MINOR_KNOCK_FIT: Slight knock, minor fatigue, or precautionary sub, but expected to play (availability probability: 0.75). " +
        "- AVAILABLE: Fully fit, passed fit, trained normally, or confirmed available/starting (availability probability: 1.0). " +
        "- UNKNOWN: Status cannot be determined. " +
        "Also generate: " +
        "- catchy_headline: A short, punchy, high-engagement breaking news headline tailored for FPL managers with emojis (e.g. '🚨 Arteta Confirms Saka Blow: Ruled Out of GW Action!', '⚠️ Pep Roulette: De Bruyne Faces Late Fitness Test', '🟢 Slot Gives Salah Green Light: 100% Fit to Start!'). " +
        "- sentiment_tag: 'BREAKING_BAD' (for ruled out), 'UNCERTAINTY' (for doubt/late test), or 'POSITIVE_BOOST' (for fit/cleared). " +
        "- published_at: current ISO timestamp. " +
        "Provide a concise quote rationale and confidence score between 0.0 and 1.0.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            player_id: { type: Type.INTEGER, description: "The FPL player ID from roster" },
            player_name: { type: Type.STRING, description: "The player web name" },
            injury_status: {
              type: Type.STRING,
              enum: ["RULED_OUT", "HIGH_DOUBT", "FIFTY_FIFTY", "MINOR_KNOCK_FIT", "AVAILABLE", "UNKNOWN"],
            },
            adjusted_availability_prob: { type: Type.NUMBER, description: "Probability 0.0 to 1.0" },
            confidence: { type: Type.NUMBER, description: "Confidence 0.0 to 1.0" },
            quote_rationale: { type: Type.STRING, description: "Direct quote or rationale" },
            catchy_headline: { type: Type.STRING, description: "Punchy breaking news headline" },
            sentiment_tag: {
              type: Type.STRING,
              enum: ["BREAKING_BAD", "UNCERTAINTY", "POSITIVE_BOOST"],
            },
            published_at: { type: Type.STRING, description: "ISO timestamp" },
          },
          required: [
            "player_id",
            "player_name",
            "injury_status",
            "adjusted_availability_prob",
            "confidence",
            "quote_rationale",
            "catchy_headline",
            "sentiment_tag",
          ],
        },
      },
    },
  });

  const text = response.text ? response.text.trim() : "";
  if (!text) return [];

  const nowIso = new Date().toISOString();

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: any) => {
      const status = (item.injury_status as InjuryStatus) || "UNKNOWN";
      const name = String(item.player_name || "");
      const headline =
        item.catchy_headline && String(item.catchy_headline).trim()
          ? String(item.catchy_headline).trim()
          : generateCatchyHeadline(name, status, options?.coachName);
      const sentiment =
        (item.sentiment_tag as SentimentTag) || getSentimentTagForStatus(status);

      return {
        player_id: Number(item.player_id),
        player_name: name,
        injury_status: status,
        adjusted_availability_prob: Math.max(0, Math.min(1, Number(item.adjusted_availability_prob ?? 1.0))),
        confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.8))),
        quote_rationale: String(item.quote_rationale || ""),
        catchy_headline: headline,
        sentiment_tag: sentiment,
        published_at: String(item.published_at || nowIso),
        coach_name: options?.coachName,
        team_id: options?.teamId,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Main parser entry point.
 * Seamlessly uses Gemini API when GEMINI_API_KEY is available, or gracefully falls back to offline parser.
 */
export async function parsePressConferenceNotes(
  notesText: string,
  activeSquadPlayers: Array<{ id: number; web_name: string; team: number }>,
  options?: { geminiApiKey?: string; useMockFallback?: boolean; coachName?: string; teamId?: number }
): Promise<ExtractedInjurySignal[]> {
  if (!notesText || !notesText.trim() || !activeSquadPlayers || activeSquadPlayers.length === 0) {
    return [];
  }

  const apiKey = options?.geminiApiKey || process.env.GEMINI_API_KEY;
  if (options?.useMockFallback || !apiKey) {
    return parsePressConferenceNotesOffline(notesText, activeSquadPlayers, {
      coachName: options?.coachName,
      teamId: options?.teamId,
    });
  }

  try {
    return await parsePressConferenceNotesWithGemini(notesText, activeSquadPlayers, apiKey, {
      coachName: options?.coachName,
      teamId: options?.teamId,
    });
  } catch (err) {
    console.warn("[AvailabilityIntel] Gemini extraction error, falling back to offline parser:", err);
    return parsePressConferenceNotesOffline(notesText, activeSquadPlayers, {
      coachName: options?.coachName,
      teamId: options?.teamId,
    });
  }
}

/**
 * Apply currently active global availability overrides to a squad or player array.
 */
export function applyActiveGlobalOverrides<T extends Record<string, any>>(
  players: T[],
  options: ApplyAvailabilityOverridesOptions = {}
): Array<T & OverriddenPlayerFields> {
  if (globalAvailabilityOverrides.size === 0) {
    return players.map((p) => {
      const copy = { ...p } as T & OverriddenPlayerFields;
      copy.availability_provenance = copy.availability_provenance || "OFFICIAL_FPL_BOOTSTRAP";
      return copy;
    });
  }

  // Convert active overrides into ExtractedInjurySignals
  const signals: ExtractedInjurySignal[] = [];
  const nowIso = new Date().toISOString();

  for (const [playerId, ov] of globalAvailabilityOverrides.entries()) {
    const playerMatch = players.find((p) => p.id === playerId);
    const pName = playerMatch?.web_name || `Player ${playerId}`;
    signals.push({
      player_id: playerId,
      player_name: pName,
      injury_status: ov.status,
      adjusted_availability_prob: ov.adjusted_availability_prob,
      confidence: ov.confidence,
      quote_rationale: ov.quote_rationale,
      catchy_headline: ov.catchy_headline || generateCatchyHeadline(pName, ov.status),
      sentiment_tag: ov.sentiment_tag || getSentimentTagForStatus(ov.status),
      published_at: ov.published_at || nowIso,
    });
  }

  return applyAvailabilityOverrides(players, signals, options);
}
