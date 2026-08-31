import unittest

from services.team_analyzer import (
    VALID_FORMATIONS,
    explain_auto_substitution,
    get_bench_order,
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


def make_bench_squad() -> tuple[list[dict], list[dict]]:
    squad = [
        make_player(1, 1, 80),
        make_player(2, 1, 70),
        make_player(3, 2, 70),
        make_player(4, 2, 65),
        make_player(5, 2, 60),
        make_player(6, 2, 55),
        make_player(7, 3, 80),
        make_player(8, 3, 75),
        make_player(9, 3, 70),
        make_player(10, 3, 65),
        make_player(11, 3, 60),
        make_player(12, 4, 90),
        make_player(13, 4, 85),
        make_player(14, 4, 80),
        make_player(15, 4, 75),
    ]
    starting_ids = {1, 3, 4, 5, 7, 8, 9, 10, 12, 13, 14}
    starting_xi = [
        player for player in squad if player["id"] in starting_ids
    ]
    return squad, starting_xi


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


class BenchOrderTests(unittest.TestCase):
    def test_returns_three_ordered_available_outfield_substitutes(self):
        squad, starting_xi = make_bench_squad()
        for player_id, values in {
            6: (90, 50, 40),
            11: (80, 70, 60),
            15: (70, 80, 80),
        }.items():
            player = next(player for player in squad if player["id"] == player_id)
            player.update(
                {
                    "minutes_security": values[0],
                    "expected_minutes_proxy": values[0],
                    "future_fpl_score": values[1],
                    "expert_score": values[2],
                }
            )

        bench = get_bench_order(squad, starting_xi)

        self.assertIsNotNone(bench["goalkeeper"])
        self.assertEqual(len(bench["substitutes"]), 3)
        self.assertEqual(
            [player["id"] for player in bench["substitutes"]],
            [11, 15, 6],
        )
        self.assertEqual(
            [player["bench_priority_rank"] for player in bench["substitutes"]],
            [1, 2, 3],
        )
        self.assertTrue(
            all(
                "bench_priority_score" in player
                and "bench_priority_inputs" in player
                and player["bench_priority_reason"]
                for player in bench["substitutes"]
            )
        )

    def test_high_expert_score_with_poor_minutes_is_not_first(self):
        squad, starting_xi = make_bench_squad()
        poor_minutes = next(player for player in squad if player["id"] == 11)
        poor_minutes.update(
            {
                "expert_score": 99,
                "future_fpl_score": 95,
                "minutes_security": 10,
                "expected_minutes_proxy": 0,
            }
        )

        bench = get_bench_order(squad, starting_xi)

        self.assertNotEqual(bench["substitutes"][0]["id"], poor_minutes["id"])
        self.assertEqual(
            next(
                player["bench_priority_inputs"]["expected_minutes_proxy"]
                for player in bench["substitutes"]
                if player["id"] == poor_minutes["id"]
            ),
            0,
        )

    def test_unavailable_player_is_after_available_options(self):
        squad, starting_xi = make_bench_squad()
        unavailable = next(player for player in squad if player["id"] == 15)
        unavailable.update(
            {
                "expert_score": 99,
                "future_fpl_score": 99,
                "status": "i",
                "chance_of_playing_next_round": 0,
            }
        )

        bench = get_bench_order(squad, starting_xi)

        self.assertEqual(bench["substitutes"][-1]["id"], unavailable["id"])
        self.assertFalse(
            bench["substitutes"][-1]["bench_priority_inputs"][
                "availability_eligible"
            ]
        )

    def test_equal_candidates_use_deterministic_player_id_tie_break(self):
        squad, starting_xi = make_bench_squad()
        for player_id in (6, 11, 15):
            player = next(player for player in squad if player["id"] == player_id)
            player.update(
                {
                    "expert_score": 50,
                    "future_fpl_score": 50,
                    "minutes_security": 50,
                    "expected_minutes_proxy": 50,
                }
            )

        bench = get_bench_order(squad, starting_xi)

        self.assertEqual(
            [player["id"] for player in bench["substitutes"]],
            [6, 11, 15],
        )

    def test_defender_absence_skips_midfielder_that_would_break_minimum_defenders(
        self,
    ):
        squad, starting_xi = make_bench_squad()
        for player_id, score in {11: 99, 6: 80, 15: 70}.items():
            player = next(player for player in squad if player["id"] == player_id)
            player.update(
                {
                    "expert_score": score,
                    "future_fpl_score": score,
                    "minutes_security": 90,
                }
            )
        bench = get_bench_order(squad, starting_xi)

        result = explain_auto_substitution(starting_xi, bench, 3)

        self.assertEqual(result["replacement"]["id"], 6)
        self.assertEqual(result["replacement_slot"], "2SUB")
        self.assertEqual(result["resulting_formation"], "3-4-3")
        self.assertEqual(result["skipped_candidates"][0]["player"]["id"], 11)

    def test_midfielder_and_forward_absences_use_first_legal_outfield_sub(self):
        squad, starting_xi = make_bench_squad()
        bench = get_bench_order(squad, starting_xi)

        midfielder_result = explain_auto_substitution(starting_xi, bench, 7)
        forward_result = explain_auto_substitution(starting_xi, bench, 12)

        self.assertEqual(midfielder_result["status"], "replaced")
        self.assertEqual(midfielder_result["replacement"]["id"], 11)
        self.assertEqual(midfielder_result["resulting_formation"], "3-4-3")
        self.assertEqual(forward_result["status"], "replaced")
        self.assertEqual(forward_result["replacement"]["id"], 15)
        self.assertEqual(forward_result["resulting_formation"], "3-4-3")

    def test_goalkeeper_absence_uses_separate_bench_goalkeeper(self):
        squad, starting_xi = make_bench_squad()
        bench = get_bench_order(squad, starting_xi)

        result = explain_auto_substitution(starting_xi, bench, 1)

        self.assertEqual(result["status"], "replaced")
        self.assertEqual(result["replacement"]["id"], 2)
        self.assertEqual(result["replacement_slot"], "Bench GK")
        self.assertEqual(result["resulting_formation"], "3-4-3")


if __name__ == "__main__":
    unittest.main()