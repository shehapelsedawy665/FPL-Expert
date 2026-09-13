import {
  numberValue,
  clamp,
} from "./rating_engine";
import {
  PredictionSnapshot,
  GameweekBoundary,
} from "./prediction_contract";
import {
  DecisionEngineResult,
  runFplDecisionEngine,
  buildDecisionSquadFromPlayers,
} from "./decision_engine";
import { applyActiveGlobalOverrides } from "./availability_intelligence";

export const VALID_FORMATIONS: Array<[number, number, number]> = [
  [3, 5, 2],
  [3, 4, 3],
  [4, 4, 2],
  [4, 3, 3],
  [4, 5, 1],
  [5, 3, 2],
  [5, 4, 1],
  [5, 2, 3],
];

export const GROUP_DEFINITIONS: Array<[number, string, number]> = [
  [1, "Goalkeepers", 2],
  [2, "Defenders", 5],
  [3, "Midfielders", 5],
  [4, "Forwards", 3],
];

export const POSITION_SHORT_NAMES: Record<number, string> = {
  1: "GKP",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

export interface BenchPriorityInputs {
  expert_score: number;
  minutes_security: number;
  expected_minutes: number;
  next_gameweek_performance_signal: number;
  availability_penalty: number;
}

export function nextGameweekSignal(player: Record<string, any>): number {
  const futureScore = numberValue(player.future_fpl_score);
  const currentForm = numberValue(player.current_form_score);
  const formMetric = numberValue(player.form);
  const normalizedForm = clamp(formMetric * 10.0);
  return clamp(futureScore * 0.60 + currentForm * 0.25 + normalizedForm * 0.15);
}

export function benchPriorityReason(
  player: Record<string, any>,
  inputs: BenchPriorityInputs
): string {
  const reasons: string[] = [];
  if (inputs.minutes_security >= 70.0) {
    reasons.push("safe substitute appearance minutes");
  } else if (inputs.minutes_security <= 40.0) {
    reasons.push("rotation risk");
  }

  if (inputs.next_gameweek_performance_signal >= 70.0) {
    reasons.push("high next-gameweek upside");
  } else if (inputs.next_gameweek_performance_signal <= 45.0) {
    reasons.push("limited immediate scoring upside");
  }

  if (inputs.availability_penalty >= 10.0) {
    reasons.push("availability doubt");
  }

  if (reasons.length === 0) {
    reasons.push("balanced underlying substitute profile");
  }

  const first = reasons[0];
  return `${first.charAt(0).toUpperCase() + first.slice(1)} determines this bench order.`;
}

export function calculateBenchPriorityScore(
  player: Record<string, any>
): [number, BenchPriorityInputs, string] {
  const breakdown = player.rating_breakdown || {};
  const availPenalty = numberValue(breakdown.availability_penalty);
  const minutesSec = numberValue(player.minutes_security);
  const expMinutes = numberValue(player.expected_minutes_proxy);
  const nextGwSignal = nextGameweekSignal(player);
  const expertScore = numberValue(player.expert_score);

  const weightedBenchScore =
    minutesSec * 0.40 +
    expMinutes * 0.20 +
    nextGwSignal * 0.25 +
    expertScore * 0.15;
  const finalPriorityScore = clamp(
    weightedBenchScore - availPenalty * 0.80,
    0.0,
    100.0
  );

  const inputs: BenchPriorityInputs = {
    expert_score: Math.round(expertScore * 10) / 10,
    minutes_security: Math.round(minutesSec * 10) / 10,
    expected_minutes: Math.round(expMinutes * 10) / 10,
    next_gameweek_performance_signal: Math.round(nextGwSignal * 10) / 10,
    availability_penalty: Math.round(availPenalty * 10) / 10,
  };
  (inputs as any).next_gameweek_performanceSignal = inputs.next_gameweek_performance_signal;

  const reason = benchPriorityReason(player, inputs);
  return [Math.round(finalPriorityScore * 10) / 10, inputs, reason];
}

export function addBenchPriority(
  substitutes: Array<Record<string, any>>
): Array<Record<string, any>> {
  const enriched: Array<Record<string, any>> = [];
  for (const player of substitutes) {
    const [score, inputs, reason] = calculateBenchPriorityScore(player);
    enriched.push({
      ...player,
      bench_priority_score: score,
      bench_priority_inputs: inputs,
      bench_priority_reason: reason,
    });
  }

  return enriched.sort((a, b) => {
    const scoreA = numberValue(a.bench_priority_score);
    const scoreB = numberValue(b.bench_priority_score);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const expA = numberValue(a.expert_score);
    const expB = numberValue(b.expert_score);
    if (expA !== expB) return expB - expA;
    const nowA = numberValue(a.now_cost);
    const nowB = numberValue(b.now_cost);
    if (nowA !== nowB) return nowB - nowA;
    return (a.id || 0) - (b.id || 0);
  });
}

function averageScore(players: Array<Record<string, any>>): number {
  const valid = players
    .filter((p) => !p.missing_data)
    .map((p) => numberValue(p.expert_score));
  if (valid.length === 0) return 0.0;
  const sum = valid.reduce((a, b) => a + b, 0);
  return Math.round((sum / valid.length) * 10) / 10;
}

export function calculateSquadHealth(
  players: Array<Record<string, any>>,
  startingXi: Array<Record<string, any>>
): Record<string, any> {
  let strongPicks = 0;
  let weakPicks = 0;
  let injuryRisks = 0;
  let lowConfidence = 0;

  for (const player of players) {
    if (player.missing_data) continue;
    const score = numberValue(player.expert_score);
    const availPenalty = numberValue(
      player.rating_breakdown?.availability_penalty
    );
    const conf = String(player.data_confidence || "").toLowerCase();

    if (score >= 75.0) strongPicks++;
    else if (score < 55.0) weakPicks++;

    if (availPenalty >= 10.0 || (player.status && player.status !== "a")) {
      injuryRisks++;
    }
    if (conf === "low") {
      lowConfidence++;
    }
  }

  return {
    strong_picks: strongPicks,
    weak_picks: weakPicks,
    injury_risks: injuryRisks,
    low_confidence: lowConfidence,
    average_squad_score: averageScore(players),
    average_xi_score: averageScore(startingXi),
  };
}

export function evaluateStartingXi(
  players: Array<Record<string, any>>
): {
  players: Array<Record<string, any>>;
  formation: [number, number, number];
  formation_label: string;
} {
  const available = players.filter((p) => !p.missing_data);
  const byPosition: Record<number, Array<Record<string, any>>> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };

  for (const player of available) {
    const pos = player.element_type;
    if (byPosition[pos]) byPosition[pos].push(player);
  }

  for (const pos of [1, 2, 3, 4]) {
    byPosition[pos].sort(
      (a, b) => numberValue(b.expert_score) - numberValue(a.expert_score)
    );
  }

  const chosenGk = byPosition[1][0] || null;

  let bestScore = -1.0;
  let bestFormation: [number, number, number] = [3, 4, 3];
  let bestOutfield: Array<Record<string, any>> = [];

  for (const [defCount, midCount, fwdCount] of VALID_FORMATIONS) {
    const defs = byPosition[2].slice(0, defCount);
    const mids = byPosition[3].slice(0, midCount);
    const fwds = byPosition[4].slice(0, fwdCount);

    if (
      defs.length === defCount &&
      mids.length === midCount &&
      fwds.length === fwdCount
    ) {
      const line = [...defs, ...mids, ...fwds];
      const score = line.reduce((a, b) => a + numberValue(b.expert_score), 0);
      if (score > bestScore) {
        bestScore = score;
        bestFormation = [defCount, midCount, fwdCount];
        bestOutfield = line;
      }
    }
  }

  const startingPlayers: Array<Record<string, any>> = [];
  if (chosenGk) {
    startingPlayers.push(chosenGk);
  }
  startingPlayers.push(...bestOutfield);

  return {
    players: startingPlayers,
    formation: bestFormation,
    formation_label: `${bestFormation[0]}-${bestFormation[1]}-${bestFormation[2]}`,
  };
}

export function recommendCaptaincy(
  startingXi: Array<Record<string, any>>
): {
  captain: Record<string, any> | null;
  vice_captain: Record<string, any> | null;
  captain_reason: string;
  vice_captain_reason: string;
} {
  const candidates = [...startingXi].sort(
    (a, b) => numberValue(b.expert_score) - numberValue(a.expert_score)
  );

  const captain = candidates[0] || null;
  const viceCaptain = candidates[1] || null;

  return {
    captain,
    vice_captain: viceCaptain,
    captain_reason: captain
      ? `Highest Expert Score (${numberValue(captain.expert_score).toFixed(1)}) and immediate scoring projection in your lineup.`
      : "No valid captain option available.",
    vice_captain_reason: viceCaptain
      ? `Second highest Expert Score (${numberValue(viceCaptain.expert_score).toFixed(1)}) as immediate backup.`
      : "No valid vice captain option available.",
  };
}

export function compileAttentionList(
  players: Array<Record<string, any>>
): Array<{ player: Record<string, any>; reason: string }> {
  const items: Array<{ player: Record<string, any>; reason: string }> = [];

  for (const player of players) {
    if (player.missing_data) {
      items.push({
        player,
        reason: "Player metadata is missing from the live FPL API.",
      });
      continue;
    }

    const availPenalty = numberValue(
      player.rating_breakdown?.availability_penalty
    );
    const score = numberValue(player.expert_score);
    const news = player.news || "";

    if (availPenalty >= 15.0 || (player.status && player.status !== "a")) {
      const statusText = player.status_label || player.status || "Doubt";
      items.push({
        player,
        reason: news
          ? `Status ${statusText}: ${news}`
          : `Availability concern (${statusText})`,
      });
    } else if (score <= 50.0) {
      items.push({
        player,
        reason: `Low Expert Score (${score.toFixed(1)}) — weak fixture run or poor underlying numbers.`,
      });
    }
  }

  return items;
}

export function analyzeTeamSquad(
  players: Array<Record<string, any>>,
  picks: Array<Record<string, any>>,
  entry: Record<string, any>,
  gameweek: number,
  entryHistory: Record<string, any>,
  options?: {
    snapshot?: PredictionSnapshot;
    allFixtures?: Array<Record<string, any>>;
    allTeams?: Array<Record<string, any>>;
    playerHistories?: Record<number, Array<Record<string, any>>>;
  }
): {
  summary: Record<string, any>;
  analysis: Record<string, any>;
  squad_count: number;
} {
  const playerLookup: Record<number, Record<string, any>> = {};
  for (const player of players) {
    playerLookup[player.id] = player;
  }

  const squadPlayers: Array<Record<string, any>> = [];
  for (const pick of picks) {
    const elementId = pick.element;
    const fullData = playerLookup[elementId];
    if (fullData) {
      squadPlayers.push({
        ...fullData,
        pick_position: pick.position,
        is_captain: pick.is_captain,
        is_vice_captain: pick.is_vice_captain,
        multiplier: pick.multiplier,
      });
    } else {
      squadPlayers.push({
        id: elementId,
        missing_data: true,
        web_name: `Player ${elementId}`,
        element_type: 3,
        pick_position: pick.position,
      });
    }
  }

  // Phase 8: Automatically apply live availability overrides before Starting XI optimization
  const effectiveSquadPlayers = applyActiveGlobalOverrides(squadPlayers);

  const groups: Array<{ name: string; position_id: number; players: Array<Record<string, any>> }> = [];
  for (const [posId, groupName] of GROUP_DEFINITIONS) {
    const groupPlayers = effectiveSquadPlayers
      .filter((p) => p.element_type === posId)
      .sort((a, b) => numberValue(b.expert_score) - numberValue(a.expert_score));
    groups.push({
      name: groupName,
      position_id: posId,
      players: groupPlayers,
    });
  }

  // Legacy analysis preserved exactly
  const startingXiResult = evaluateStartingXi(effectiveSquadPlayers);
  const startingIds = new Set(startingXiResult.players.map((p) => p.id));

  const benchPlayers = effectiveSquadPlayers.filter((p) => !startingIds.has(p.id));
  const benchGk = benchPlayers.find((p) => p.element_type === 1) || null;
  const benchOutfield = benchPlayers.filter((p) => p.element_type !== 1);
  const prioritizedSubs = addBenchPriority(benchOutfield);

  const captaincy = recommendCaptaincy(startingXiResult.players);
  const health = calculateSquadHealth(effectiveSquadPlayers, startingXiResult.players);
  const attention = compileAttentionList(effectiveSquadPlayers);

  // Phase 6A Predictive Decision Engine
  let decisionEngineResult: DecisionEngineResult | null = null;
  if (options?.snapshot && effectiveSquadPlayers.length === 15 && !effectiveSquadPlayers.some((p) => p.missing_data)) {
    try {
      const decisionSquad = buildDecisionSquadFromPlayers({
        players: effectiveSquadPlayers,
        snapshot: options.snapshot,
        allFixtures: options.allFixtures,
        allTeams: options.allTeams,
        playerHistories: options.playerHistories,
      });
      decisionEngineResult = runFplDecisionEngine({
        squad: decisionSquad,
        snapshot: options.snapshot,
      });
    } catch (err) {
      console.error("Decision engine evaluation error:", err);
    }
  }

  const summary = {
    team_name: entry.name || "My Team",
    manager_name: `${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim(),
    overall_rank: entry.summary_overall_rank || null,
    total_points: entry.summary_overall_points || null,
    gameweek,
    bank: entryHistory.bank ?? entry.last_deadline_bank ?? null,
    squad_value: entryHistory.value ?? entry.last_deadline_value ?? null,
  };

  const analysis: Record<string, any> = {
    groups,
    starting_xi: startingXiResult,
    bench: {
      goalkeeper: benchGk,
      substitutes: prioritizedSubs,
    },
    captaincy,
    health,
    attention,
    decision_engine: decisionEngineResult,
  };

  return {
    summary,
    analysis,
    squad_count: squadPlayers.length,
  };
}
