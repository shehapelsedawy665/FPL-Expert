from typing import Any


POSITION_LABELS = {
    1: "Goalkeeper",
    2: "Defender",
    3: "Midfielder",
    4: "Forward",
}

STATUS_LABELS = {
    "a": "Available",
    "d": "Doubtful",
    "i": "Injured",
    "n": "Not available",
    "s": "Suspended",
    "u": "Unavailable",
}

STATUS_AVAILABILITY = {
    "a": 100.0,
    "d": 55.0,
    "i": 20.0,
    "n": 0.0,
    "s": 0.0,
    "u": 0.0,
}

# These weights intentionally differ by FPL position. Each position is scored
# against its own player pool, so a goalkeeper is never percentile-ranked
# directly against a midfielder.
CURRENT_WEIGHTS = {
    1: {
        "event_points": 0.10,
        "form": 0.10,
        "points_per_game": 0.09,
        "minutes": 0.15,
        "clean_sheets": 0.16,
        "bonus": 0.10,
        "expected_goals": 0.04,
        "expected_assists": 0.04,
        "expected_goal_involvements": 0.04,
        "ict_index": 0.04,
        "influence": 0.05,
        "creativity": 0.02,
        "threat": 0.02,
        "goals_scored": 0.03,
        "assists": 0.02,
    },
    2: {
        "event_points": 0.10,
        "form": 0.10,
        "points_per_game": 0.07,
        "minutes": 0.14,
        "clean_sheets": 0.15,
        "bonus": 0.08,
        "expected_goals": 0.07,
        "expected_assists": 0.07,
        "expected_goal_involvements": 0.09,
        "ict_index": 0.04,
        "influence": 0.02,
        "creativity": 0.03,
        "threat": 0.03,
        "goals_scored": 0.03,
        "assists": 0.01,
    },
    3: {
        "event_points": 0.10,
        "form": 0.10,
        "points_per_game": 0.06,
        "minutes": 0.09,
        "clean_sheets": 0.03,
        "bonus": 0.07,
        "expected_goals": 0.12,
        "expected_assists": 0.10,
        "expected_goal_involvements": 0.15,
        "ict_index": 0.05,
        "influence": 0.02,
        "creativity": 0.07,
        "threat": 0.08,
        "goals_scored": 0.03,
        "assists": 0.03,
    },
    4: {
        "event_points": 0.10,
        "form": 0.10,
        "points_per_game": 0.06,
        "minutes": 0.10,
        "clean_sheets": 0.01,
        "bonus": 0.07,
        "expected_goals": 0.18,
        "expected_assists": 0.04,
        "expected_goal_involvements": 0.18,
        "ict_index": 0.04,
        "influence": 0.02,
        "creativity": 0.03,
        "threat": 0.12,
        "goals_scored": 0.10,
        "assists": 0.05,
    },
}

ATTACKING_WEIGHTS = {
    1: {
        "expected_goals": 0.15,
        "expected_assists": 0.10,
        "expected_goal_involvements": 0.15,
        "threat": 0.10,
        "bonus": 0.20,
        "clean_sheets": 0.30,
    },
    2: {
        "expected_goals": 0.18,
        "expected_assists": 0.14,
        "expected_goal_involvements": 0.22,
        "threat": 0.14,
        "bonus": 0.12,
        "clean_sheets": 0.20,
    },
    3: {
        "expected_goals": 0.24,
        "expected_assists": 0.18,
        "expected_goal_involvements": 0.25,
        "threat": 0.13,
        "creativity": 0.12,
        "goals_scored": 0.08,
    },
    4: {
        "expected_goals": 0.30,
        "expected_assists": 0.10,
        "expected_goal_involvements": 0.28,
        "threat": 0.17,
        "bonus": 0.08,
        "goals_scored": 0.07,
    },
}


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def number_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _raw_value(player: dict[str, Any], key: str) -> float | None:
    value = player.get(key)
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _percentile(value: float | None, peer_values: list[float]) -> float:
    valid_values = sorted(peer_values)
    if value is None:
        return 50.0 if not valid_values else 0.0
    if len(valid_values) <= 1:
        return 50.0
    less_count = sum(peer < value for peer in valid_values)
    equal_count = sum(peer == value for peer in valid_values)
    return clamp(((less_count + (equal_count * 0.5)) / len(valid_values)) * 100)


def _weighted_percentile(
    player: dict[str, Any],
    peers: list[dict[str, Any]],
    weights: dict[str, float],
) -> float:
    total_weight = sum(weights.values())
    if total_weight <= 0:
        return 50.0
    score = 0.0
    for key, weight in weights.items():
        peer_values = [
            value
            for peer in peers
            if (value := _raw_value(peer, key)) is not None
        ]
        score += _percentile(_raw_value(player, key), peer_values) * weight
    return clamp(score / total_weight)


def _chance_score(player: dict[str, Any]) -> float:
    chance = _raw_value(player, "chance_of_playing_next_round")
    if chance is not None:
        return clamp(chance)
    return STATUS_AVAILABILITY.get(str(player.get("status", "")), 50.0)


def _availability_penalty(player: dict[str, Any]) -> float:
    status = str(player.get("status", ""))
    chance = _chance_score(player)
    status_penalty = {
        "a": 0.0,
        "d": 10.0,
        "i": 25.0,
        "n": 35.0,
        "s": 35.0,
        "u": 35.0,
    }.get(status, 8.0)
    chance_penalty = max(0.0, (75.0 - chance) * 0.16)
    return round(clamp(status_penalty + chance_penalty, 0.0, 45.0), 2)


def _minutes_profile(
    player: dict[str, Any],
    reference_gameweek: int,
) -> tuple[float, float]:
    gameweeks_played = max(1, reference_gameweek)
    expected_minutes = gameweeks_played * 90
    season_minutes_rate = clamp(
        (number_value(player.get("minutes")) / expected_minutes) * 100
    )
    starts_rate = clamp(
        (number_value(player.get("starts")) / gameweeks_played) * 100
    )
    appearances_rate = clamp(
        (number_value(player.get("appearances")) / gameweeks_played) * 100
    )
    minutes_proxy = (
        season_minutes_rate * 0.55
        + starts_rate * 0.30
        + appearances_rate * 0.15
    )
    return clamp(minutes_proxy), clamp(minutes_proxy * 0.65 + _chance_score(player) * 0.35)


def _fixture_score(player: dict[str, Any]) -> float:
    next_3 = _raw_value(player, "next_3_avg_difficulty")
    next_5 = _raw_value(player, "next_5_avg_difficulty")
    next_3_score = 25.0 if next_3 is None else clamp((5.0 - next_3) / 4.0 * 100)
    next_5_score = 25.0 if next_5 is None else clamp((5.0 - next_5) / 4.0 * 100)
    fixtures = player.get("next_5_fixtures")
    fixtures = fixtures if isinstance(fixtures, list) else []
    if fixtures:
        home_count = sum(fixture.get("venue") == "H" for fixture in fixtures)
        home_away_score = (home_count / len(fixtures)) * 100
    else:
        home_away_score = 25.0
    return clamp(next_3_score * 0.50 + next_5_score * 0.35 + home_away_score * 0.15)


def _team_context_score(
    player: dict[str, Any],
    team_peers: list[dict[str, Any]],
) -> float:
    attack_values = [
        value
        for peer in team_peers
        if (value := _raw_value(peer, "team_attack_strength")) is not None
    ]
    defence_values = [
        value
        for peer in team_peers
        if (value := _raw_value(peer, "team_defence_strength")) is not None
    ]
    transfer_values = [
        number_value(peer.get("transfers_in", 0))
        - number_value(peer.get("transfers_out", 0))
        for peer in team_peers
    ]
    attack_score = _percentile(
        _raw_value(player, "team_attack_strength"), attack_values
    )
    defence_score = _percentile(
        _raw_value(player, "team_defence_strength"), defence_values
    )
    net_transfer = number_value(player.get("transfers_in", 0)) - number_value(
        player.get("transfers_out", 0)
    )
    transfer_score = _percentile(net_transfer, transfer_values)
    ownership_peers = [
        value
        for peer in team_peers
        if (value := _raw_value(peer, "selected_by_percent")) is not None
    ]
    ownership_score = _percentile(
        _raw_value(player, "selected_by_percent"), ownership_peers
    )
    position = player.get("element_type")
    if position in {1, 2}:
        return clamp(
            attack_score * 0.20
            + defence_score * 0.50
            + ownership_score * 0.15
            + transfer_score * 0.15
        )
    return clamp(
        attack_score * 0.45
        + defence_score * 0.10
        + ownership_score * 0.25
        + transfer_score * 0.20
    )


def _rating_label(score: float) -> str:
    if score >= 90:
        return "Elite"
    if score >= 80:
        return "Excellent"
    if score >= 70:
        return "Strong"
    if score >= 60:
        return "Decent"
    if score >= 50:
        return "Average"
    return "Weak"


def _explanation(
    fixture_score: float,
    attacking_score: float,
    minutes_security: float,
    value_score: float,
    availability_penalty: float,
) -> str:
    drivers: list[str] = []
    if fixture_score >= 70:
        drivers.append("strong upcoming fixtures")
    elif fixture_score <= 35:
        drivers.append("difficult upcoming fixtures")
    if attacking_score >= 70:
        drivers.append("high xGI and attacking metrics")
    elif attacking_score <= 35:
        drivers.append("limited attacking output")
    if minutes_security >= 70:
        drivers.append("secure minutes")
    elif minutes_security <= 35:
        drivers.append("limited or uncertain minutes")
    if value_score >= 70:
        drivers.append("good value")
    if availability_penalty >= 10:
        drivers.append("an availability concern")
    if not drivers:
        drivers.append("balanced underlying numbers")
    return f"{drivers[0].capitalize()} are driving this score."


def _player_rating(
    player: dict[str, Any],
    position_peers: list[dict[str, Any]],
    all_players: list[dict[str, Any]],
    reference_gameweek: int,
) -> dict[str, Any]:
    position = player.get("element_type")
    if position not in CURRENT_WEIGHTS:
        position = 3

    current_form_score = _weighted_percentile(
        player, position_peers, CURRENT_WEIGHTS[position]
    )
    attacking_score = _weighted_percentile(
        player, position_peers, ATTACKING_WEIGHTS[position]
    )
    minutes_proxy, minutes_security = _minutes_profile(player, reference_gameweek)
    fixture_score = _fixture_score(player)
    context_score = _team_context_score(player, all_players)
    chance_score = _chance_score(player)
    availability_penalty = _availability_penalty(player)
    future_fpl_score = clamp(
        fixture_score * 0.40
        + attacking_score * 0.30
        + minutes_security * 0.20
        + context_score * 0.05
        + chance_score * 0.05
    )

    price = max(number_value(player.get("now_cost")) / 10.0, 0.1)
    value_ratio = future_fpl_score / price
    value_ratios = [
        (
            clamp(
                number_value(peer.get("future_fpl_score", 0))
                / max(number_value(peer.get("now_cost")) / 10.0, 0.1)
            )
        )
        for peer in position_peers
    ]
    value_score = _percentile(value_ratio, value_ratios)
    minutes_penalty = round(max(0.0, (45.0 - minutes_proxy) * 0.10), 2)
    weighted_score = (
        current_form_score * 0.35
        + future_fpl_score * 0.50
        + value_score * 0.15
    )
    expert_score = clamp(weighted_score - availability_penalty - minutes_penalty)

    breakdown = {
        "form_contribution": round(current_form_score * 0.35, 1),
        "fixture_contribution": round(fixture_score * 0.50 * 0.40, 1),
        "attacking_contribution": round(attacking_score * 0.50 * 0.30, 1),
        "minutes_security_contribution": round(minutes_security * 0.50 * 0.20, 1),
        "context_contribution": round(context_score * 0.50 * 0.05, 1),
        "value_contribution": round(value_score * 0.15, 1),
        "availability_penalty": availability_penalty,
        "minutes_penalty": minutes_penalty,
        "weighted_before_penalties": round(weighted_score, 1),
    }
    return {
        "current_form_score": round(current_form_score, 1),
        "future_fpl_score": round(future_fpl_score, 1),
        "value_score": round(value_score, 1),
        "expert_score": round(expert_score, 1),
        "rating_label": _rating_label(expert_score),
        "minutes_security": round(minutes_security, 1),
        "expected_minutes_proxy": round(minutes_proxy, 1),
        "fixture_score": round(fixture_score, 1),
        "attacking_score": round(attacking_score, 1),
        "availability_score": round(chance_score, 1),
        "rating_breakdown": breakdown,
        "rating_explanation": _explanation(
            fixture_score,
            attacking_score,
            minutes_security,
            value_score,
            availability_penalty,
        ),
        "position_label": POSITION_LABELS.get(position, "Unknown"),
    }


def add_ratings(
    players: list[dict[str, Any]],
    *,
    reference_gameweek: int,
) -> list[dict[str, Any]]:
    """Return every player with deterministic, position-relative scores."""
    by_position: dict[Any, list[dict[str, Any]]] = {}
    for player in players:
        by_position.setdefault(player.get("element_type"), []).append(player)

    # Future value is calculated from future score before value itself exists.
    # A temporary future score is attached to each player for the value pass.
    prepared_players = []
    for player in players:
        player_copy = dict(player)
        position = player.get("element_type")
        peers = by_position.get(position, [player])
        fixture_score = _fixture_score(player_copy)
        attacking_score = _weighted_percentile(
            player_copy, peers, ATTACKING_WEIGHTS.get(position, ATTACKING_WEIGHTS[3])
        )
        _, minutes_security = _minutes_profile(player_copy, reference_gameweek)
        chance_score = _chance_score(player_copy)
        context_score = _team_context_score(player_copy, players)
        player_copy["future_fpl_score"] = clamp(
            fixture_score * 0.40
            + attacking_score * 0.30
            + minutes_security * 0.20
            + context_score * 0.05
            + chance_score * 0.05
        )
        prepared_players.append(player_copy)

    prepared_by_position: dict[Any, list[dict[str, Any]]] = {}
    for player in prepared_players:
        prepared_by_position.setdefault(player.get("element_type"), []).append(player)

    rated_players = []
    for player in prepared_players:
        position = player.get("element_type")
        rated = _player_rating(
            player,
            prepared_by_position.get(position, [player]),
            prepared_players,
            reference_gameweek,
        )
        player_copy = dict(player)
        player_copy.update(rated)
        rated_players.append(player_copy)
    return rated_players