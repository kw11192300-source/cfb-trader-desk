"""
In-season "wait for confirmation" watchlist - a SECOND, separate, much
more exploratory signal from predict_week1.py's validated top-15 strategy.
Do not confuse the two; see alerts/telegram_alerts.py's module docstring
on why they're deliberately kept apart.

Backtest finding this is built on (2016-2025, walk-forward, post-week-1
FBS-vs-FBS - i.e. games where BOTH teams have already played at least once
this season): the model's raw top-15-by-edge picks are ~break-even on
their own (53-56% ATS, both closing- and opening-line versions) - edge
size alone carries no real signal once a team has played, unlike week 1.
BUT splitting that same pool by whether the closing line later moved
toward the model's side shows a real, meaningful split: 64.4% ATS when
confirmed vs. 41.4% when it wasn't (n=74, correlation +0.40). Confirmation
- not edge size - is the signal post-week-1.

This module turns that finding into a live workflow: flag a candidate the
moment it clears CANDIDATE_EDGE_THRESHOLD (just a noise floor, not itself
predictive - see above), pin the line at that moment as reference_spread,
and alert only once the CURRENT line has moved CONFIRM_MOVE_THRESHOLD
points toward the pick. Both thresholds are judgment calls, not fit to
data (the backtest used ANY positive movement, which is too noisy a bar
for a real alert) - same "one constant, deliberately easy to change
later" spirit as predict_week1.py's KELLY_FRACTION.

Caveat worth repeating from the diagnostic that found this: n=74 is a
thin sample, the underlying mechanism (why does confirmed movement
predict outcome, when edge size alone doesn't?) isn't understood, and this
was found by looking at closing lines in hindsight - turning "CLV
correlates with winning" into "alert the moment it's confirmed, then bet"
is a genuinely different, not-yet-separately-validated claim. Treat this
as exploratory until it has its own live track record.

Usage:
    python -m modeling.watchlist
"""
from __future__ import annotations

import datetime

import pandas as pd

from cfbd_ingest.supabase_client import get_client

from .features import BOOK_PREFERENCE, build_live_features, build_training_dataset
from .outcome_models import predict_margin, train_margin_model
from .predict_week1 import _pick_spread_view

MODEL_VERSION = "inseason_watch_v1"

# Noise floor before a game is worth watching at all - NOT itself a
# predictive threshold (the backtest found edge size doesn't matter
# post-week-1), just filters out negligible mispricings.
CANDIDATE_EDGE_THRESHOLD = 3.0
# Points of favorable movement, from the reference line, required to fire
# an alert - small enough to catch real confirmation, large enough to
# filter ordinary bid-ask noise between books/polls.
CONFIRM_MOVE_THRESHOLD = 1.0
# Only watch games this close - keeps build_live_features in the
# near-term territory it's actually meant for, and matches how this
# project is actually used (bet early in the week, not a month out).
WATCH_WINDOW_DAYS = 9


def _current_market_line(client, game_ids: list[int]) -> dict[int, float]:
    """Same convention as predict_week1.py's version (freshest captured
    spread, BOOK_PREFERENCE order) - duplicated rather than imported since
    predict_week1's is a local function, not part of its public surface."""
    if not game_ids:
        return {}
    rows = client.table("betting_lines").select("game_id,provider,spread,fetched_at").in_("game_id", game_ids).execute().data
    if not rows:
        return {}
    df = pd.DataFrame(rows).dropna(subset=["spread"])
    if df.empty:
        return {}
    df["book_rank"] = df["provider"].apply(lambda p: BOOK_PREFERENCE.index(p) if p in BOOK_PREFERENCE else len(BOOK_PREFERENCE))
    df = df.sort_values(["game_id", "book_rank", "fetched_at"], ascending=[True, True, False])
    best = df.drop_duplicates("game_id", keep="first")
    return dict(zip(best["game_id"], best["spread"]))


def _build_watchlist_rationale(pick_name: str, opp_name: str, pick_market: float, pick_model: float, edge: float) -> str:
    """Deliberately simpler than predict_week1.py's _build_rationale - this
    signal isn't about preseason continuity (talent/returning production/
    coaching), it's in-season performance the model has already absorbed
    into its rating features. Citing those directly would just restate the
    edge number in different words."""
    market_str = f"{pick_market:+.1f}" if pick_market >= 0 else f"{pick_market:.1f}"
    model_str = f"{pick_model:+.1f}" if pick_model >= 0 else f"{pick_model:.1f}"
    return (
        f"Market has {pick_name} at {market_str}; model has {pick_name} at {model_str} - a {edge:.1f}-point edge, "
        f"based on in-season performance to date. Exploratory in-season signal (n=74 backtest) - watching for the "
        f"market to confirm before this is worth acting on, see /watchlist."
    )


def run() -> None:
    year = datetime.date.today().year
    client = get_client()
    now = datetime.datetime.now(datetime.timezone.utc)

    print(f"Loading upcoming post-week-1 FBS-vs-FBS games for {year}...")
    live = build_live_features(year)
    if live.empty:
        print("No live feature rows yet.")
        return
    live["min_games"] = live[["home_games_played", "away_games_played"]].min(axis=1)
    live = live[live["min_games"] > 0].copy()
    if live.empty:
        print("No post-week-1 games yet (still in week 1 everywhere).")
        return

    from cfbd_ingest.supabase_client import fetch_all

    meta = pd.DataFrame(fetch_all("games", "id,home_team,away_team,start_date")).set_index("id")
    live = live.merge(meta, left_on="game_id", right_index=True)
    live["start_date"] = pd.to_datetime(live["start_date"], utc=True)
    horizon = now + datetime.timedelta(days=WATCH_WINDOW_DAYS)
    live = live[(live["start_date"] > now) & (live["start_date"] <= horizon)].copy()
    if live.empty:
        print(f"No post-week-1 games within the {WATCH_WINDOW_DAYS}-day watch window.")
        return
    print(f"{len(live)} candidate games in window.")

    market = _current_market_line(client, live["game_id"].tolist())
    live = live[live["game_id"].isin(market.keys())].copy()
    if live.empty:
        print("None of these games have a market line posted yet.")
        return
    live["current_spread"] = live["game_id"].map(market)

    print("Training margin model on completed seasons through last year...")
    train_df = build_training_dataset(list(range(year - 11, year)))
    model = train_margin_model(train_df)
    live["predicted_margin"] = predict_margin(model, live)
    live["market_implied_margin"] = -live["current_spread"]
    live["edge"] = live["predicted_margin"] - live["market_implied_margin"]
    live["pick_home"] = live["edge"] > 0

    existing = (
        client.table("watchlist_picks")
        .select("id,game_id,pick_home,reference_spread,rationale,alert_sent_at")
        .eq("model_version", MODEL_VERSION)
        .execute()
        .data
    )
    existing_by_game = {r["game_id"]: r for r in existing}

    new_rows = []
    update_rows = []
    confirmed_rows = []
    for _, r in live.iterrows():
        gid = int(r["game_id"])
        cur = float(r["current_spread"])
        pred = float(r["predicted_margin"])
        edge = float(r["edge"])
        pick_home = bool(r["pick_home"])
        existing_row = existing_by_game.get(gid)

        if existing_row is None:
            if abs(edge) < CANDIDATE_EDGE_THRESHOLD:
                continue
            pick_name = r["home_team"] if pick_home else r["away_team"]
            opp_name = r["away_team"] if pick_home else r["home_team"]
            pick_mkt, pick_mdl = _pick_spread_view(cur, pred, pick_home)
            rationale = _build_watchlist_rationale(pick_name, opp_name, pick_mkt, pick_mdl, abs(edge))
            new_rows.append(
                {
                    "game_id": gid,
                    "model_version": MODEL_VERSION,
                    "season": int(r["season"]),
                    "week": int(r["week"]),
                    "pick_team": pick_name,
                    "pick_home": pick_home,
                    "predicted_margin": pred,
                    "edge": abs(edge),
                    "rationale": rationale,
                    "reference_spread": cur,
                    "current_spread": cur,
                    "current_edge": abs(edge),
                    "move_toward_pick": 0.0,
                }
            )
            continue

        if existing_row["alert_sent_at"] is not None:
            continue  # already fired - leave it alone, don't keep updating a resolved row

        ref = existing_row["reference_spread"]
        # Pick side is fixed at discovery time (existing_row["pick_home"]) -
        # use that, not whatever this run's edge sign says, for direction.
        move = (ref - cur) if existing_row["pick_home"] else (cur - ref)
        update_rows.append({"id": existing_row["id"], "current_spread": cur, "current_edge": abs(edge), "move_toward_pick": move})
        if move >= CONFIRM_MOVE_THRESHOLD:
            confirmed_rows.append(
                {"id": existing_row["id"], "rationale": existing_row["rationale"], "reference_spread": ref, "current_spread": cur, "move_toward_pick": move}
            )

    if new_rows:
        for i in range(0, len(new_rows), 500):
            client.table("watchlist_picks").insert(new_rows[i : i + 500]).execute()
        print(f"Added {len(new_rows)} new watchlist candidate(s).")

    for u in update_rows:
        client.table("watchlist_picks").update(
            {"current_spread": u["current_spread"], "current_edge": u["current_edge"], "move_toward_pick": u["move_toward_pick"]}
        ).eq("id", u["id"]).execute()
    if update_rows:
        print(f"Refreshed {len(update_rows)} active watchlist row(s).")

    if confirmed_rows:
        from alerts.telegram_alerts import send_watchlist_confirmation_alerts

        n = send_watchlist_confirmation_alerts(client, MODEL_VERSION, confirmed_rows)
        if n:
            print(f"Sent {n} watchlist confirmation alert(s).")


if __name__ == "__main__":
    run()
