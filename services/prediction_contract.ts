export const PREDICTION_CONTRACT_VERSION = "prediction-contract.v1";
export const LEGACY_RANK_SCORE_SOURCE = "legacy_rating_engine";
export const EXPECTED_POINTS_UNAVAILABLE_REASON =
  "The V2 expected-points model has not been implemented.";

export enum DataValidity {
  OBSERVED = "observed",
  OBSERVED_ZERO = "observed_zero",
  DERIVED = "derived",
  MISSING = "missing",
  INVALID = "invalid",
  NOT_APPLICABLE = "not_applicable",
}

const NULL_VALIDITIES = new Set([
  DataValidity.MISSING,
  DataValidity.INVALID,
  DataValidity.NOT_APPLICABLE,
]);

export interface DataValueDict {
  value: any;
  validity: string;
  source: string | null;
  as_of_gameweek: number | null;
  reason: string | null;
}

export class DataValue {
  value: any;
  validity: DataValidity;
  source: string | null;
  as_of_gameweek: number | null;
  reason: string | null;

  constructor(options: {
    value: any;
    validity: DataValidity;
    source?: string | null;
    as_of_gameweek?: number | null;
    reason?: string | null;
  }) {
    this.value = options.value;
    this.validity = options.validity;
    this.source = options.source ?? null;
    this.as_of_gameweek = options.as_of_gameweek ?? null;
    this.reason = options.reason ?? null;

    if (!Object.values(DataValidity).includes(this.validity)) {
      throw new Error("validity must be a DataValidity value");
    }
    if (NULL_VALIDITIES.has(this.validity) && this.value !== null && this.value !== undefined) {
      throw new Error(`${this.validity} values must use value=null`);
    }
    if (this.validity === DataValidity.OBSERVED_ZERO) {
      if (this.value !== 0) {
        throw new Error("observed_zero values must contain a numeric zero");
      }
    }
    if (this.validity === DataValidity.OBSERVED && this.value === 0) {
      throw new Error("Use observed_zero instead of observed for a numeric zero");
    }
    if (
      this.as_of_gameweek !== null &&
      (!Number.isInteger(this.as_of_gameweek) || this.as_of_gameweek < 0)
    ) {
      throw new Error("as_of_gameweek must be a non-negative integer");
    }
  }

  toDict(): DataValueDict {
    return {
      value: this.value ?? null,
      validity: this.validity,
      source: this.source,
      as_of_gameweek: this.as_of_gameweek,
      reason: this.reason,
    };
  }
}

export interface PredictionRangeDict {
  lower: number | null;
  upper: number | null;
  validity: string;
  reason: string | null;
}

export class PredictionRange {
  lower: number | null;
  upper: number | null;
  validity: DataValidity;
  reason: string | null;

  constructor(options: {
    lower: number | null;
    upper: number | null;
    validity: DataValidity;
    reason?: string | null;
  }) {
    this.lower = options.lower;
    this.upper = options.upper;
    this.validity = options.validity;
    this.reason = options.reason ?? null;

    if (!Object.values(DataValidity).includes(this.validity)) {
      throw new Error("validity must be a DataValidity value");
    }
    if (NULL_VALIDITIES.has(this.validity)) {
      if (this.lower !== null || this.upper !== null) {
        throw new Error(`${this.validity} ranges must have null bounds`);
      }
    } else if (this.lower === null || this.upper === null) {
      throw new Error("available ranges require both bounds");
    } else if (this.lower > this.upper) {
      throw new Error("prediction range lower bound exceeds upper bound");
    }
  }

  toDict(): PredictionRangeDict {
    return {
      lower: this.lower,
      upper: this.upper,
      validity: this.validity,
      reason: this.reason,
    };
  }
}

export class GameweekBoundary {
  last_finished_gameweek: number | null;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  in_progress_gameweek: number | null;

  constructor(options: {
    last_finished_gameweek: number | null;
    prediction_gameweek: number | null;
    historical_cutoff_gameweek: number | null;
    in_progress_gameweek: number | null;
  }) {
    this.last_finished_gameweek = options.last_finished_gameweek;
    this.prediction_gameweek = options.prediction_gameweek;
    this.historical_cutoff_gameweek = options.historical_cutoff_gameweek;
    this.in_progress_gameweek = options.in_progress_gameweek;

    const values = {
      last_finished_gameweek: this.last_finished_gameweek,
      prediction_gameweek: this.prediction_gameweek,
      historical_cutoff_gameweek: this.historical_cutoff_gameweek,
      in_progress_gameweek: this.in_progress_gameweek,
    };

    for (const [name, value] of Object.entries(values)) {
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        throw new Error(`${name} must be a positive integer or null`);
      }
    }

    if (
      this.last_finished_gameweek !== null &&
      this.historical_cutoff_gameweek !== this.last_finished_gameweek
    ) {
      throw new Error(
        "historical_cutoff_gameweek must equal last_finished_gameweek"
      );
    }

    if (
      this.last_finished_gameweek !== null &&
      this.prediction_gameweek !== null &&
      this.prediction_gameweek <= this.last_finished_gameweek
    ) {
      throw new Error(
        "prediction_gameweek must be after the last finished Gameweek"
      );
    }
  }

  toDict() {
    return {
      last_finished_gameweek: this.last_finished_gameweek,
      prediction_gameweek: this.prediction_gameweek,
      historical_cutoff_gameweek: this.historical_cutoff_gameweek,
      in_progress_gameweek: this.in_progress_gameweek,
    };
  }
}

export class PredictionSnapshot {
  snapshot_id: string;
  snapshot_created_at: string;
  boundary: GameweekBoundary;

  constructor(options: {
    snapshot_id: string;
    boundary: GameweekBoundary;
    snapshot_created_at?: string;
  }) {
    this.snapshot_id = options.snapshot_id;
    this.boundary = options.boundary;
    this.snapshot_created_at =
      options.snapshot_created_at || new Date().toISOString();

    if (!this.snapshot_id.trim()) {
      throw new Error("snapshot_id must not be empty");
    }
  }

  toDict() {
    return {
      snapshot_id: this.snapshot_id,
      snapshot_created_at: this.snapshot_created_at,
      ...this.boundary.toDict(),
    };
  }
}

export class PredictionOutput {
  player_id: number;
  snapshot_id: string;
  last_finished_gameweek: number | null;
  prediction_gameweek: number | null;
  historical_cutoff_gameweek: number | null;
  expected_points_next_gameweek: DataValue;
  expert_rank_score: DataValue;
  expected_minutes: DataValue;
  probability_available: DataValue;
  probability_appearance: DataValue;
  probability_start: DataValue;
  probability_60_plus_minutes: DataValue;
  prediction_confidence: DataValue;
  prediction_range: PredictionRange;

  constructor(options: {
    player_id: number;
    snapshot_id: string;
    last_finished_gameweek: number | null;
    prediction_gameweek: number | null;
    historical_cutoff_gameweek: number | null;
    expected_points_next_gameweek: DataValue;
    expert_rank_score: DataValue;
    expected_minutes: DataValue;
    probability_available: DataValue;
    probability_appearance: DataValue;
    probability_start: DataValue;
    probability_60_plus_minutes: DataValue;
    prediction_confidence: DataValue;
    prediction_range: PredictionRange;
  }) {
    this.player_id = options.player_id;
    this.snapshot_id = options.snapshot_id;
    this.last_finished_gameweek = options.last_finished_gameweek;
    this.prediction_gameweek = options.prediction_gameweek;
    this.historical_cutoff_gameweek = options.historical_cutoff_gameweek;
    this.expected_points_next_gameweek = options.expected_points_next_gameweek;
    this.expert_rank_score = options.expert_rank_score;
    this.expected_minutes = options.expected_minutes;
    this.probability_available = options.probability_available;
    this.probability_appearance = options.probability_appearance;
    this.probability_start = options.probability_start;
    this.probability_60_plus_minutes = options.probability_60_plus_minutes;
    this.prediction_confidence = options.prediction_confidence;
    this.prediction_range = options.prediction_range;

    if (!Number.isInteger(this.player_id) || this.player_id <= 0) {
      throw new Error("player_id must be a positive integer");
    }
    if (!this.snapshot_id.trim()) {
      throw new Error("snapshot_id must not be empty");
    }
  }

  toDict(): Record<string, any> {
    return {
      schema_version: PREDICTION_CONTRACT_VERSION,
      player_id: this.player_id,
      snapshot_id: this.snapshot_id,
      last_finished_gameweek: this.last_finished_gameweek,
      prediction_gameweek: this.prediction_gameweek,
      historical_cutoff_gameweek: this.historical_cutoff_gameweek,
      expected_points_next_gameweek: this.expected_points_next_gameweek.toDict(),
      expert_rank_score: this.expert_rank_score.toDict(),
      expected_minutes: this.expected_minutes.toDict(),
      probability_available: this.probability_available.toDict(),
      probability_appearance: this.probability_appearance.toDict(),
      probability_start: this.probability_start.toDict(),
      probability_60_plus_minutes: this.probability_60_plus_minutes.toDict(),
      prediction_confidence: this.prediction_confidence.toDict(),
      prediction_range: this.prediction_range.toDict(),
    };
  }
}

export function determineGameweekBoundary(
  events: Array<Record<string, any>>
): GameweekBoundary {
  const normalizedEvents = events
    .filter((e) => typeof e?.id === "number" && e.id > 0)
    .sort((a, b) => a.id - b.id);

  const finishedIds = normalizedEvents
    .filter((e) => e.finished === true)
    .map((e) => e.id as number);
  const lastFinished = finishedIds.length > 0 ? Math.max(...finishedIds) : null;

  const inProgressIds = normalizedEvents
    .filter((e) => e.is_current === true && e.finished !== true)
    .map((e) => e.id as number);
  const inProgress = inProgressIds.length > 0 ? Math.min(...inProgressIds) : null;

  let predictionCandidates: number[];
  if (inProgress !== null) {
    predictionCandidates = normalizedEvents
      .filter((e) => e.id > inProgress && e.finished !== true)
      .map((e) => e.id as number);
  } else {
    predictionCandidates = normalizedEvents
      .filter(
        (e) =>
          e.finished !== true &&
          (lastFinished === null || e.id > lastFinished)
      )
      .map((e) => e.id as number);
  }

  const predictionGameweek =
    predictionCandidates.length > 0 ? Math.min(...predictionCandidates) : null;

  return new GameweekBoundary({
    last_finished_gameweek: lastFinished,
    prediction_gameweek: predictionGameweek,
    historical_cutoff_gameweek: lastFinished,
    in_progress_gameweek: inProgress,
  });
}

export function historicalEvents(
  events: Array<Record<string, any>>,
  boundary: GameweekBoundary
): Array<Record<string, any>> {
  const cutoff = boundary.historical_cutoff_gameweek;
  if (cutoff === null) {
    return [];
  }
  return events.filter(
    (e) => typeof e?.id === "number" && e.id <= cutoff && e.finished === true
  );
}

export function makePredictionSnapshot(
  snapshotId: string,
  events: Array<Record<string, any>>
): PredictionSnapshot {
  return new PredictionSnapshot({
    snapshot_id: snapshotId,
    boundary: determineGameweekBoundary(events),
  });
}

export function makeUnavailablePredictionOutput(options: {
  player_id: number;
  snapshot: PredictionSnapshot;
  expert_rank_score?: number | null;
}): PredictionOutput {
  const { player_id, snapshot, expert_rank_score = null } = options;

  const unavailable = new DataValue({
    value: null,
    validity: DataValidity.MISSING,
    source: "prediction_engine_v2",
    as_of_gameweek: snapshot.boundary.historical_cutoff_gameweek,
    reason: EXPECTED_POINTS_UNAVAILABLE_REASON,
  });

  const legacyScore = new DataValue({
    value: expert_rank_score,
    validity:
      expert_rank_score !== null && expert_rank_score !== undefined
        ? DataValidity.DERIVED
        : DataValidity.MISSING,
    source: LEGACY_RANK_SCORE_SOURCE,
    as_of_gameweek: snapshot.boundary.historical_cutoff_gameweek,
    reason:
      expert_rank_score !== null && expert_rank_score !== undefined
        ? "Legacy relative ranking score; not expected FPL points."
        : "Legacy ranking score was not supplied.",
  });

  return new PredictionOutput({
    player_id,
    snapshot_id: snapshot.snapshot_id,
    last_finished_gameweek: snapshot.boundary.last_finished_gameweek,
    prediction_gameweek: snapshot.boundary.prediction_gameweek,
    historical_cutoff_gameweek: snapshot.boundary.historical_cutoff_gameweek,
    expected_points_next_gameweek: unavailable,
    expert_rank_score: legacyScore,
    expected_minutes: unavailable,
    probability_available: unavailable,
    probability_appearance: unavailable,
    probability_start: unavailable,
    probability_60_plus_minutes: unavailable,
    prediction_confidence: unavailable,
    prediction_range: new PredictionRange({
      lower: null,
      upper: null,
      validity: DataValidity.MISSING,
      reason: EXPECTED_POINTS_UNAVAILABLE_REASON,
    }),
  });
}

const VALUE_FIELDS = [
  "expected_points_next_gameweek",
  "expert_rank_score",
  "expected_minutes",
  "probability_available",
  "probability_appearance",
  "probability_start",
  "probability_60_plus_minutes",
  "prediction_confidence",
];

const REQUIRED_FIELDS = [
  "schema_version",
  "player_id",
  "snapshot_id",
  "last_finished_gameweek",
  "prediction_gameweek",
  "historical_cutoff_gameweek",
  ...VALUE_FIELDS,
  "prediction_range",
];

export function validatePredictionPayload(payload: Record<string, any>): void {
  const missing = REQUIRED_FIELDS.filter((f) => !(f in payload));
  if (missing.length > 0) {
    throw new Error(`Prediction payload is missing fields: ${missing.join(", ")}`);
  }
  if (payload.schema_version !== PREDICTION_CONTRACT_VERSION) {
    throw new Error("Unsupported prediction contract version");
  }
  if (typeof payload.player_id !== "number" || payload.player_id <= 0) {
    throw new Error("Prediction payload player_id is invalid");
  }
  if (typeof payload.snapshot_id !== "string" || !payload.snapshot_id.trim()) {
    throw new Error("Prediction payload snapshot_id is invalid");
  }

  for (const field of VALUE_FIELDS) {
    const envelope = payload[field];
    if (!envelope || typeof envelope !== "object") {
      throw new Error(`${field} must be a value envelope`);
    }
    const validity = envelope.validity as DataValidity;
    if (!Object.values(DataValidity).includes(validity)) {
      throw new Error(`${field} has invalid validity`);
    }
    const val = envelope.value;
    if (NULL_VALIDITIES.has(validity) && val !== null && val !== undefined) {
      throw new Error(`${field} has a non-null value for ${validity}`);
    }
    if (validity === DataValidity.OBSERVED_ZERO && val !== 0) {
      throw new Error(`${field} observed_zero value is not zero`);
    }
  }

  const predictionRange = payload.prediction_range;
  if (!predictionRange || typeof predictionRange !== "object") {
    throw new Error("prediction_range must be an object");
  }
  const rangeValidity = predictionRange.validity as DataValidity;
  if (!Object.values(DataValidity).includes(rangeValidity)) {
    throw new Error("prediction_range has invalid validity");
  }
  const lower = predictionRange.lower;
  const upper = predictionRange.upper;
  if (NULL_VALIDITIES.has(rangeValidity)) {
    if (lower !== null && lower !== undefined || upper !== null && upper !== undefined) {
      throw new Error("unavailable prediction ranges must have null bounds");
    }
  } else if (lower === null || upper === null || lower > upper) {
    throw new Error("prediction_range bounds are invalid");
  }
}
