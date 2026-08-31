import os

from flask import Flask, render_template, request

from services.fpl_service import (
    FPLDataError,
    filter_and_sort_players,
    fetch_bootstrap_data,
)

app = Flask(__name__)


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/players")
def players():
    name = request.args.get("name", "")
    team = request.args.get("team", "")
    position = request.args.get("position", "")
    sort_by = request.args.get("sort", "total_points")
    order = request.args.get("order", "desc")

    try:
        bootstrap = fetch_bootstrap_data()
        filtered_players = filter_and_sort_players(
            bootstrap.players,
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)