import logging
from typing import Any


logger = logging.getLogger(__name__)


VALID_FORMATIONS = (
    (3, 4, 3),
    (3, 5, 2),
    (4, 3, 3),
    (4, 4, 2),
    (4, 5, 1),
    (5, 2, 3),
    (5, 3, 2),
    (5, 4, 1),
)

POSITION_NAMES = {
    1: "Goalkeepers",
    2: "Defenders",
    3: "Midfielders",
    4: "Forwards",
}

# Bench V1 follows the requested priority hierarchy. Future FPL Score already
# contains the project's fixture, attacking, minutes, and availability inputs,
# so no raw sub-metrics are added again here.
BENCH_PRIORITY_WEIGHTS = {
    "availability_minutes": 0.55,
    "next_gameweek_performance": 0.35,
    "expert_score_support": 0.10,
}


def number_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _quality_key(player: dict[str, Any]) -> tuple[float, float, float, float]:
    return (
        number_value(player.get("expert_score")),
        number_value(player.get("future_fpl_score")),
        number_value(player.get("minutes_security")),
        number_value(player.get("current_form_score")),
    )


def _has_clear_availability_problem(player: dict[str, Any]) -> bool:
    """Return whether official FPL fields flag a clear next-GW issue."""
    status = str(player.get("status", ""))
    if status in {"i", "n", "s", "u"}:
        return True
    chance = player.get("chance_of_playing_next_round")
    if chance is not None and number_value(chance) < 75:
        return True
    return status == "d" and chance is None


def _availability_reasons(player: dict[str, Any]) -> list[str]:
    reasons = []
    status = str(player.get("status", ""))
    if status in {"i", "n", "s", "u"}:
        reasons.append(player.get("status_label") or "Unavailable")
    elif status == "d":
        reasons.append("Doubtful availability")
    chance = player.get("chance_of_playing_next_round")
    if chance is not None and number_value(chance) < 75:
        reasons.append(f"{number_value(chance):.0f}% chance of playing")
    return reasons


def _playing_security_key(
    player: dict[str, Any],
) -> tuple[float, float, float, float]:
    return (
        number_value(player.get("minutes_security")),
        number_value(player.get("availability_score")),
        number_value(player.get("future_fpl_score")),
        number_value(player.get("expert_score")),
    )


def _bench_priority_inputs(player: dict[str, Any]) -> dict[str, Any]:
    availability_eligible = not _has_clear_availability_problem(player)
    raw_minutes_security = number_value(player.get("minutes_security"))
    availability_minutes_signal = (
        raw_minutes_security if availability_eligible else 0.0
    )
    next_gameweek_performance = number_value(player.get("future_fpl_score"))
    expert_score = number_value(player.get("expert_score"))
    priority_score = (
        availability_minutes_signal
        * BENCH_PRIORITY_WEIGHTS["availability_minutes"]
        + next_gameweek_performance
        * BENCH_PRIORITY_WEIGHTS["next_gameweek_performance"]
        + expert_score * BENCH_PRIORITY_WEIGHTS["expert_score_support"]
    )
    return {
        "availability_eligible": availability_eligible,
        "availability_minutes_signal": round(availability_minutes_signal, 1),
        "minutes_security": round(raw_minutes_security, 1),
        "expected_minutes_proxy": round(
            number_value(player.get("expected_minutes_proxy")), 1
        ),
        "official_availability_score": round(
            number_value(player.get("availability_score")), 1
        ),
        "status": player.get("status"),
        "chance_of_playing_next_round": player.get(
            "chance_of_playing_next_round"
        ),
        "next_gameweek_performance_signal": round(
            next_gameweek_performance, 1
        ),
        "expert_score": round(expert_score, 1),
        "bench_priority_score": round(priority_score, 1),
    }


def _bench_priority_key(player: dict[str, Any]) -> tuple[float, ...]:
    inputs = _bench_priority_inputs(player)
    return (
        1.0 if inputs["availability_eligible"] else 0.0,
        inputs["bench_priority_score"],
        inputs["availability_minutes_signal"],
        inputs["next_gameweek_performance_signal"],
        inputs["expert_score"],
        -number_value(player.get("id")),
    )


def _bench_priority_reason(
    player: dict[str, Any],
    inputs: dict[str, Any],
) -> str:
    if not inputs["availability_eligible"]:
        reasons = _availability_reasons(player)
        detail = ", ".join(reasons) if reasons else "clear availability risk"
        return (
            f"Placed after available options because of {detail}; "
            "not a reliable automatic replacement."
        )

    minutes = inputs["availability_minutes_signal"]
    if minutes >= 70:
        minutes_reason = "secure expected minutes"
    elif minutes <= 35:
        minutes_reason = "limited expected minutes"
    else:
        minutes_reason = "moderate expected minutes"
    return (
        f"{minutes_reason}; next-GW projection "
        f"{inputs['next_gameweek_performance_signal']:.1f}; "
        f"Expert Score {inputs['expert_score']:.1f} supports the ranking."
    )


def _annotate_bench_player(
    player: dict[str, Any],
    rank: int,
) -> dict[str, Any]:
    annotated = dict(player)
    inputs = _bench_priority_inputs(player)
    annotated.update(
        {
            "bench_priority_rank": rank,
            "bench_priority_score": inputs["bench_priority_score"],
            "bench_priority_reason": _bench_priority_reason(player, inputs),
            "bench_priority_inputs": inputs,
        }
    )
    return annotated


def _fixture_reason(player: dict[str, Any]) -> str:
    fixture_score = number_value(player.get("fixture_score"))
    if fixture_score >= 70:
        return "favorable upcoming fixtures"
    if fixture_score <= 35:
        return "difficult upcoming fixtures"
    return "a balanced fixture run"


def _captain_reason(player: dict[str, Any]) -> str:
    reasons = []
    if number_value(player.get("current_form_score")) >= 70:
        reasons.append("excellent current form")
    if number_value(player.get("attacking_score")) >= 70:
        reasons.append("strong attacking output")
    reasons.append(_fixture_reason(player))
    if number_value(player.get("minutes_security")) >= 70:
        reasons.append("secure expected minutes")
    return ", ".join(reasons[:3]).capitalize() + "."


def import_squad(
    team_data: dict[str, Any],
    rated_players: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    player_lookup = {
        player.get("id"): player
        for player in rated_players
        if player.get("id") is not None
    }
    squad = []
    for pick in team_data.get("picks", []):
        element_id = pick.get("element")
        player = player_lookup.get(element_id)
        if player is None:
            squad.append(
                {
                    "id": element_id,
                    "element_type": pick.get("element_type"),
                    "missing_data": True,
                    "pick_position": pick.get("position"),
                    "multiplier": pick.get("multiplier", 1),
                    "is_captain": pick.get("is_captain", False),
                    "is_vice_captain": pick.get("is_vice_captain", False),
                }
            )
            continue
        imported = dict(player)
        imported.update(
            {
                "pick_position": pick.get("position"),
                "multiplier": pick.get("multiplier", 1),
                "is_captain": pick.get("is_captain", False),
                "is_vice_captain": pick.get("is_vice_captain", False),
                "purchase_price": pick.get("purchase_price"),
                "selling_price": pick.get("selling_price"),
                "missing_data": False,
            }
        )
        squad.append(imported)
    return squad


def group_squad(squad: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "position_id": position_id,
            "name": POSITION_NAMES[position_id],
            "players": [
                player
                for player in squad
                if player.get("element_type") == position_id
            ],
        }
        for position_id in (1, 2, 3, 4)
    ]


def _players_for_formation(
    formation: tuple[int, int, int],
    players_by_position: dict[int, list[dict[str, Any]]],
) -> list[dict[str, Any]] | None:
    goalkeeper = players_by_position.get(1, [])
    defenders = players_by_position.get(2, [])
    midfielders = players_by_position.get(3, [])
    forwards = players_by_position.get(4, [])
    defender_count, midfielder_count, forward_count = formation
    if not goalkeeper or len(defenders) < defender_count:
        return None
    if len(midfielders) < midfielder_count or len(forwards) < forward_count:
        return None
    selected = []
    for players, count in (
        (goalkeeper, 1),
        (defenders, defender_count),
        (midfielders, midfielder_count),
        (forwards, forward_count),
    ):
        selected.extend(sorted(players, key=_quality_key, reverse=True)[:count])
    return selected


def _formation_score(
    formation: tuple[int, int, int],
    players_by_position: dict[int, list[dict[str, Any]]],
) -> float:
    selected = _players_for_formation(formation, players_by_position)
    if selected is None:
        return -1
    return sum(number_value(player.get("expert_score")) for player in selected)


def _is_legal_xi(
    players: list[dict[str, Any]],
    formation: tuple[int, int, int],
) -> bool:
    counts = _position_counts(players)
    return (
        _is_legal_fpl_xi(players)
        and counts[2] == formation[0]
        and counts[3] == formation[1]
        and counts[4] == formation[2]
    )


def _position_counts(players: list[dict[str, Any]]) -> dict[int, int]:
    return {
        position_id: sum(
            player.get("element_type") == position_id for player in players
        )
        for position_id in (1, 2, 3, 4)
    }


def _is_legal_fpl_xi(players: list[dict[str, Any]]) -> bool:
    if len(players) != 11:
        return False
    counts = _position_counts(players)
    return (
        counts[1] == 1
        and 3 <= counts[2] <= 5
        and 2 <= counts[3] <= 5
        and 1 <= counts[4] <= 3
    )


def _position_index(players: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    return {
        position_id: [
            player
            for player in players
            if player.get("element_type") == position_id
        ]
        for position_id in (1, 2, 3, 4)
    }


def _formation_diagnostics(
    players_by_position: dict[int, list[dict[str, Any]]],
    *,
    availability_fallback: bool = False,
) -> list[dict[str, Any]]:
    diagnostics = []
    for formation in VALID_FORMATIONS:
        selected = _players_for_formation(formation, players_by_position)
        is_legal = selected is not None and _is_legal_xi(selected, formation)
        selected = selected or []
        score = (
            round(sum(number_value(player.get("expert_score")) for player in selected), 1)
            if is_legal
            else None
        )
        diagnostic = {
            "formation": f"{formation[0]}-{formation[1]}-{formation[2]}",
            "formation_tuple": formation,
            "selected_players": [
                player.get("web_name") or str(player.get("id"))
                for player in selected
            ],
            "selected_player_ids": [player.get("id") for player in selected],
            "selected_count": len(selected),
            "total_expert_score": score,
            "is_legal": is_legal,
            "availability_fallback": availability_fallback,
            "availability_issues": [
                reason
                for player in selected
                for reason in _availability_reasons(player)
            ],
        }
        diagnostics.append(diagnostic)
        logger.debug(
            "Starting XI formation=%s selected=%s total_expert_score=%s "
            "legal=%s availability_fallback=%s",
            diagnostic["formation"],
            ", ".join(diagnostic["selected_players"]),
            diagnostic["total_expert_score"],
            diagnostic["is_legal"],
            availability_fallback,
        )
    return diagnostics


def get_recommended_xi(squad: list[dict[str, Any]]) -> dict[str, Any]:
    available = [player for player in squad if not player.get("missing_data")]
    eligible = [
        player for player in available if not _has_clear_availability_problem(player)
    ]
    players_by_position = _position_index(eligible)
    diagnostics = _formation_diagnostics(players_by_position)
    legal_formations = [
        diagnostic for diagnostic in diagnostics if diagnostic["is_legal"]
    ]
    availability_fallback = False

    if not legal_formations:
        # A lineup is still useful when a squad has too many unavailable players
        # in one position. This path only uses a flagged player when no legal
        # availability-eligible XI can be formed at all.
        players_by_position = _position_index(available)
        diagnostics = _formation_diagnostics(
            players_by_position, availability_fallback=True
        )
        legal_formations = [
            diagnostic for diagnostic in diagnostics if diagnostic["is_legal"]
        ]
        availability_fallback = True

    if not legal_formations:
        return {
            "players": [],
            "formation": None,
            "formation_label": "Unavailable",
            "formation_diagnostics": diagnostics,
            "availability_fallback": availability_fallback,
        }

    winning_diagnostic = max(
        legal_formations,
        key=lambda diagnostic: (
            number_value(diagnostic["total_expert_score"]),
            -VALID_FORMATIONS.index(diagnostic["formation_tuple"]),
        ),
    )
    formation = winning_diagnostic["formation_tuple"]
    selected = _players_for_formation(formation, players_by_position) or []
    return {
        "players": selected,
        "formation": formation,
        "formation_label": f"{formation[0]}-{formation[1]}-{formation[2]}",
        "formation_diagnostics": diagnostics,
        "availability_fallback": availability_fallback,
    }


def get_bench_order(
    squad: list[dict[str, Any]],
    starting_xi: list[dict[str, Any]],
) -> dict[str, Any]:
    starting_ids = {player.get("id") for player in starting_xi}
    bench = [
        player
        for player in squad
        if not player.get("missing_data") and player.get("id") not in starting_ids
    ]
    bench_goalkeepers = sorted(
        [player for player in bench if player.get("element_type") == 1],
        key=_playing_security_key,
        reverse=True,
    )
    bench_outfield = sorted(
        [player for player in bench if player.get("element_type") != 1],
        key=_bench_priority_key,
        reverse=True,
    )
    ordered_substitutes = [
        _annotate_bench_player(player, rank)
        for rank, player in enumerate(bench_outfield[:3], 1)
    ]
    return {
        "goalkeeper": bench_goalkeepers[0] if bench_goalkeepers else None,
        "substitutes": ordered_substitutes,
        "players": (
            ([bench_goalkeepers[0]] if bench_goalkeepers else [])
            + ordered_substitutes
        ),
    }


def _formation_label_for_xi(players: list[dict[str, Any]]) -> str:
    counts = _position_counts(players)
    return f"{counts[2]}-{counts[3]}-{counts[4]}"


def explain_auto_substitution(
    starting_xi: list[dict[str, Any]],
    bench_order: dict[str, Any],
    absent_player_id: Any,
) -> dict[str, Any]:
    """Explain the first legal FPL auto-substitution for one absent starter."""
    absent = next(
        (player for player in starting_xi if player.get("id") == absent_player_id),
        None,
    )
    if absent is None:
        return {
            "status": "invalid",
            "reason": "The absent player is not in the Starting XI.",
            "replacement": None,
        }

    remaining = [
        player for player in starting_xi if player.get("id") != absent_player_id
    ]
    if absent.get("element_type") == 1:
        goalkeeper = bench_order.get("goalkeeper")
        if goalkeeper is not None:
            resulting_xi = remaining + [goalkeeper]
            if _is_legal_fpl_xi(resulting_xi):
                return {
                    "status": "replaced",
                    "absent_player": absent,
                    "replacement": goalkeeper,
                    "replacement_slot": "Bench GK",
                    "resulting_formation": _formation_label_for_xi(resulting_xi),
                    "skipped_candidates": [],
                    "reason": (
                        f"{goalkeeper.get('web_name', 'Bench GK')} replaces the "
                        "absent goalkeeper from Bench GK."
                    ),
                }
        return {
            "status": "no_legal_substitute",
            "absent_player": absent,
            "replacement": None,
            "replacement_slot": None,
            "resulting_formation": None,
            "skipped_candidates": [],
            "reason": "No separate bench goalkeeper can produce a legal XI.",
        }

    skipped_candidates = []
    for index, candidate in enumerate(
        bench_order.get("substitutes", []), 1
    ):
        resulting_xi = remaining + [candidate]
        if _is_legal_fpl_xi(resulting_xi):
            return {
                "status": "replaced",
                "absent_player": absent,
                "replacement": candidate,
                "replacement_slot": f"{index}SUB",
                "resulting_formation": _formation_label_for_xi(resulting_xi),
                "skipped_candidates": skipped_candidates,
                "reason": (
                    f"{candidate.get('web_name', 'Bench player')} enters from "
                    f"{index}SUB and preserves a legal "
                    f"{_formation_label_for_xi(resulting_xi)}."
                ),
            }
        skipped_candidates.append(
            {
                "slot": f"{index}SUB",
                "player": candidate,
                "reason": "would leave an illegal goalkeeper/position balance",
            }
        )

    return {
        "status": "no_legal_substitute",
        "absent_player": absent,
        "replacement": None,
        "replacement_slot": None,
        "resulting_formation": None,
        "skipped_candidates": skipped_candidates,
        "reason": "No outfield bench player can produce a legal XI.",
    }


def get_captain_candidates(starting_xi: list[dict[str, Any]]) -> dict[str, Any]:
    def captain_score(player: dict[str, Any]) -> float:
        return (
            number_value(player.get("future_fpl_score")) * 0.35
            + number_value(player.get("current_form_score")) * 0.25
            + number_value(player.get("fixture_score")) * 0.15
            + number_value(player.get("minutes_security")) * 0.15
            + number_value(player.get("expert_score")) * 0.10
        )

    candidates = sorted(starting_xi, key=captain_score, reverse=True)
    captain = candidates[0] if candidates else None
    vice_captain = candidates[1] if len(candidates) > 1 else None
    return {
        "captain": captain,
        "vice_captain": vice_captain,
        "captain_reason": _captain_reason(captain) if captain else "",
        "vice_captain_reason": _captain_reason(vice_captain)
        if vice_captain
        else "",
    }


def _player_risk_reasons(
    player: dict[str, Any],
    squad_average: float,
) -> list[str]:
    reasons = []
    status = player.get("status")
    if status in {"i", "n", "s", "u"}:
        reasons.append(player.get("status_label") or "Unavailable")
    elif status == "d":
        reasons.append("Doubtful availability")
    chance = player.get("chance_of_playing_next_round")
    if chance is not None and number_value(chance) < 75:
        reasons.append(f"{number_value(chance):.0f}% chance of playing")
    if number_value(player.get("minutes_security")) < 35:
        reasons.append("low expected minutes")
    if number_value(player.get("current_form_score")) < 35:
        reasons.append("very poor current form")
    if number_value(player.get("fixture_score")) < 35:
        reasons.append("difficult upcoming fixtures")
    if number_value(player.get("expert_score")) < squad_average - 15:
        reasons.append("Expert Score is well below the squad average")
    return reasons


def analyze_squad_health(
    squad: list[dict[str, Any]],
    starting_xi: list[dict[str, Any]],
) -> dict[str, Any]:
    available = [player for player in squad if not player.get("missing_data")]
    scores = [number_value(player.get("expert_score")) for player in available]
    average_squad_score = sum(scores) / len(scores) if scores else None
    xi_scores = [
        number_value(player.get("expert_score")) for player in starting_xi
    ]
    average_xi_score = sum(xi_scores) / len(xi_scores) if xi_scores else None
    injury_risks = [
        player
        for player in available
        if player.get("status") in {"d", "i", "n", "s", "u"}
        or (
            player.get("chance_of_playing_next_round") is not None
            and number_value(player.get("chance_of_playing_next_round")) < 75
        )
    ]
    return {
        "strong_picks": sum(
            number_value(player.get("expert_score")) >= 70 for player in available
        ),
        "weak_picks": sum(
            number_value(player.get("expert_score")) < 50 for player in available
        ),
        "injury_risks": len(injury_risks),
        "low_confidence": sum(
            player.get("data_confidence") == "Low" for player in available
        ),
        "average_squad_score": average_squad_score,
        "average_xi_score": average_xi_score,
    }


def analyze_squad(squad: list[dict[str, Any]]) -> dict[str, Any]:
    available = [player for player in squad if not player.get("missing_data")]
    squad_average = (
        sum(number_value(player.get("expert_score")) for player in available)
        / len(available)
        if available
        else 0
    )
    starting_xi = get_recommended_xi(squad)
    bench = get_bench_order(squad, starting_xi["players"])
    captaincy = get_captain_candidates(starting_xi["players"])
    attention = []
    for player in available:
        reasons = _player_risk_reasons(player, squad_average)
        if reasons:
            attention.append(
                {
                    "player": player,
                    "reason": ". ".join(reasons) + ".",
                }
            )
    attention.sort(
        key=lambda item: (
            number_value(item["player"].get("availability_score")),
            number_value(item["player"].get("expert_score")),
        )
    )
    return {
        "groups": group_squad(squad),
        "starting_xi": starting_xi,
        "bench": bench,
        "captaincy": captaincy,
        "health": analyze_squad_health(squad, starting_xi["players"]),
        "attention": attention,
    }