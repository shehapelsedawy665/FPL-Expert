import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FPL_BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"
FPL_FIXTURES_URL = "https://fantasy.premierleague.com/api/fixtures/"
FPL_ELEMENT_SUMMARY_URL = (
    "https://fantasy.premierleague.com/api/element-summary/{player_id}/"
)
FPL_CACHE_TTL_SECONDS = 300
PLAYER_STATUS_LABELS = {
    "a": "Available",
    "d": "Doubtful",
    "i": "Injured",
    "n": "Not available",
    "s": "Suspended",
    "u": "Unavailable",
}


class FPLDataError(Exception):
    """Raised when the live FPL data cannot be fetched or understood."""


class TTLCache:
    """Small in-memory cache for the short-lived public FPL responses."""

    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._entries: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            created_at, value = entry
            if time.monotonic() - created_at >= self.ttl_seconds:
                self._entries.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._entries[key] = (time.monotonic(), value)


@dataclass(frozen=True)
class FPLBootstrap:
    players: list[dict[str, Any]]
    teams: list[dict[str, Any]]
    positions: list[dict[str, Any]]
    events: list[dict[str, Any]]
    reference_gameweek: int


_response_cache = TTLCache(FPL_CACHE_TTL_SECONDS)


def _fetch_json(url: str, label: str) -> Any:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "FPL-Expert/1.0",
        },
    )

    try:
        with urlopen(request, timeout=12) as response:
            return json.load(response)
    except HTTPError as error:
        raise FPLDataError(f"The {label} returned HTTP {error.code}.") from error
    except (URLError, TimeoutError, ValueError, OSError) as error:
        raise FPLDataError(f"The {label} could not be reached right now.") from error


def _reference_gameweek(events: list[dict[str, Any]]) -> int:
    current_event = next(
        (event.get("id") for event in events if event.get("is_current")), None
    )
    if isinstance(current_event, int):
        return current_event

    next_event = next(
        (event.get("id") for event in events if event.get("is_next")), None
    )
    if isinstance(next_event, int):
        return next_event

    unfinished_events = [
        event.get("id")
        for event in events
        if isinstance(event.get("id"), int) and not event.get("finished")
    ]
    if unfinished_events:
        return min(unfinished_events)
    return 1


def fetch_bootstrap_data() -> FPLBootstrap:
    cached = _response_cache.get("bootstrap")
    if cached is not None:
        return cached

    payload = _fetch_json(FPL_BOOTSTRAP_URL, "FPL bootstrap service")
    if not isinstance(payload, dict):
        raise FPLDataError("The FPL bootstrap service returned an unexpected response.")

    raw_players = payload.get("elements")
    raw_teams = payload.get("teams")
    raw_positions = payload.get("element_types")
    raw_events = payload.get("events")
    if not all(
        isinstance(value, list)
        for value in (raw_players, raw_teams, raw_positions, raw_events)
    ):
        raise FPLDataError("The FPL bootstrap service returned incomplete data.")

    teams = [team for team in raw_teams if isinstance(team, dict)]
    positions = [position for position in raw_positions if isinstance(position, dict)]
    events = [event for event in raw_events if isinstance(event, dict)]
    team_names = {
        team.get("id"): team.get("name", "Unknown")
        for team in teams
    }
    team_short_names = {
        team.get("id"): team.get("short_name", "")
        for team in teams
    }
    position_names = {
        position.get("id"): position.get("singular_name", "Unknown")
        for position in positions
    }
    position_short_names = {
        position.get("id"): position.get("singular_name_short", "")
        for position in positions
    }

    players = []
    for player in raw_players:
        if not isinstance(player, dict):
            continue
        player_copy = dict(player)
        team_id = player.get("team")
        position_id = player.get("element_type")
        player_copy.update(
            {
                "team_name": team_names.get(team_id, "Unknown"),
                "team_short_name": team_short_names.get(team_id, ""),
                "position_name": position_names.get(position_id, "Unknown"),
                "position_short_name": position_short_names.get(position_id, ""),
                "status_label": PLAYER_STATUS_LABELS.get(
                    player.get("status"), player.get("status", "Unknown")
                ),
                "transfers_in_gameweek": player.get("transfers_in_event"),
                "transfers_out_gameweek": player.get("transfers_out_event"),
            }
        )
        players.append(player_copy)

    bootstrap = FPLBootstrap(
        players=players,
        teams=teams,
        positions=positions,
        events=events,
        reference_gameweek=_reference_gameweek(events),
    )
    _response_cache.set("bootstrap", bootstrap)
    return bootstrap


def fetch_fixtures() -> list[dict[str, Any]]:
    cached = _response_cache.get("fixtures")
    if cached is not None:
        return cached

    payload = _fetch_json(FPL_FIXTURES_URL, "FPL fixtures service")
    if not isinstance(payload, list):
        raise FPLDataError("The FPL fixtures service returned an unexpected response.")

    fixtures = [fixture for fixture in payload if isinstance(fixture, dict)]
    _response_cache.set("fixtures", fixtures)
    return fixtures


def fetch_player_summary(player_id: int) -> dict[str, Any]:
    if player_id <= 0:
        raise FPLDataError("That player ID is not valid.")

    cache_key = f"element-summary:{player_id}"
    cached = _response_cache.get(cache_key)
    if cached is not None:
        return cached

    payload = _fetch_json(
        FPL_ELEMENT_SUMMARY_URL.format(player_id=player_id),
        "the player detail service",
    )
    if not isinstance(payload, dict):
        raise FPLDataError("The player detail service returned an unexpected response.")
    if not isinstance(payload.get("history"), list):
        raise FPLDataError("The player detail service returned incomplete history.")

    _response_cache.set(cache_key, payload)
    return payload


def number_value(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _average(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _kickoff_display(value: Any) -> str:
    if not value:
        return "TBC"
    try:
        kickoff = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return kickoff.strftime("%a %d %b")
    except ValueError:
        return "TBC"


def _fixture_for_team(
    fixture: dict[str, Any],
    team_id: int,
    team_lookup: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    home_team = fixture.get("team_h")
    away_team = fixture.get("team_a")
    if home_team == team_id:
        venue = "H"
        opponent_id = away_team
        difficulty = fixture.get("team_h_difficulty")
    elif away_team == team_id:
        venue = "A"
        opponent_id = home_team
        difficulty = fixture.get("team_a_difficulty")
    else:
        return None

    opponent = team_lookup.get(opponent_id, {})
    return {
        "id": fixture.get("id"),
        "gameweek": fixture.get("event"),
        "venue": venue,
        "opponent": opponent.get("name", "Unknown"),
        "opponent_short_name": opponent.get("short_name", ""),
        "difficulty": difficulty,
        "kickoff_time": fixture.get("kickoff_time"),
        "kickoff_display": _kickoff_display(fixture.get("kickoff_time")),
    }


def fixture_data_for_team(
    team_id: Any,
    fixtures: list[dict[str, Any]],
    teams: list[dict[str, Any]],
    reference_gameweek: int,
) -> dict[str, Any]:
    if not isinstance(team_id, int):
        return {
            "next_5_fixtures": [],
            "next_3_avg_difficulty": None,
            "next_5_avg_difficulty": None,
        }

    team_lookup = {
        team.get("id"): team
        for team in teams
        if isinstance(team.get("id"), int)
    }
    upcoming = []
    for fixture in fixtures:
        event = fixture.get("event")
        if (
            not isinstance(event, int)
            or event < reference_gameweek
            or fixture.get("finished")
        ):
            continue
        normalized = _fixture_for_team(fixture, team_id, team_lookup)
        if normalized is not None:
            upcoming.append(normalized)

    upcoming.sort(
        key=lambda fixture: (
            fixture.get("gameweek") or 999,
            fixture.get("kickoff_time") or "",
            fixture.get("id") or 0,
        )
    )

    gameweeks = [
        fixture["gameweek"]
        for fixture in upcoming
        if isinstance(fixture.get("gameweek"), int)
    ]
    first_gameweek = min(gameweeks) if gameweeks else reference_gameweek
    next_3_difficulties = [
        number_value(fixture.get("difficulty"))
        for fixture in upcoming
        if isinstance(fixture.get("gameweek"), int)
        and fixture["gameweek"] <= first_gameweek + 2
        and fixture.get("difficulty") is not None
    ]
    next_5_difficulties = [
        number_value(fixture.get("difficulty"))
        for fixture in upcoming[:5]
        if fixture.get("difficulty") is not None
    ]
    return {
        "next_5_fixtures": upcoming[:5],
        "next_3_avg_difficulty": _average(next_3_difficulties),
        "next_5_avg_difficulty": _average(next_5_difficulties),
    }


def add_fixture_data(
    players: list[dict[str, Any]],
    fixtures: list[dict[str, Any]],
    teams: list[dict[str, Any]],
    reference_gameweek: int,
) -> list[dict[str, Any]]:
    fixture_cache: dict[Any, dict[str, Any]] = {}
    enriched_players = []
    for player in players:
        player_copy = dict(player)
        team_id = player.get("team")
        if team_id not in fixture_cache:
            fixture_cache[team_id] = fixture_data_for_team(
                team_id, fixtures, teams, reference_gameweek
            )
        player_copy.update(fixture_cache[team_id])
        enriched_players.append(player_copy)
    return enriched_players


def add_history_team_names(
    history: list[dict[str, Any]], teams: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    team_lookup = {
        team.get("id"): team
        for team in teams
        if isinstance(team.get("id"), int)
    }
    enriched_history = []
    for item in history:
        item_copy = dict(item)
        opponent = team_lookup.get(item.get("opponent_team"), {})
        item_copy["opponent_name"] = opponent.get("name", item.get("opponent_team"))
        item_copy["opponent_short_name"] = opponent.get(
            "short_name", item.get("opponent_team")
        )
        enriched_history.append(item_copy)
    return enriched_history


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
        "expected_goals",
        "expected_assists",
        "ict_index",
        "points_per_game",
        "transfers_in_gameweek",
    }
    if sort_by not in allowed_sort_fields:
        sort_by = "total_points"
    if order not in {"asc", "desc"}:
        order = "desc"

    filtered_players = [
        player
        for player in players
        if (
            not name_query
            or name_query in str(player.get("web_name", "")).casefold()
            or name_query
            in f"{player.get('first_name', '')} {player.get('second_name', '')}".casefold()
        )
        and (not team or str(player.get("team", "")) == team)
        and (not position or str(player.get("element_type", "")) == position)
    ]
    return sorted(
        filtered_players,
        key=lambda player: number_value(player.get(sort_by)),
        reverse=order == "desc",
    )