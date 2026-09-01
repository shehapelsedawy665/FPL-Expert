"""Phase 0 contract types for future Gameweek prediction work.

This module deliberately does not calculate expected points or alter the
legacy Expert Score. It defines the shared time boundary, validity states, and
serialization shape that later prediction phases will consume.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


PREDICTION_CONTRACT_VERSION = "prediction-contract.v1"
LEGACY_RANK_SCORE_SOURCE = "legacy_rating_engine"
EXPECTED_POINTS_UNAVAILABLE_REASON = (
    "The V2 expected-points model has not been implemented."
)


class DataValidity(str, Enum):
    """Explicit state for a value in the prediction data contract."""

    OBSERVED = "observed"
    OBSERVED_ZERO = "observed_zero"
    DERIVED = "derived"
    MISSING = "missing"
    INVALID = "invalid"
    NOT_APPLICABLE = "not_applicable"


_NULL_VALIDITIES = {
    DataValidity.MISSING,
    DataValidity.INVALID,
    DataValidity.NOT_APPLICABLE,
}


@dataclass(frozen=True)
class DataValue:
    """A value with explicit provenance and validity semantics."""

    value: Any
    validity: DataValidity
    source: str | None = None
    as_of_gameweek: int | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.validity, DataValidity):
            raise ValueError("validity must be a DataValidity value")
        if self.validity in _NULL_VALIDITIES and self.value is not None:
            raise ValueError(
                f"{self.validity.value} values must use value=None"
            )
        if self.validity == DataValidity.OBSERVED_ZERO:
            if self.value is None or self.value != 0:
                raise ValueError(
                    "observed_zero values must contain a numeric zero"
                )
        if self.validity == DataValidity.OBSERVED and self.value == 0:
            raise ValueError(
                "Use observed_zero instead of observed for a numeric zero"
            )
        if self.as_of_gameweek is not None and (
            not isinstance(self.as_of_gameweek, int)
            or self.as_of_gameweek < 0
        ):
            raise ValueError("as_of_gameweek must be a non-negative integer")

    def to_dict(self) -> dict[str, Any]:
        return {
            "value": self.value,
            "validity": self.validity.value,
            "source": self.source,
            "as_of_gameweek": self.as_of_gameweek,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class PredictionRange:
    """A future prediction interval, unavailable until a model exists."""

    lower: float | None
    upper: float | None
    validity: DataValidity
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.validity, DataValidity):
            raise ValueError("validity must be a DataValidity value")
        if self.validity in _NULL_VALIDITIES:
            if self.lower is not None or self.upper is not None:
                raise ValueError(
                    f"{self.validity.value} ranges must have null bounds"
                )
        elif self.lower is None or self.upper is None:
            raise ValueError("available ranges require both bounds")
        elif self.lower > self.upper:
            raise ValueError("prediction range lower bound exceeds upper bound")

    def to_dict(self) -> dict[str, Any]:
        return {
            "lower": self.lower,
            "upper": self.upper,
            "validity": self.validity.value,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class GameweekBoundary:
    """The historical cutoff and next Gameweek to predict."""

    last_finished_gameweek: int | None
    prediction_gameweek: int | None
    historical_cutoff_gameweek: int | None
    in_progress_gameweek: int | None

    def __post_init__(self) -> None:
        values = {
            "last_finished_gameweek": self.last_finished_gameweek,
            "prediction_gameweek": self.prediction_gameweek,
            "historical_cutoff_gameweek": self.historical_cutoff_gameweek,
            "in_progress_gameweek": self.in_progress_gameweek,
        }
        for name, value in values.items():
            if value is not None and (
                not isinstance(value, int) or value <= 0
            ):
                raise ValueError(f"{name} must be a positive integer or None")
        if (
            self.last_finished_gameweek is not None
            and self.historical_cutoff_gameweek
            != self.last_finished_gameweek
        ):
            raise ValueError(
                "historical_cutoff_gameweek must equal "
                "last_finished_gameweek"
            )
        if (
            self.last_finished_gameweek is not None
            and self.prediction_gameweek is not None
            and self.prediction_gameweek <= self.last_finished_gameweek
        ):
            raise ValueError(
                "prediction_gameweek must be after the last finished "
                "Gameweek"
            )

    def to_dict(self) -> dict[str, int | None]:
        return {
            "last_finished_gameweek": self.last_finished_gameweek,
            "prediction_gameweek": self.prediction_gameweek,
            "historical_cutoff_gameweek": self.historical_cutoff_gameweek,
            "in_progress_gameweek": self.in_progress_gameweek,
        }


@dataclass(frozen=True)
class PredictionSnapshot:
    """Stable identity and time boundary shared by prediction consumers."""

    snapshot_id: str
    boundary: GameweekBoundary

    def __post_init__(self) -> None:
        if not self.snapshot_id.strip():
            raise ValueError("snapshot_id must not be empty")

    def to_dict(self) -> dict[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            **self.boundary.to_dict(),
        }


@dataclass(frozen=True)
class PredictionOutput:
    """Future prediction shape, with unavailable V2 values represented safely."""

    player_id: int
    snapshot_id: str
    last_finished_gameweek: int | None
    prediction_gameweek: int | None
    historical_cutoff_gameweek: int | None
    expected_points_next_gameweek: DataValue
    expert_rank_score: DataValue
    expected_minutes: DataValue
    probability_available: DataValue
    probability_appearance: DataValue
    probability_start: DataValue
    probability_60_plus_minutes: DataValue
    prediction_confidence: DataValue
    prediction_range: PredictionRange

    def __post_init__(self) -> None:
        if not isinstance(self.player_id, int) or self.player_id <= 0:
            raise ValueError("player_id must be a positive integer")
        if not self.snapshot_id.strip():
            raise ValueError("snapshot_id must not be empty")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": PREDICTION_CONTRACT_VERSION,
            "player_id": self.player_id,
            "snapshot_id": self.snapshot_id,
            "last_finished_gameweek": self.last_finished_gameweek,
            "prediction_gameweek": self.prediction_gameweek,
            "historical_cutoff_gameweek": self.historical_cutoff_gameweek,
            "expected_points_next_gameweek": (
                self.expected_points_next_gameweek.to_dict()
            ),
            "expert_rank_score": self.expert_rank_score.to_dict(),
            "expected_minutes": self.expected_minutes.to_dict(),
            "probability_available": self.probability_available.to_dict(),
            "probability_appearance": self.probability_appearance.to_dict(),
            "probability_start": self.probability_start.to_dict(),
            "probability_60_plus_minutes": (
                self.probability_60_plus_minutes.to_dict()
            ),
            "prediction_confidence": self.prediction_confidence.to_dict(),
            "prediction_range": self.prediction_range.to_dict(),
        }


def determine_gameweek_boundary(
    events: list[Mapping[str, Any]],
) -> GameweekBoundary:
    """Determine completed history and the next forecast Gameweek.

    If the current Gameweek is in progress, it is recorded separately and
    excluded from the prediction target. The target becomes the next
    unfinished Gameweek after it.
    """

    normalized_events = [
        event
        for event in events
        if isinstance(event.get("id"), int) and event["id"] > 0
    ]
    normalized_events.sort(key=lambda event: event["id"])

    finished_ids = [
        event["id"]
        for event in normalized_events
        if event.get("finished") is True
    ]
    last_finished = max(finished_ids) if finished_ids else None

    in_progress_ids = [
        event["id"]
        for event in normalized_events
        if event.get("is_current") is True
        and event.get("finished") is not True
    ]
    in_progress = min(in_progress_ids) if in_progress_ids else None

    if in_progress is not None:
        prediction_candidates = [
            event["id"]
            for event in normalized_events
            if event["id"] > in_progress
            and event.get("finished") is not True
        ]
    else:
        prediction_candidates = [
            event["id"]
            for event in normalized_events
            if event.get("finished") is not True
            and (
                last_finished is None
                or event["id"] > last_finished
            )
        ]

    prediction_gameweek = (
        min(prediction_candidates) if prediction_candidates else None
    )
    return GameweekBoundary(
        last_finished_gameweek=last_finished,
        prediction_gameweek=prediction_gameweek,
        historical_cutoff_gameweek=last_finished,
        in_progress_gameweek=in_progress,
    )


def historical_events(
    events: list[Mapping[str, Any]],
    boundary: GameweekBoundary,
) -> list[dict[str, Any]]:
    """Return only completed events at or before the historical cutoff."""

    cutoff = boundary.historical_cutoff_gameweek
    if cutoff is None:
        return []
    return [
        dict(event)
        for event in events
        if isinstance(event.get("id"), int)
        and event["id"] <= cutoff
        and event.get("finished") is True
    ]


def make_prediction_snapshot(
    snapshot_id: str,
    events: list[Mapping[str, Any]],
) -> PredictionSnapshot:
    return PredictionSnapshot(
        snapshot_id=snapshot_id,
        boundary=determine_gameweek_boundary(events),
    )


def make_unavailable_prediction_output(
    *,
    player_id: int,
    snapshot: PredictionSnapshot,
    expert_rank_score: float | None = None,
) -> PredictionOutput:
    """Create the Phase 0 shape without fabricating V2 predictions."""

    unavailable = DataValue(
        value=None,
        validity=DataValidity.MISSING,
        source="prediction_engine_v2",
        as_of_gameweek=snapshot.boundary.historical_cutoff_gameweek,
        reason=EXPECTED_POINTS_UNAVAILABLE_REASON,
    )
    legacy_score = DataValue(
        value=expert_rank_score,
        validity=(
            DataValidity.DERIVED
            if expert_rank_score is not None
            else DataValidity.MISSING
        ),
        source=LEGACY_RANK_SCORE_SOURCE,
        as_of_gameweek=snapshot.boundary.historical_cutoff_gameweek,
        reason=(
            "Legacy relative ranking score; not expected FPL points."
            if expert_rank_score is not None
            else "Legacy ranking score was not supplied."
        ),
    )
    return PredictionOutput(
        player_id=player_id,
        snapshot_id=snapshot.snapshot_id,
        last_finished_gameweek=snapshot.boundary.last_finished_gameweek,
        prediction_gameweek=snapshot.boundary.prediction_gameweek,
        historical_cutoff_gameweek=(
            snapshot.boundary.historical_cutoff_gameweek
        ),
        expected_points_next_gameweek=unavailable,
        expert_rank_score=legacy_score,
        expected_minutes=unavailable,
        probability_available=unavailable,
        probability_appearance=unavailable,
        probability_start=unavailable,
        probability_60_plus_minutes=unavailable,
        prediction_confidence=unavailable,
        prediction_range=PredictionRange(
            lower=None,
            upper=None,
            validity=DataValidity.MISSING,
            reason=EXPECTED_POINTS_UNAVAILABLE_REASON,
        ),
    )


_VALUE_FIELDS = (
    "expected_points_next_gameweek",
    "expert_rank_score",
    "expected_minutes",
    "probability_available",
    "probability_appearance",
    "probability_start",
    "probability_60_plus_minutes",
    "prediction_confidence",
)
_REQUIRED_FIELDS = (
    "schema_version",
    "player_id",
    "snapshot_id",
    "last_finished_gameweek",
    "prediction_gameweek",
    "historical_cutoff_gameweek",
    *_VALUE_FIELDS,
    "prediction_range",
)


def validate_prediction_payload(payload: Mapping[str, Any]) -> None:
    """Validate the serialized contract shape without calculating predictions."""

    missing_fields = [
        field for field in _REQUIRED_FIELDS if field not in payload
    ]
    if missing_fields:
        raise ValueError(
            "Prediction payload is missing fields: "
            + ", ".join(missing_fields)
        )
    if payload["schema_version"] != PREDICTION_CONTRACT_VERSION:
        raise ValueError("Unsupported prediction contract version")
    if not isinstance(payload["player_id"], int) or payload["player_id"] <= 0:
        raise ValueError("Prediction payload player_id is invalid")
    if not isinstance(payload["snapshot_id"], str) or not payload[
        "snapshot_id"
    ].strip():
        raise ValueError("Prediction payload snapshot_id is invalid")

    for field in _VALUE_FIELDS:
        envelope = payload[field]
        if not isinstance(envelope, Mapping):
            raise ValueError(f"{field} must be a value envelope")
        try:
            validity = DataValidity(envelope["validity"])
        except (KeyError, ValueError) as error:
            raise ValueError(f"{field} has invalid validity") from error
        value = envelope.get("value")
        if validity in _NULL_VALIDITIES and value is not None:
            raise ValueError(
                f"{field} has a non-null value for {validity.value}"
            )
        if validity == DataValidity.OBSERVED_ZERO and value != 0:
            raise ValueError(f"{field} observed_zero value is not zero")

    prediction_range = payload["prediction_range"]
    if not isinstance(prediction_range, Mapping):
        raise ValueError("prediction_range must be an object")
    try:
        range_validity = DataValidity(prediction_range["validity"])
    except (KeyError, ValueError) as error:
        raise ValueError("prediction_range has invalid validity") from error
    lower = prediction_range.get("lower")
    upper = prediction_range.get("upper")
    if range_validity in _NULL_VALIDITIES:
        if lower is not None or upper is not None:
            raise ValueError(
                "unavailable prediction ranges must have null bounds"
            )
    elif lower is None or upper is None or lower > upper:
        raise ValueError("prediction_range bounds are invalid")