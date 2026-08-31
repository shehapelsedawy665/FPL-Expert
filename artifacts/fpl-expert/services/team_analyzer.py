from typing import Any


VALID_FORMATIONS = (
    (3, 4, 3),
    (3, 5, 2),
    (4, 4, 2),
    (4, 3, 3),
    (4, 5, 1),
    (5, 3, 2),
    (5, 4, 1),
    (5, 2, 3),
)

POSITION_NAMES = {
    1: "Goalkeepers",
    2: "Defenders",
    3: "Midfielders",
    4: "Forwards",
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


def _playing_security_key(
    player: dict[str, Any],
) -> tuple[float, float, float, float]:
    return (
        number_value(player.get("minutes_security")),
        number_value(player.get("availability_score")),
        number_value(player.get("future_fpl_score")),
        number_value(player.get("expert_score")),
    )


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


def _formation_score(
    formation: tuple[int, int, int],
    players_by_position: dict[int, list[dict[str, Any]]],
) -> float:
    goalkeeper = players_by_position.get(1, [])
    defenders = players_by_position.get(2, [])
    midfielders = players_by_position.get(3, [])
    forwards = players_by_position.get(4, [])
    defender_count, midfielder_count, forward_count = formation
    if not goalkeeper or len(defenders) < defender_count:
        return -1
    if len(midfielders) < midfielder_count or len(forwards) < forward_count:
        return -1
    return sum(
        number_value(player.get("expert_score"))
        for players, count in (
            (goalkeeper, 1),
            (defenders, defender_count),
            (midfielders, midfielder_count),
            (forwards, forward_count),
        )
        for player in sorted(players, key=_quality_key, reverse=True)[:count]
    )


def get_recommended_xi(squad: list[dict[str, Any]]) -> dict[str, Any]:
    available = [player for player in squad if not player.get("missing_data")]
    players_by_position = {
        position_id: [
            player for player in available if player.get("element_type") == position_id
        ]
        for position_id in (1, 2, 3, 4)
    }
    legal_formations = [
        formation
        for formation in VALID_FORMATIONS
        if _formation_score(formation, players_by_position) >= 0
    ]
    if not legal_formations:
        return {"players": [], "formation": None, "formation_label": "Unavailable"}

    formation = max(
        legal_formations,
        key=lambda item: (_formation_score(item, players_by_position), item),
    )
    goalkeeper_count, defender_count, midfielder_count, forward_count = (
        1,
        formation[0],
        formation[1],
        formation[2],
    )
    selected = []
    for position_id, count in (
        (1, goalkeeper_count),
        (2, defender_count),
        (3, midfielder_count),
        (4, forward_count),
    ):
        selected.extend(
            sorted(
                players_by_position.get(position_id, []),
                key=_quality_key,
                reverse=True,
            )[:count]
        )
    return {
        "players": selected,
        "formation": formation,
        "formation_label": f"{formation[0]}-{formation[1]}-{formation[2]}",
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
        key=_playing_security_key,
        reverse=True,
    )
    return {
        "goalkeeper": bench_goalkeepers[0] if bench_goalkeepers else None,
        "substitutes": bench_outfield[:3],
        "players": (
            ([bench_goalkeepers[0]] if bench_goalkeepers else [])
            + bench_outfield[:3]
        ),
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