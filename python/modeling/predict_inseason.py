"""
Week-2+ "model view" - explicitly NOT a validated strategy. Backtested
(see backtest_raw_inseason.py) at a number close to break-even post-week-1
- shown for your own read, not a signal to size a bet on. Week 1 has its
own separate, actually-validated model (predict_week1.py); this exists
only because week 1 is a fundamentally different regime (no in-season
evidence yet) that model was built and proven for, and you asked for
*something* to look at once it ends each week.

Writes to `inseason_edges` - deliberately NOT `predictions`. The Board's
gold/validated-edge treatment for GameCard/BoardTable keys off "does a
predictions row exist for this game," with no per-model trust
distinction - putting this model's output there would visually announce
it as validated when it isn't. Only src/app/edges/page.tsx's separate,
plainly-labeled section reads this table.

Usage:
    python -m modeling.predict_inseason
"""
from __future__ import annotations

import datetime

import pandas as pd

from cfbd_ingest.supabase_client import get_client

from .features import build_live_features, build_training_dataset
from .outcome_models import predict_margin, train_margin_model
from .predict_week1 import _current_market_line

MODEL_VERSION = "inseason_raw_v1"


def _rationale(pick_team: str, opp_team: str, pick_view: float, edge: float) -> str:
    sign = "+" if pick_view > 0 else ""
    return (
        f"Model has {pick_team} at {sign}{pick_view:.1f} against {opp_team}, "
        f"{edge:.1f} points off the market's own number. Not a proven strategy "
        f"post-week-1 (see /backtest) - the model's independent view only."
    )


def run() -> None:
    year = datetime.date.today().year
    print(f"Building live in-season features for {year}...")
    live = build_live_features(year)
    if live.empty:
        print("No upcoming FBS-vs-FBS games found for this season yet.")
        return

    # Post-week-1 only - both teams have real in-season evidence. Week 1
    # already has its own validated, separate pipeline (predict_week1.py).
    live = live[(live["home_games_played"] >= 1) & (live["away_games_played"] >= 1)].copy()
    if live.empty:
        print("No post-week-1 upcoming games found (still week 1, or nothing synced yet).")
        return

    game_ids = live["game_id"].astype(int).tolist()
    games_meta = pd.DataFrame(
        get_client().table("games").select("id,start_date,completed,home_team,away_team").in_("id", game_ids).execute().data
    ).set_index("id")

    now = datetime.datetime.now(datetime.timezone.utc)
    not_started = {
        gid
        for gid in game_ids
        if gid in games_meta.index
        and not games_meta.loc[gid, "completed"]
        and datetime.datetime.fromisoformat(games_meta.loc[gid, "start_date"].replace("Z", "+00:00")) > now
    }
    live = live[live["game_id"].isin(not_started)].copy()
    if live.empty:
        print("Every post-week-1 game on file has already started or completed - nothing upcoming to predict.")
        return
    print(f"{len(live)} upcoming post-week-1 FBS-vs-FBS games.")

    # CFBD-outage fallback: build_live_features' own market_spread column
    # comes straight from betting_lines (CFBD only, features.py:164) - with
    # CFBD's monthly quota exhausted (confirmed live this session), that
    # column is empty for almost every current game. Overwrite it with the
    # same merged CFBD+Odds-API current line predict_week1.py/watchlist.py
    # each already rely on, or this ships silently broken.
    market = _current_market_line(game_ids)
    live = live[live["game_id"].isin(market.keys())].copy()
    if live.empty:
        print("None of these games have a current market line posted yet (checked both CFBD and Odds API).")
        return
    live["market_spread"] = live["game_id"].map(market)

    last_complete_season = year - 1
    print(f"Training the independent margin model ({2015}-{last_complete_season})...")
    train_df = build_training_dataset(list(range(2015, last_complete_season + 1)))
    model = train_margin_model(train_df)

    live["predicted_margin"] = predict_margin(model, live).to_numpy()
    live["edge_spread"] = live["predicted_margin"] - (-live["market_spread"])

    records = []
    for _, r in live.iterrows():
        gid = int(r["game_id"])
        meta = games_meta.loc[gid]
        pick_home = r["edge_spread"] > 0
        pick_team = meta["home_team"] if pick_home else meta["away_team"]
        opp_team = meta["away_team"] if pick_home else meta["home_team"]
        pick_view = r["predicted_margin"] if pick_home else -r["predicted_margin"]
        records.append(
            {
                "game_id": gid,
                "model_version": MODEL_VERSION,
                "predicted_margin": float(r["predicted_margin"]),
                "market_spread": float(r["market_spread"]),
                "edge_spread": float(r["edge_spread"]),
                "rationale": _rationale(pick_team, opp_team, pick_view, abs(r["edge_spread"])),
            }
        )

    client = get_client()
    for i in range(0, len(records), 500):
        client.table("inseason_edges").upsert(records[i : i + 500], on_conflict="game_id,model_version").execute()
    print(f"Wrote {len(records)} in-season edge(s) (model_version={MODEL_VERSION}).")


if __name__ == "__main__":
    run()
