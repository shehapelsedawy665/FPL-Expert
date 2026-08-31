import unittest

from services.team_analyzer import (
    VALID_FORMATIONS,
    get_recommended_xi,
)


def make_player(
    player_id: int,
    element_type: int,
    expert_score: float,
    *,
    status: str = "a",
    chance_of_playing_next_round: int | None = 100,
) -> dict:
    return {
        "id": player_id,
        "web_name": f"Player {player_id}",
        "element_type": element_type,
        "expert_score": expert_score,
        "future_fpl_score": expert_score,
        "current_form_score": expert_score,
        "minutes_security": 90,
        "availability_score": chance_of_playing_next_round,
        "status": status,
        "chance_of_playing_next_round": chance_of_playing_next_round,
    }


def make_balanced_squad() -> list[dict]:
    players = []
    player_id = 1
    for element_type, scores in (
        (1, [80, 70]),
        (2, [85, 80, 75, 70, 65]),
        (3, [90, 85, 80, 75, 70]),
        (4, [95, 90, 85]),
    ):
        for score in scores:
            players.append(make_player(player_id, element_type, score))
            player_id += 1
    return players


class RecommendedStartingXiTests(unittest.TestCase):
    def test_evaluates_all_formations_and_selects_highest_scoring_legal_xi(self):
        squad = make_balanced_squad()
        recommendation = get_recommended_xi(squad)
        diagnostics = recommendation["formation_diagnostics"]
        legal_diagnostics = [
            diagnostic for diagnostic in diagnostics if diagnostic["is_legal"]
        ]

        self.assertEqual(len(diagnostics), len(VALID_FORMATIONS))
        self.assertEqual(
            {diagnostic["formation_tuple"] for diagnostic in diagnostics},
            set(VALID_FORMATIONS),
        )
        self.assertTrue(
            all(
                diagnostic["selected_count"] == 11
                and diagnostic["is_legal"]
                for diagnostic in diagnostics
            )
        )
        self.assertEqual(len(recommendation["players"]), 11)
        self.assertEqual(recommendation["formation"], (3, 4, 3))
        self.assertEqual(
            recommendation["formation"],
            max(
                legal_diagnostics,
                key=lambda diagnostic: diagnostic["total_expert_score"],
            )["formation_tuple"],
        )
        self.assertEqual(
            round(
                sum(player["expert_score"] for player in recommendation["players"]),
                1,
            ),
            max(
                diagnostic["total_expert_score"]
                for diagnostic in legal_diagnostics
            ),
        )

    def test_selected_xi_has_legal_position_counts(self):
        recommendation = get_recommended_xi(make_balanced_squad())
        players = recommendation["players"]
        counts = {
            element_type: sum(
                player["element_type"] == element_type for player in players
            )
            for element_type in (1, 2, 3, 4)
        }

        self.assertEqual(len(players), 11)
        self.assertEqual(counts[1], 1)
        self.assertGreaterEqual(counts[2], 3)
        self.assertLessEqual(counts[2], 5)
        self.assertGreaterEqual(counts[3], 2)
        self.assertLessEqual(counts[3], 5)
        self.assertGreaterEqual(counts[4], 1)
        self.assertLessEqual(counts[4], 3)
        self.assertIn(recommendation["formation"], VALID_FORMATIONS)

    def test_clear_availability_problem_is_not_preferred_over_healthy_option(self):
        squad = make_balanced_squad()
        injured_midfielder = next(
            player for player in squad if player["element_type"] == 3
        )
        injured_midfielder.update(
            {
                "expert_score": 99,
                "status": "i",
                "chance_of_playing_next_round": 0,
                "availability_score": 0,
            }
        )

        recommendation = get_recommended_xi(squad)
        selected_ids = {player["id"] for player in recommendation["players"]}

        self.assertNotIn(injured_midfielder["id"], selected_ids)
        self.assertFalse(recommendation["availability_fallback"])
        self.assertTrue(
            all(
                not player.get("status") in {"i", "n", "s", "u"}
                and (
                    player.get("chance_of_playing_next_round") is None
                    or player["chance_of_playing_next_round"] >= 75
                )
                for player in recommendation["players"]
            )
        )


if __name__ == "__main__":
    unittest.main()