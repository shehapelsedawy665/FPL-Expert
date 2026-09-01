import json
import unittest
from pathlib import Path

from services.prediction_contract import (
    DataValidity,
    DataValue,
    EXPECTED_POINTS_UNAVAILABLE_REASON,
    historical_events,
    make_prediction_snapshot,
    make_unavailable_prediction_output,
    validate_prediction_payload,
)


FIXTURE_PATH = Path(__file__).with_name("prediction_snapshots.json")


def load_snapshots() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


class PredictionContractTests(unittest.TestCase):
    def test_serialized_schema_contains_future_prediction_fields(self):
        fixture = load_snapshots()["in_progress"]
        snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )
        payload = make_unavailable_prediction_output(
            player_id=101,
            snapshot=snapshot,
            expert_rank_score=61.9,
        ).to_dict()

        validate_prediction_payload(payload)
        self.assertEqual(payload["schema_version"], "prediction-contract.v1")
        self.assertEqual(payload["last_finished_gameweek"], 1)
        self.assertEqual(payload["prediction_gameweek"], 3)
        self.assertEqual(payload["historical_cutoff_gameweek"], 1)
        self.assertIn("expected_points_next_gameweek", payload)
        self.assertIn("expected_minutes", payload)
        self.assertIn("probability_available", payload)
        self.assertIn("probability_appearance", payload)
        self.assertIn("probability_start", payload)
        self.assertIn("probability_60_plus_minutes", payload)
        self.assertIn("prediction_confidence", payload)
        self.assertIn("prediction_range", payload)
        self.assertEqual(
            payload["expected_points_next_gameweek"]["validity"],
            DataValidity.MISSING.value,
        )
        self.assertEqual(
            payload["expected_points_next_gameweek"]["reason"],
            EXPECTED_POINTS_UNAVAILABLE_REASON,
        )
        self.assertEqual(
            payload["expert_rank_score"]["source"],
            "legacy_rating_engine",
        )
        self.assertIn(
            "not expected FPL points",
            payload["expert_rank_score"]["reason"],
        )

    def test_in_progress_gameweek_is_excluded_from_prediction_history(self):
        fixture = load_snapshots()["in_progress"]
        snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )

        self.assertEqual(snapshot.boundary.last_finished_gameweek, 1)
        self.assertEqual(snapshot.boundary.in_progress_gameweek, 2)
        self.assertEqual(snapshot.boundary.prediction_gameweek, 3)
        self.assertEqual(snapshot.boundary.historical_cutoff_gameweek, 1)

        historical = historical_events(
            fixture["events"], snapshot.boundary
        )
        self.assertEqual([event["id"] for event in historical], [1])

    def test_next_gameweek_is_selected_between_finished_gameweeks(self):
        fixture = load_snapshots()["between_gameweeks"]
        snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )

        self.assertEqual(snapshot.boundary.last_finished_gameweek, 1)
        self.assertIsNone(snapshot.boundary.in_progress_gameweek)
        self.assertEqual(snapshot.boundary.prediction_gameweek, 2)
        self.assertEqual(
            [event["id"] for event in historical_events(
                fixture["events"], snapshot.boundary
            )],
            [1],
        )

    def test_observed_zero_is_distinct_from_missing(self):
        observed_zero = DataValue(
            value=0,
            validity=DataValidity.OBSERVED_ZERO,
            source="fixture",
        )
        missing = DataValue(
            value=None,
            validity=DataValidity.MISSING,
            source="fixture",
            reason="Field was not supplied",
        )

        self.assertEqual(observed_zero.to_dict()["value"], 0)
        self.assertEqual(observed_zero.to_dict()["validity"], "observed_zero")
        self.assertIsNone(missing.to_dict()["value"])
        self.assertEqual(missing.to_dict()["validity"], "missing")
        self.assertNotEqual(observed_zero.to_dict(), missing.to_dict())

    def test_snapshot_replay_is_deterministic(self):
        fixture = load_snapshots()["in_progress"]
        first_snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )
        second_snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )

        first_payload = make_unavailable_prediction_output(
            player_id=101,
            snapshot=first_snapshot,
            expert_rank_score=61.9,
        ).to_dict()
        second_payload = make_unavailable_prediction_output(
            player_id=101,
            snapshot=second_snapshot,
            expert_rank_score=61.9,
        ).to_dict()

        self.assertEqual(first_snapshot.to_dict(), second_snapshot.to_dict())
        self.assertEqual(first_payload, second_payload)

    def test_contract_is_route_independent(self):
        fixture = load_snapshots()["in_progress"]
        snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )
        route_outputs = [
            make_unavailable_prediction_output(
                player_id=101,
                snapshot=snapshot,
                expert_rank_score=61.9,
            ).to_dict()
            for _route in ("/players", "/my-team", "/player/101")
        ]

        self.assertEqual(route_outputs[0], route_outputs[1])
        self.assertEqual(route_outputs[1], route_outputs[2])

    def test_schema_rejects_non_null_missing_value(self):
        fixture = load_snapshots()["in_progress"]
        snapshot = make_prediction_snapshot(
            fixture["snapshot_id"], fixture["events"]
        )
        payload = make_unavailable_prediction_output(
            player_id=101, snapshot=snapshot
        ).to_dict()
        payload["expected_minutes"]["value"] = 0

        with self.assertRaises(ValueError):
            validate_prediction_payload(payload)


if __name__ == "__main__":
    unittest.main()