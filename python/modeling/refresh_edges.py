"""
Lightweight edge refresh - the fast half of predict_week1.py's top-15
FBS-vs-FBS strategy, split out so alerts can fire promptly on pure market
movement without paying for a full model retrain every time.

predict_week1.py does two genuinely different things on one schedule:
(1) train the margin model and compute predicted_margin per team-matchup -
    slow (a full HistGradientBoostingRegressor fit on 11 seasons), but also
    barely changes hour to hour (team ratings/roster/coaching data don't
    move that fast) - runs every 4h via predict-week1.yml.
(2) compare that predicted_margin to the CURRENT market line and alert on
    a newly-top-15 edge - cheap (a couple of DB reads, no ML), and the one
    that actually needs to be fresh, since the market moves continuously.

This script is just (2), reusing whatever predicted_margin the last full
predict_week1.py run computed. Safe to run every ~15 minutes, matching
poll_lines.py's own cadence (see poll-refresh-edges.yml) - there's no point
checking more often than the market data itself updates.

Trade-off: does NOT regenerate the free-text rationale (that needs the
full per-team feature set predict_week1.py builds, not just a market
lookup) - the rationale sentence can reference a market number that's
since drifted a point or two until the next full predict_week1.py run.
The MARKET/MODEL/EDGE numbers shown everywhere on the site stay fully
live regardless, since those come straight from this refresh.

Usage:
    python -m modeling.refresh_edges
"""
from __future__ import annotations

from cfbd_ingest.supabase_client import fetch_all, get_client

from .predict_week1 import MODEL_VERSION, TOP_N, _current_market_line, _suggested_units


def run() -> None:
    client = get_client()

    predictions = fetch_all("predictions", "game_id,predicted_margin,rationale", model_version=MODEL_VERSION)
    if not predictions:
        print("No existing predictions to refresh - run predict_week1 first.")
        return

    game_ids = [p["game_id"] for p in predictions]
    games = client.table("games").select("id,completed").in_("id", game_ids).execute().data
    completed_ids = {g["id"] for g in games if g["completed"]}
    live = [p for p in predictions if p["game_id"] not in completed_ids]
    if not live:
        print("Every game with a prediction has already completed - nothing to refresh.")
        return

    market = _current_market_line([p["game_id"] for p in live])

    # Same edge-bucket/reference-win-rate lookup as predict_week1.py's own
    # run() - cheap DB reads, not part of the expensive retrain.
    edge_bucket_rows = fetch_all("model_backtests", "label,n,win_rate", model_version=MODEL_VERSION, group_key="edge_bucket")
    edge_buckets: list[tuple[float, float, float, int]] = []
    for r in edge_bucket_rows:
        lo_str, _, hi_str = r["label"].partition("-")
        lo = float(lo_str.rstrip("+"))
        hi = float(hi_str) if hi_str else float("inf")
        edge_buckets.append((lo, hi, r["win_rate"], r["n"]))
    edge_buckets.sort()

    matchup_type_rows = fetch_all("model_backtests", "label,win_rate", model_version=MODEL_VERSION, group_key="matchup_type")
    reference_win_rate = next((r["win_rate"] for r in matchup_type_rows if r["label"] == "fbs_vs_fbs"), None)

    records = []
    for p in live:
        game_id = p["game_id"]
        m = market.get(game_id)
        if m is None:
            continue  # no current market line on file for this game yet - leave its stored row untouched
        edge = p["predicted_margin"] + m  # market_spread convention: edge_spread = predicted_margin - (-market_spread)
        records.append(
            {
                "game_id": game_id,
                "model_version": MODEL_VERSION,
                "market_spread": m,
                "edge_spread": edge,
                "suggested_units": _suggested_units(abs(edge), edge_buckets, reference_win_rate),
                "rationale": p["rationale"],  # unchanged - carried through so send_new_edge_alerts has text to send
            }
        )

    if not records:
        print("No games have a current market line to refresh against.")
        return

    for i in range(0, len(records), 500):
        client.table("predictions").upsert(records[i : i + 500], on_conflict="game_id,model_version").execute()
    print(f"Refreshed {len(records)} prediction(s) against the current market.")

    ranked = sorted(records, key=lambda r: abs(r["edge_spread"]), reverse=True)
    top_game_ids = {int(r["game_id"]) for r in ranked[:TOP_N]}

    from alerts.telegram_alerts import send_new_edge_alerts  # local import - avoid a hard dependency at module load for callers that don't need alerting

    n_alerted = send_new_edge_alerts(client, MODEL_VERSION, records, top_game_ids)
    if n_alerted:
        print(f"Sent {n_alerted} new Telegram edge alert(s).")


if __name__ == "__main__":
    run()
