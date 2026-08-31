import os

from flask import Flask, render_template, request
from werkzeug.exceptions import NotFound

from services.fpl_service import (
    FPLDataError,
    FPLTeamError,
    add_fixture_data,
    add_history_team_names,
    filter_and_sort_players,
    fetch_bootstrap_data,
    fetch_fixtures,
    fetch_player_summary,
    fetch_team_data,
)
from services.rating_engine import add_ratings
from services.team_analyzer import analyze_squad, import_squad

app = Flask(__name__)


@app.template_filter("display")
def display(value):
    return "—" if value is None or value == "" else value


@app.template_filter("decimal")
def decimal(value, places=1):
    if value is None or value == "":
        return "—"
    try:
        return f"{float(value):.{int(places)}f}"
    except (TypeError, ValueError):
        return value


@app.template_filter("price")
def price(value):
    if value is None or value == "":
        return "—"
    try:
        return f"£{float(value) / 10:.1f}"
    except (TypeError, ValueError):
        return "—"


@app.template_filter("percent")
def percent(value):
    if value is None or value == "":
        return "—"
    return f"{value}%"


@app.get("/")
def home():
    return render_template("index.html")


def team_summary(entry: dict, gameweek: int) -> dict:
    return {
        "manager_name": " ".join(
            part
            for part in (
                entry.get("player_first_name"),
                entry.get("player_last_name"),
            )
            if part
        ),
        "team_name": entry.get("name"),
        "overall_rank": entry.get("summary_overall_rank"),
        "total_points": entry.get("summary_overall_points"),
        "gameweek": gameweek,
        "bank": entry.get("last_deadline_bank"),
        "squad_value": entry.get("last_deadline_value"),
    }


def live_rated_players(recent_history_by_player=None):
    bootstrap = fetch_bootstrap_data()
    fixtures = fetch_fixtures()
    enriched_players = add_fixture_data(
        bootstrap.players,
        fixtures,
        bootstrap.teams,
        bootstrap.reference_gameweek,
    )
    rated_players = add_ratings(
        enriched_players,
        reference_gameweek=bootstrap.reference_gameweek,
        recent_history_by_player=recent_history_by_player,
    )
    return bootstrap, rated_players


@app.get("/players")
def players():
    name = request.args.get("name", "")
    team = request.args.get("team", "")
    position = request.args.get("position", "")
    sort_by = request.args.get("sort", "total_points")
    order = request.args.get("order", "desc")

    try:
        bootstrap, enriched_players = live_rated_players()
        filtered_players = filter_and_sort_players(
            enriched_players,
            name=name,
            team=team,
            position=position,
            sort_by=sort_by,
            order=order,
        )
        return render_template(
            "players.html",
            players=filtered_players,
            teams=bootstrap.teams,
            positions=bootstrap.positions,
            filters={
                "name": name,
                "team": team,
                "position": position,
                "sort": sort_by,
                "order": order,
            },
            error=None,
        )
    except FPLDataError as error:
        return render_template(
            "players.html",
            players=[],
            teams=[],
            positions=[],
            filters={
                "name": name,
                "team": team,
                "position": position,
                "sort": sort_by,
                "order": order,
            },
            error=str(error),
        ), 502


@app.get("/my-team")
def my_team():
    team_id_input = request.args.get("team_id", "").strip()
    page_data = {
        "team_id": team_id_input,
        "error": None,
        "error_category": None,
        "summary": None,
        "groups": [],
        "analysis": None,
        "squad_count": 0,
    }

    if team_id_input:
        if not team_id_input.isdigit() or int(team_id_input) <= 0:
            page_data.update(
                error="Enter a positive numeric FPL Team ID.",
                error_category="invalid",
            )
        else:
            try:
                bootstrap, rated_players = live_rated_players()
                team_data = fetch_team_data(
                    int(team_id_input), bootstrap.reference_gameweek
                )
                squad = import_squad(team_data, rated_players)
                if not squad:
                    raise FPLTeamError(
                        "The current squad is not available for this FPL Team ID.",
                        "squad_unavailable",
                    )
                analysis = analyze_squad(squad)
                page_data.update(
                    summary=team_summary(
                        team_data["entry"], team_data["gameweek"]
                    ),
                    groups=analysis["groups"],
                    analysis=analysis,
                    squad_count=len(squad),
                )
            except FPLTeamError as error:
                page_data.update(
                    error=str(error),
                    error_category=error.category,
                )
            except FPLDataError as error:
                page_data.update(
                    error=str(error),
                    error_category="unavailable",
                )

    return render_template("my_team.html", **page_data)


@app.get("/player/<int:player_id>")
def player_detail(player_id: int):
    try:
        bootstrap = fetch_bootstrap_data()
        if not any(
            player.get("id") == player_id for player in bootstrap.players
        ):
            raise NotFound

        summary = fetch_player_summary(player_id)
        history = [
            item for item in summary.get("history", []) if isinstance(item, dict)
        ]
        history = add_history_team_names(history, bootstrap.teams)
        history.sort(key=lambda item: item.get("round") or 0, reverse=True)

        bootstrap, rated_players = live_rated_players(
            recent_history_by_player={player_id: history}
        )
        player = next(
            (item for item in rated_players if item.get("id") == player_id), None
        )
        if player is None:
            raise NotFound

        return render_template(
            "player_detail.html",
            player=player,
            history=history,
            error=None,
        )
    except NotFound:
        return render_template(
            "player_detail.html",
            player=None,
            history=[],
            error="That player could not be found in the live FPL data.",
        ), 404
    except FPLDataError as error:
        return render_template(
            "player_detail.html",
            player=None,
            history=[],
            error=str(error),
        ), 502


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)