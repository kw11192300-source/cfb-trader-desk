"""
In-season ratings: the preseason projection, updated by this season's results.

The roster-based preseason projection (cbb_team_ratings kind 'preseason') is the prior; every finished game of the season then
moves each team's offence, defence and tempo through the same ridge fit the backtests used (ratings.fit, recent games weighted
more, opponent-adjusted, home court). The output is published as kind 'current' - the rows the game board, the ratings page and
the movement model read once the season is under way.

Needs only the current season's games (a few MB of box scores a day), so it runs in GitHub Actions with a small cache:

    python -m cbb_model.inseason                    # ingest what finished, refit, publish
    python -m cbb_model.inseason --dry-run          # same, publish nothing
    python -m cbb_model.inseason --no-ingest        # refit from what is already on disk
"""
from __future__ import annotations

import argparse
import datetime as dt

import numpy as np
import pandas as pd

from . import ingest
from .ratings import Config, Ratings, fit

# how fast results take over from the preseason projection: the projection counts as lam_eff games of evidence (so ~50% weight
# after 6 games, ~25% after 20). Grid-tuned on 2022-25 against the closing lines: 0.5 -> 6 cut early-season distance from the close
# from 5.1 to 3.9 points; 15+ is worse, half-life barely matters.
CONFIG = Config(half_life_days=120.0, lam_eff=6.0, prior_keep=1.0)
MIN_GAMES = 50  # ratings.fit needs this many team-games before it will fit anything


def refresh_data(season: int) -> None:
    """Fetch the season's scoreboard days and box scores that are not on disk yet. The last few days are always refetched: a
    cached day keeps the 'not finished' flags it had when it was first read."""
    ingest.DATA_DIR.mkdir(parents=True, exist_ok=True)  # a clean runner has no data folder yet
    today = dt.date.today()
    for back in range(0, 4):
        p = ingest.RAW_SB / f"{today - dt.timedelta(days=back):%Y%m%d}.json.gz"
        if p.exists():
            p.unlink()
    ingest.ingest_schedule(season, season)
    ingest.ingest_games(season, season)


def team_games(season: int) -> pd.DataFrame:
    from .parse import build_team_and_player_games

    tg, _ = build_team_and_player_games(season)
    if tg.empty:
        return tg
    tg["start_utc"] = pd.to_datetime(tg["start_utc"], utc=True)
    return tg.sort_values(["start_utc", "event_id"]).reset_index(drop=True)


def prior_from_rows(rows: list[dict]) -> Ratings:
    s0 = rows[0]["stats"]
    mu, hca, mu_t = float(s0["mu"]), float(s0["hca"]), float(s0["mu_t"])
    ids = [int(r["team_id"]) for r in rows]
    return Ratings(
        off={int(r["team_id"]): float(r["stats"]["off"]) - mu for r in rows},
        de={int(r["team_id"]): float(r["stats"]["def"]) - mu for r in rows},
        tempo={int(r["team_id"]): float(r["stats"]["tempo"]) for r in rows},
        mu=mu, hca=hca, mu_t=mu_t, n_games={t: 0 for t in ids},
    )


def build_rows(season: int, pre_rows: list[dict], tg: pd.DataFrame, cfg: Config = CONFIG) -> list[dict] | None:
    prior = prior_from_rows(pre_rows)
    r = fit(tg, tg["start_utc"].max() + pd.Timedelta(minutes=1), cfg, prior=prior, season=season)
    if r is None:
        return None
    won = tg.assign(w=(tg["pts"] > tg["opp_pts"]).astype(int)).groupby("team_id").agg(w=("w", "sum"), g=("w", "size"))
    pre_by = {int(x["team_id"]): x for x in pre_rows}
    net, off_rel, de_rel = {}, {}, {}
    for t in pre_by:
        o = r.off.get(t, prior.off[t] * cfg.prior_keep) if t in r.off else prior.off[t]
        d = r.de.get(t, prior.de[t]) if t in r.de else prior.de[t]
        off_rel[t], de_rel[t] = float(o), float(d)
        net[t] = off_rel[t] - de_rel[t]
    # the fit's pool includes non-D1 opponents (all far weaker), so D1 teams average well above zero. Centre on D1 and move
    # the league constants by the same amount, so every projection (mu + off + def, tempo) comes out exactly as it did.
    played = [t for t in pre_by if t in r.off]
    a = float(np.mean([off_rel[t] for t in played])) if played else 0.0
    b = float(np.mean([de_rel[t] for t in played])) if played else 0.0
    c = float(np.mean([r.tempo[t] for t in played if t in r.tempo])) if played else 0.0
    for t in pre_by:
        off_rel[t] -= a
        de_rel[t] -= b
        net[t] = off_rel[t] - de_rel[t]
    mu_c = r.mu + a + b
    mu_t_c = r.mu_t + 2.0 * c
    order = sorted(net, key=lambda t: -net[t])
    rank = {t: i + 1 for i, t in enumerate(order)}
    now = pd.Timestamp.now(tz="UTC").isoformat()
    rows = []
    for t, pr in pre_by.items():
        ps = pr["stats"]
        pre_rank = ps.get("rank")
        rows.append(
            {
                "season": season, "team_id": t, "kind": "current", "team": pr["team"], "conference": pr.get("conference"), "updated_at": now,
                "stats": {
                    "rank": rank[t], "off": round(mu_c + off_rel[t], 2), "def": round(mu_c + de_rel[t], 2), "net": round(net[t], 2),
                    "tempo": round(float(r.tempo.get(t, prior.tempo[t])) - c, 2), "mu": round(mu_c, 2), "hca": round(r.hca, 2), "mu_t": round(mu_t_c, 2),
                    "games": int(r.n_games.get(t, 0)),
                    "wins": int(won.loc[t, "w"]) if t in won.index else 0,
                    "losses": int(won.loc[t, "g"] - won.loc[t, "w"]) if t in won.index else 0,
                    "last_rank": pre_rank, "rank_change": (pre_rank - rank[t]) if isinstance(pre_rank, (int, float)) else None,  # vs preseason
                    "pre_net": ps.get("net"), "school": ps.get("school"), "coach": ps.get("coach"),
                },
            }
        )
    return rows


def run(dry_run: bool = False, ingest_first: bool = True) -> None:
    from cfbd_ingest.supabase_client import get_client

    today = dt.date.today()
    season = ingest.season_of(today)
    client = get_client()
    pre = (
        client.table("cbb_team_ratings").select("team_id,team,conference,stats").eq("season", season).eq("kind", "preseason").limit(1000).execute().data or []
    )
    if not pre:
        raise SystemExit(f"no published preseason ratings for season {season}")
    if ingest_first:
        refresh_data(season)
    tg = team_games(season)
    n_games = tg["event_id"].nunique() if len(tg) else 0
    print(f"season {season}: {n_games:,} finished games with box scores")
    rows = build_rows(season, pre, tg) if len(tg) else None
    if rows is None:
        print(f"fewer than {MIN_GAMES} team-games so far - nothing to publish; the board keeps using the preseason ratings")
        return
    top = sorted(rows, key=lambda x: x["stats"]["rank"])[:10]
    for x in top:
        s = x["stats"]
        print(f"  {s['rank']:>3} {x['team']:<28} net {s['net']:+6.1f} (preseason {s['pre_net']:+.1f}, rank {s['last_rank']})  {s['wins']}-{s['losses']}")
    if dry_run:
        print("dry run - nothing written")
        return

    def clean(v):
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, float) and v != v:
            return None
        return v

    rows = [clean(x) for x in rows]
    for i in range(0, len(rows), 300):
        client.table("cbb_team_ratings").upsert(rows[i : i + 300], on_conflict="season,team_id,kind").execute()
    print(f"published {len(rows)} current ratings for {season}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-ingest", action="store_true")
    a = ap.parse_args()
    run(dry_run=a.dry_run, ingest_first=not a.no_ingest)


if __name__ == "__main__":
    main()
