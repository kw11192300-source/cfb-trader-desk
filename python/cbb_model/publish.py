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
from .overrides import apply as apply_overrides
from .preseason import current_rosters, preseason_ratings, value_weights


def build_rows(season: int) -> list[dict]:
    ps40 = per40(pd.read_csv(PLAYER_SEASONS_OUT))
    tgt = pd.read_csv(TARGETS_OUT)
    roster = current_rosters(season)
    teams = pd.read_csv(DATA_DIR / "teams.csv").drop_duplicates("id").set_index("id")["name"]
    listed = roster.groupby("team_id").size()  # what ESPN lists, before hand-entered changes
    roster, extras, notes = apply_overrides(roster, ps40, teams, value_weights(ps40, tgt, season), season - 1)
    from .recruits import recruit_extras

    roster, extras, rnotes = recruit_extras(roster, extras, season, set(ps40[ps40["season"] == season - 1]["player_id"]))
    for n in notes + rnotes:
        print("  override:", n)
    pre = preseason_ratings(season, ps40, tgt, roster=roster, extras=extras)
    if pre is None:
        raise SystemExit("not enough history for a preseason projection")
    manual = extras.groupby("team_id").size() if len(extras) else pd.Series(dtype=int)
    conf = pd.read_csv(DATA_DIR / "conferences.csv")
    conf = conf[conf["season"] == conf["season"].max()].set_index("team_id")
    last = tgt[tgt["season"] == season - 1].set_index("team_id")
    # the rating pool includes non-D1 opponents (all far weaker), so D1 teams average well above zero; centre on D1 so
    # last season's numbers read on the same scale as the preseason projection and as KenPom-style ratings
    d1 = last[last.index.isin(conf.index)]
    last = last.assign(off=last["off"] - d1["off"].mean(), de=last["de"] - d1["de"].mean())
    tg =pd.read_csv(TEAM_GAMES_OUT)
    rec = tg[tg["season"] == season - 1].assign(w=lambda d: (d["pts"] > d["opp_pts"]).astype(int)).groupby("team_id").agg(w=("w", "sum"), g=("w", "size"))
    # hand-added roster rows carry no coach: take each team's first listed one
    coach = roster.dropna(subset=["coach"]).drop_duplicates("team_id").set_index("team_id")["coach"] if not roster.empty else pd.Series(dtype=object)
    roster_n = roster.groupby("team_id").size() if not roster.empty else pd.Series(dtype=int)
    listed_n = listed
    mu = float(last["mu"].mean()) if len(last) else 106.0
    mu_t = float(tg[tg["season"] == season - 1]["tempo"].mean()) if len(tg) else 68.5
    hca = 2.5  # per side, per 100 possessions (ratings.Config.hca_prior)

    now = pd.Timestamp.now(tz="UTC").isoformat()
    rows: list[dict] = []
    ranked = sorted(pre.off, key=lambda t: -(pre.off[t] - pre.de[t]))
    rank_of = {t: i + 1 for i, t in enumerate(ranked)}
    # last season's rank among the same D1 teams (ranks compare across seasons; the nets are on different scales because a
    # projection is compressed toward average)
    last_order = sorted((t for t in last.index if t in conf.index), key=lambda t: -(last.loc[t, "off"] - last.loc[t, "de"]))
    last_rank = {t: i + 1 for i, t in enumerate(last_order)}
    for t in ranked:
        net = pre.off[t] - pre.de[t]
        prior_net = float(last.loc[t, "off"] - last.loc[t, "de"]) if t in last.index else None
        rows.append(
            {
                "season": season, "team_id": int(t), "kind": "preseason", "team": teams.get(t, str(t)),
                "conference": conf["conference"].get(t), "updated_at": now,
                "stats": {
                    "rank": rank_of[t], "off": round(mu + pre.off[t], 2), "def": round(mu + pre.de[t], 2), "net": round(net, 2), "tempo": round(pre.tempo[t], 2),
                    "mu": round(mu, 2), "hca": hca, "mu_t": round(mu_t, 2),
                    "last_net": None if prior_net is None else round(prior_net, 2),
                    "last_rank": last_rank.get(t),
                    "rank_change": None if t not in last_rank else last_rank[t] - rank_of[t],  # + = moved up the rankings
                    "coach": coach.get(t),
                    "roster_n": int(roster_n.get(t, 0)) + int(manual.get(t, 0)),
                    "roster_listed": int(listed_n.get(t, 0)),
                    "manual_adds": int(manual.get(t, 0)),
                    "incomplete": 1 if int(roster_n.get(t, 0)) + int(manual.get(t, 0)) < 11 else 0,
                },
            }
        )
    # last season's final ratings
    fr = sorted((t for t in last.index if t in conf.index), key=lambda t: -(last.loc[t, "off"] - last.loc[t, "de"]))  # D1 teams only
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

    def clean(v):  # JSON has no NaN: a missing value goes in as null
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, float) and v != v:
            return None
        return v

    rows = [clean(r) for r in rows]
    client = get_client()
    for i in range(0, len(rows), 300):
        client.table("cbb_team_ratings").upsert(rows[i : i + 300], on_conflict="season,team_id,kind").execute()
    print(f"published {len(rows)} rows to cbb_team_ratings")


if __name__ == "__main__":
    main()
