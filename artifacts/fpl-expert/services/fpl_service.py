import json
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FPL_BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"


class FPLDataError(Exception):
    """Raised when the live FPL data cannot be fetched or understood."""


@dataclass(frozen=True)
class FPLBootstrap:
    players: list[dict[str, Any]]
    teams: list[dict[str, Any]]
    positions: list[dict[str, Any]]


def fetch_bootstrap_data() -> FPLBootstrap:
    request = Request(
        FPL_BOOTSTRAP_URL,
        headers={
            "Accept": "application/json",
            "User-Agent": "FPL-Expert/1.0",
        },
    )

    try:
        with urlopen(request, timeout=12) as response:
            payload = json.load(response)
    except HTTPError as error:
        raise FPLDataError(
            f"The FPL service returned HTTP {error.code}."
        ) from error
    except (URLError, TimeoutError, json.JSONDecodeError, OSError) as error:
        raise FPLDataError(
            "The FPL service could not be reached right now."
        ) from error

    if not isinstance(payload, dict):
        raise FPLDataError("The FPL service returned an unexpected response.")

    players = payload.get("elements")
    teams = payload.get("teams")
    positions = payload.get("element_types")
    if not isinstance(players, list) or not isinstance(teams, list) or not isinstance(
        positions, list
    ):
        raise FPLDataError("The FPL service returned incomplete player data.")

    team_names = {
        team.get("id"): team.get("name", "Unknown")
        for team in teams
        if isinstance(team, dict)
    }
    team_short_names = {
        team.get("id"): team.get("short_name", "")
        for team in teams
        if isinstance(team, dict)
    }
    position_names = {
        position.get("id"): position.get("singular_name", "Unknown")
        for position in positions
        if isinstance(position, dict)
    }
    position_short_names = {
        position.get("id"): position.get("singular_name_short", "")
        for position in positions
        if isinstance(position, dict)
    }

    normalized_players = []
    for player in players:
        if not isinstance(player, dict):
            continue
        player_copy = dict(player)
        player_copy["team_name"] = team_names.get(player.get("team"), "Unknown")
        player_copy["team_short_name"] = team_short_names.get(player.get("team"), "")
        player_copy["position_name"] = position_names.get(
            player.get("element_type"), "Unknown"
        )
        player_copy["position_short_name"] = position_short_names.get(
            player.get("element_type"), ""
        )
        normalized_players.append(player_copy)

    return FPLBootstrap(
        players=normalized_players,
        teams=[team for team in teams if isinstance(team, dict)],
        positions=[position for position in positions if isinstance(position, dict)],
    )


def number_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def filter_and_sort_players(
    players: list[dict[str, Any]],
    *,
    name: str = "",
    team: str = "",
    position: str = "",
    sort_by: str = "total_points",
    order: str = "desc",
) -> list[dict[str, Any]]:
    name_query = name.strip().casefold()
    allowed_sort_fields = {
        "now_cost",
        "total_points",
        "form",
        "goals_scored",
        "assists",
        "bonus",
        "selected_by_percent",
    }
    if sort_by not in allowed_sort_fields:
        sort_by = "total_points"
    if order not in {"asc", "desc"}:
        order = "desc"

    filtered_players = [
        player
        for player in players
        if (not name_query or name_query in player.get("web_name", "").casefold())
        and (not team or str(player.get("team", "")) == team)
        and (not position or str(player.get("element_type", "")) == position)
    ]
    return sorted(
        filtered_players,
        key=lambda player: number_value(player.get(sort_by)),
        reverse=order == "desc",
    )