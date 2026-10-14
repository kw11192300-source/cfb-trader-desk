"""
Publishes the CBB ratings to Supabase (small tables only - the raw play-by-play never leaves this machine).

  cbb_team_ratings   one row per team per (season, kind): 'preseason' (roster-based projection for the coming season) and
                     'final' (last season's end-of-season adjusted ratings). stats is jsonb so columns can grow without migrations.

Usage:
    python -m cbb_model.publish ratings --season 2026           # preseason projection from ESPN's current rosters + last season's final
    python -m cbb_model.publish ratings --season 2026 --dry-run
"""
from __future__ import annotations

import argparse
import json

import pandas as pd

from .bpm import PLAYER_SEASONS_OUT, TARGETS_OUT, per40
from .ingest import DATA_DIR
from .parse import TEAM_GAMES_OUT
from .preseason import current_rosters, preseason_ratings


def build_rows(season: int) -> list[dict]:
    ps40 = per40(pd.read_csv(PLAYER_SEASONS_OUT))
    tgt = pd.read_csv(TARGETS_OUT)
    roster = current_rosters(season)
    pre = preseason_ratings(season, ps40, tgt, roster=roster)
    if pre is None:
        raise SystemExit("not enough history for a preseason projection")
    teams = pd.read_csv(DATA_DIR / "teams.csv").drop_duplicates("id").set_index("id")["name"]
    conf = pd.read_csv(DATA_DIR / "conferences.csv")
    conf = conf[conf["season"] == conf["season"].max()].set_index("team_id")
    last = tgt[tgt["season"] == season - 1].set_index("team_id")
    tg = pd.read_csv(TEAM_GAMES_OUT)
    rec = tg[tg["season"] == season - 1].assign(w=lambda d: (d["pts"] > d["opp_pts"]).astype(int)).groupby("team_id").agg(w=("w", "sum"), g=("w", "size"))
    coach = roster.drop_duplicates("team_id").set_index("team_id")["coach"] if not roster.empty else pd.Series(dtype=object)
    roster_n = roster.groupby("team_id").size() if not roster.empty else pd.Series(dtype=int)
    mu = float(last["mu"].mean()) if len(last) else 106.0

    now = pd.Timestamp.now(tz="UTC").isoformat()
    rows: list[dict] = []
    ranked = sorted(pre.off, key=lambda t: -(pre.off[t] - pre.de[t]))
    rank_of = {t: i + 1 for i, t in enumerate(ranked)}
    for t in ranked:
        net = pre.off[t] - pre.de[t]
        prior_net = float(last.loc[t, "off"] - last.loc[t, "de"]) if t in last.index else None
        rows.append(
            {
                "season": season, "team_id": int(t), "kind": "preseason", "team": teams.get(t, str(t)),
                "conference": conf["conference"].get(t), "updated_at": now,
                "stats": {
                    "rank": rank_of[t], "off": round(mu + pre.off[t], 2), "def": round(mu + pre.de[t], 2), "net": round(net, 2), "tempo": round(pre.tempo[t], 2),
                    "last_net": None if prior_net is None else round(prior_net, 2),
                    "change": None if prior_net is None else round(net - prior_net, 2),
                    "coach": coach.get(t),
                    "roster_n": int(roster_n.get(t, 0)),
                },
            }
        )
    # last season's final ratings
    fr = sorted(last.index, key=lambda t: -(last.loc[t, "off"] - last.loc[t, "de"]))
    for i, t in enumerate(fr):
        w = rec.loc[t, "w"] if t in rec.index else None
        g = rec.loc[t, "g"] if t in rec.index else None
        rows.append(
            {
                "season": season - 1, "team_id": int(t), "kind": "final", "team": teams.get(t, str(t)),
                "conference": conf["conference"].get(t), "updated_at": now,
                "stats": {
                    "rank": i + 1, "off": round(float(last.loc[t, "mu"] + last.loc[t, "off"]), 2), "def": round(float(last.loc[t, "mu"] + last.loc[t, "de"]), 2),
                    "net": round(float(last.loc[t, "off"] - last.loc[t, "de"]), 2), "tempo": round(float(last.loc[t, "tempo"]), 2),
                    "wins": None if w is None else int(w), "losses": None if g is None or w is None else int(g - w),
                },
            }
        )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["ratings"])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    rows = build_rows(a.season)
    pre = [r for r in rows if r["kind"] == "preseason"]
    print(f"{len(pre)} preseason rows, {len(rows) - len(pre)} final rows")
    for r in pre[:15]:
        s = r["stats"]
        print(f"  {s['rank']:>3} {r['team']:<28} net {s['net']:+6.1f} (off {s['off']:.1f}, def {s['def']:.1f}, tempo {s['tempo']:+.1f}) last {s['last_net']}  {r['conference']}")
    if a.dry_run:
        (DATA_DIR / "last_publish_ratings.json").write_text(json.dumps(rows, default=str))
        print("dry run - nothing written")
        return
    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    for i in range(0, len(rows), 300):
        client.table("cbb_team_ratings").upsert(rows[i : i + 300], on_conflict="season,team_id,kind").execute()
    print(f"published {len(rows)} rows to cbb_team_ratings")


if __name__ == "__main__":
    main()
