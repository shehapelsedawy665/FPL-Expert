/**
 * Phase 7 — Price Change Predictor & Market Momentum Engine
 * Contract Version: price-predictor.v1
 *
 * Tracks real-time transfer momentum from official FPL data to predict player
 * price rises (+£0.1m) and price falls (-£0.1m) before deadline updates.
 */

export const PRICE_PREDICTOR_VERSION = "price-predictor.v1";

export type PriceMomentumState =
  | "LIKELY_RISE_TONIGHT"
  | "RISK_OF_RISE"
  | "NEUTRAL"
  | "RISK_OF_FALL"
  | "LIKELY_FALL_TONIGHT";

export type EstimatedPriceChangeDirection = "RISE" | "FALL" | "STABLE";

export type UrgencyLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "NONE";

export interface UrgencyAssessment {
  urgency_level: UrgencyLevel;
  urgency_reason: string;
  budget_impact_if_delayed: boolean;
  incoming_player_predictions?: PlayerPricePrediction[];
  outgoing_player_predictions?: PlayerPricePrediction[];
}

export interface AssessTransferUrgencyOptions {
  transfersIn: any[];
  transfersOut: any[];
  bankAfter: number; // £m (e.g. 0.0) or tenths (e.g. 0)
  allPlayerMetaMap?: Map<number, any>;
  config?: PricePredictorConfig;
}

export interface PricePredictorConfig {
  /**
   * Total active managers in the game (defaults to 10,000,000).
   */
  totalManagers?: number;
  /**
   * Absolute minimum net transfers required for a player to trigger a price rise.
   * Protects low-owned differential assets from rising on tiny absolute transfer counts.
   * Default: 15,000.
   */
  minRiseTransfers?: number;
  /**
   * Absolute minimum net selling required for a player to trigger a price fall.
   * Default: 15,000.
   */
  minFallTransfers?: number;
  /**
   * Target ownership transfer velocity required for a price rise (e.g. 0.05 = 5%).
   * Default: 0.05.
   */
  riseVelocityTarget?: number;
  /**
   * Target ownership selling velocity required for a price fall (e.g. 0.05 = 5%).
   * Default: 0.05.
   */
  fallVelocityTarget?: number;
  /**
   * Optional custom threshold calculation model.
   */
  customThresholdModel?: (
    player: any,
    ownershipCount: number,
    totalManagers: number
  ) => { riseThreshold: number; fallThreshold: number };
}

export interface PlayerPricePrediction {
  player_id: number;
  web_name?: string;
  now_cost: number;
  price_target_percentage: number;
  momentum_state: PriceMomentumState;
  estimated_change_direction: EstimatedPriceChangeDirection;
  net_event_transfers: number;
  net_transfer_velocity: number;
  ownership_count: number;
  transfers_in_event: number;
  transfers_out_event: number;
  rise_threshold: number;
  fall_threshold: number;
  version: string;
}

/**
 * Utility rounding helper.
 */
function roundTo(val: number, decimals: number): number {
  if (isNaN(val) || !isFinite(val)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

/**
 * Resolves player ownership count from explicit count or selected_by_percent.
 */
export function resolveOwnershipCount(
  player: any,
  totalManagers: number = 10_000_000
): number {
  if (!player || typeof player !== "object") return 0;

  if (typeof player.ownership_count === "number" && !isNaN(player.ownership_count) && player.ownership_count >= 0) {
    return Math.round(player.ownership_count);
  }

  const selectedByStr = player.selected_by_percent;
  if (selectedByStr !== undefined && selectedByStr !== null) {
    const parsedPercent = parseFloat(String(selectedByStr));
    if (!isNaN(parsedPercent) && parsedPercent >= 0) {
      return Math.round((parsedPercent / 100.0) * totalManagers);
    }
  }

  return 0;
}

/**
 * Calculates net transfer momentum:
 * - net_event_transfers = transfers_in_event - transfers_out_event
 * - net_transfer_velocity = net_event_transfers / max(ownership_count, 1000)
 */
export function calculateTransferMomentum(
  player: any,
  totalManagers: number = 10_000_000
): {
  net_event_transfers: number;
  net_transfer_velocity: number;
  ownership_count: number;
  transfers_in_event: number;
  transfers_out_event: number;
} {
  const transfersIn =
    typeof player?.transfers_in_event === "number" && !isNaN(player.transfers_in_event)
      ? player.transfers_in_event
      : parseInt(String(player?.transfers_in_event || "0"), 10) || 0;

  const transfersOut =
    typeof player?.transfers_out_event === "number" && !isNaN(player.transfers_out_event)
      ? player.transfers_out_event
      : parseInt(String(player?.transfers_out_event || "0"), 10) || 0;

  const netEventTransfers = transfersIn - transfersOut;
  const ownershipCount = resolveOwnershipCount(player, totalManagers);

  const effectiveOwnershipFloor = Math.max(ownershipCount, 1000);
  const netTransferVelocity = roundTo(netEventTransfers / effectiveOwnershipFloor, 6);

  return {
    net_event_transfers: netEventTransfers,
    net_transfer_velocity: netTransferVelocity,
    ownership_count: ownershipCount,
    transfers_in_event: transfersIn,
    transfers_out_event: transfersOut,
  };
}

/**
 * Computes the dynamic thresholds for price rise and price fall.
 */
export function calculateDynamicThresholds(
  player: any,
  ownershipCount: number,
  config: PricePredictorConfig = {}
): { riseThreshold: number; fallThreshold: number } {
  const totalManagers = config.totalManagers ?? 10_000_000;

  // If explicit thresholds provided on player or config
  if (typeof player?.rise_threshold === "number" && player.rise_threshold > 0) {
    const fallThresh =
      typeof player?.fall_threshold === "number" && player.fall_threshold > 0
        ? player.fall_threshold
        : player.rise_threshold;
    return { riseThreshold: player.rise_threshold, fallThreshold: fallThresh };
  }

  if (config.customThresholdModel) {
    return config.customThresholdModel(player, ownershipCount, totalManagers);
  }

  const minRise = config.minRiseTransfers ?? 15_000;
  const minFall = config.minFallTransfers ?? 15_000;
  const riseVelTarget = config.riseVelocityTarget ?? 0.05;
  const fallVelTarget = config.fallVelocityTarget ?? 0.05;

  const riseThreshold = Math.max(minRise, Math.round(ownershipCount * riseVelTarget));
  const fallThreshold = Math.max(minFall, Math.round(ownershipCount * fallVelTarget));

  return { riseThreshold, fallThreshold };
}

/**
 * Classifies momentum state based on Price Target Index:
 * - LIKELY_RISE_TONIGHT: Target >= 100%
 * - RISK_OF_RISE: Target >= 80% and < 100%
 * - LIKELY_FALL_TONIGHT: Target <= -100%
 * - RISK_OF_FALL: Target <= -80% and > -100%
 * - NEUTRAL: -80% < Target < 80%
 */
export function classifyMomentumState(targetPercentage: number): PriceMomentumState {
  if (targetPercentage >= 100) {
    return "LIKELY_RISE_TONIGHT";
  }
  if (targetPercentage >= 80) {
    return "RISK_OF_RISE";
  }
  if (targetPercentage <= -100) {
    return "LIKELY_FALL_TONIGHT";
  }
  if (targetPercentage <= -80) {
    return "RISK_OF_FALL";
  }
  return "NEUTRAL";
}

/**
 * Maps momentum state to estimated directional movement.
 */
export function classifyChangeDirection(
  state: PriceMomentumState
): EstimatedPriceChangeDirection {
  switch (state) {
    case "LIKELY_RISE_TONIGHT":
    case "RISK_OF_RISE":
      return "RISE";
    case "LIKELY_FALL_TONIGHT":
    case "RISK_OF_FALL":
      return "FALL";
    case "NEUTRAL":
    default:
      return "STABLE";
  }
}

/**
 * Predicts price change momentum for an individual player.
 */
export function predictPlayerPriceChange(
  player: any,
  config: PricePredictorConfig = {}
): PlayerPricePrediction {
  const totalManagers = config.totalManagers ?? 10_000_000;
  const playerId = typeof player?.id === "number" ? player.id : parseInt(String(player?.id || "0"), 10) || 0;
  const nowCost = typeof player?.now_cost === "number" ? player.now_cost : 50;
  const webName = player?.web_name || undefined;

  const momentum = calculateTransferMomentum(player, totalManagers);
  const { riseThreshold, fallThreshold } = calculateDynamicThresholds(
    player,
    momentum.ownership_count,
    config
  );

  let targetPercentage = 0;
  if (momentum.net_event_transfers > 0) {
    targetPercentage = roundTo((momentum.net_event_transfers / Math.max(1, riseThreshold)) * 100, 2);
  } else if (momentum.net_event_transfers < 0) {
    // Negative net transfers relative to fall threshold
    targetPercentage = roundTo((momentum.net_event_transfers / Math.max(1, fallThreshold)) * 100, 2);
  }

  const momentumState = classifyMomentumState(targetPercentage);
  const changeDirection = classifyChangeDirection(momentumState);

  return {
    player_id: playerId,
    web_name: webName,
    now_cost: nowCost,
    price_target_percentage: targetPercentage,
    momentum_state: momentumState,
    estimated_change_direction: changeDirection,
    net_event_transfers: momentum.net_event_transfers,
    net_transfer_velocity: momentum.net_transfer_velocity,
    ownership_count: momentum.ownership_count,
    transfers_in_event: momentum.transfers_in_event,
    transfers_out_event: momentum.transfers_out_event,
    rise_threshold: riseThreshold,
    fall_threshold: fallThreshold,
    version: PRICE_PREDICTOR_VERSION,
  };
}

/**
 * Predicts price change momentum across a squad or list of players.
 */
export function predictSquadPriceChanges(
  players: any[],
  config: PricePredictorConfig = {}
): PlayerPricePrediction[] {
  if (!Array.isArray(players)) return [];
  return players.map((p) => predictPlayerPriceChange(p, config));
}

/**
 * Filters market movers into active risk and action categories.
 */
export function filterMarketMovers(predictions: PlayerPricePrediction[]): {
  likely_risers: PlayerPricePrediction[];
  risers_at_risk: PlayerPricePrediction[];
  likely_fallers: PlayerPricePrediction[];
  fallers_at_risk: PlayerPricePrediction[];
  neutral: PlayerPricePrediction[];
} {
  const result = {
    likely_risers: [] as PlayerPricePrediction[],
    risers_at_risk: [] as PlayerPricePrediction[],
    likely_fallers: [] as PlayerPricePrediction[],
    fallers_at_risk: [] as PlayerPricePrediction[],
    neutral: [] as PlayerPricePrediction[],
  };

  for (const pred of predictions) {
    switch (pred.momentum_state) {
      case "LIKELY_RISE_TONIGHT":
        result.likely_risers.push(pred);
        break;
      case "RISK_OF_RISE":
        result.risers_at_risk.push(pred);
        break;
      case "LIKELY_FALL_TONIGHT":
        result.likely_fallers.push(pred);
        break;
      case "RISK_OF_FALL":
        result.fallers_at_risk.push(pred);
        break;
      case "NEUTRAL":
      default:
        result.neutral.push(pred);
        break;
    }
  }

  return result;
}

/**
 * Evaluates the market urgency of a recommended transfer move.
 */
export function assessTransferUrgency(
  options: AssessTransferUrgencyOptions
): UrgencyAssessment {
  const { transfersIn, transfersOut, bankAfter, allPlayerMetaMap, config } = options;

  if ((!transfersIn || transfersIn.length === 0) && (!transfersOut || transfersOut.length === 0)) {
    return {
      urgency_level: "NONE",
      urgency_reason: "No transfers recommended; squad is in HOLD posture.",
      budget_impact_if_delayed: false,
      incoming_player_predictions: [],
      outgoing_player_predictions: [],
    };
  }

  function resolvePlayerObj(item: any): any {
    if (!item) return item;
    if (typeof item === "number") {
      return allPlayerMetaMap?.get(item) || { id: item, web_name: `Player ${item}` };
    }
    if (typeof item === "object") {
      const pid = item.id || item.element;
      if (allPlayerMetaMap && pid && allPlayerMetaMap.has(pid)) {
        return { ...allPlayerMetaMap.get(pid), ...item };
      }
      return item;
    }
    return item;
  }

  const inPredictions = (transfersIn || []).map((p) =>
    predictPlayerPriceChange(resolvePlayerObj(p), config)
  );
  const outPredictions = (transfersOut || []).map((p) =>
    predictPlayerPriceChange(resolvePlayerObj(p), config)
  );

  // A £0.1m rise breaks the bank if bank remaining is £0.0m or less than £0.1m.
  // Note: bankAfter may be formatted as decimal £m (0.0) or integer tenths (0).
  const wouldRiseBreakBank = bankAfter <= 0 || (bankAfter > 0 && bankAfter < 0.1);

  // 1. Check CRITICAL: Any incoming player rising tonight when bank is exhausted
  const criticalIncoming = inPredictions.find((p) => p.momentum_state === "LIKELY_RISE_TONIGHT");
  if (criticalIncoming && wouldRiseBreakBank) {
    const pName = criticalIncoming.web_name || `Player ${criticalIncoming.player_id}`;
    return {
      urgency_level: "CRITICAL",
      urgency_reason: `Incoming target player ${pName} has ${criticalIncoming.price_target_percentage}% rise momentum tonight; execute before deadline/price change to preserve bank.`,
      budget_impact_if_delayed: true,
      incoming_player_predictions: inPredictions,
      outgoing_player_predictions: outPredictions,
    };
  }

  // 2. Check HIGH: Incoming rising tonight (with bank buffer) OR Outgoing falling tonight
  if (criticalIncoming) {
    const pName = criticalIncoming.web_name || `Player ${criticalIncoming.player_id}`;
    return {
      urgency_level: "HIGH",
      urgency_reason: `Incoming target player ${pName} has ${criticalIncoming.price_target_percentage}% rise momentum tonight; execute before price rise to save £0.1m.`,
      budget_impact_if_delayed: false,
      incoming_player_predictions: inPredictions,
      outgoing_player_predictions: outPredictions,
    };
  }

  const highOutgoing = outPredictions.find((p) => p.momentum_state === "LIKELY_FALL_TONIGHT");
  if (highOutgoing) {
    const pName = highOutgoing.web_name || `Player ${highOutgoing.player_id}`;
    return {
      urgency_level: "HIGH",
      urgency_reason: `Outgoing player ${pName} is at ${highOutgoing.price_target_percentage}% fall momentum; sell tonight to avoid £0.1m value loss.`,
      budget_impact_if_delayed: false,
      incoming_player_predictions: inPredictions,
      outgoing_player_predictions: outPredictions,
    };
  }

  // 3. Check MEDIUM: Incoming risk of rise OR Outgoing risk of fall
  const mediumIncoming = inPredictions.find((p) => p.momentum_state === "RISK_OF_RISE");
  if (mediumIncoming) {
    const pName = mediumIncoming.web_name || `Player ${mediumIncoming.player_id}`;
    return {
      urgency_level: "MEDIUM",
      urgency_reason: `Incoming target player ${pName} is at ${mediumIncoming.price_target_percentage}% rise risk; monitor market before deadline.`,
      budget_impact_if_delayed: false,
      incoming_player_predictions: inPredictions,
      outgoing_player_predictions: outPredictions,
    };
  }

  const mediumOutgoing = outPredictions.find((p) => p.momentum_state === "RISK_OF_FALL");
  if (mediumOutgoing) {
    const pName = mediumOutgoing.web_name || `Player ${mediumOutgoing.player_id}`;
    return {
      urgency_level: "MEDIUM",
      urgency_reason: `Outgoing player ${pName} is at ${mediumOutgoing.price_target_percentage}% fall risk; monitor market before deadline.`,
      budget_impact_if_delayed: false,
      incoming_player_predictions: inPredictions,
      outgoing_player_predictions: outPredictions,
    };
  }

  // 4. Default NONE: Neutral momentum
  return {
    urgency_level: "NONE",
    urgency_reason: "No immediate price rise or fall pressure detected for recommended squad movements.",
    budget_impact_if_delayed: false,
    incoming_player_predictions: inPredictions,
    outgoing_player_predictions: outPredictions,
  };
}
