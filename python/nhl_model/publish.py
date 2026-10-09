"""
Publishes the NHL model's per-game output to Supabase for the site:

  nhl_predictions   upcoming games - win probability, expected score, the full
                    total-goals / margin distributions and both score grids,
                    the goalie assumptions, and DraftKings' current line
  nhl_game_xg       finished games - xG for/against (even strength / power
                    play), shots

Run from the repo's python/ directory AFTER the local data is current (see
daily.py, which does the whole chain). Everything heavy (history, ratings fit,
simulation) stays local; only these two small tables ever reach the database.

Goalie assumption - the starter isn't confirmed until game day, so each team's
likely starter comes from who actually started its last 10 games, with the
previous starter's weight cut hard when the team played within ~40 hours (a
back-to-back usually means the backup). The two most likely goalies per team
are simulated together, weighted by those odds. `goalie_confirmed` is false for
everything this writes; a confirmed-starter feed would flip it.

Usage:
    python -m nhl_model.publish --dry-run         # print what would be written
    python -m nhl_model.publish                   # write to Supabase
"""
from __future__ import annotations

import argparse
import datetime as dt
import json

import numpy as np
import pandas as pd

from cfbd_ingest.sync_nhl_espn import _nhl_game_id

from .goalie_model import build_tracker
from .ingest import DATA_DIR, ESPN_SB, ESPN_TO_NHL_ABBREV, RAW_PBP, SCHEDULE_CSV, _get_json, read_gz
from .parse import GAMES_OUT
from .sim import SimConfig, load_tables, simulate, summarize_sim
from .sim_backtest import GOALIE_PRIOR_ATTEMPTS, fit_block, load_sim_team_games
from .team_games import TEAM_GAMES_OUT

MODEL_VERSION = "nhl_sim_v1"
N_SIMS = 40000
ODDS_FORWARD_CSV = DATA_DIR / "odds_forward.csv"
BACK_TO_BACK_HOURS = 40.0
BACK_TO_BACK_REPEAT_WEIGHT = 0.3  # chance multiplier for repeating last night's starter on a back-to-back


# ---------------------------------------------------------------- ESPN mapping

def _line(s: str | None) -> float | None:
    """'o6.5' / 'u6.5' / '-1.5' -> float."""
    if not s:
        return None
    try:
        return float(str(s).lstrip("ou"))
    except ValueError:
        return None


def _odds(s: str | None) -> int | None:
    try:
        return int(float(str(s).replace("+", "")))
    except (TypeError, ValueError):
        return None


def parse_market(o: dict) -> dict:
    ml, ps, tot = o.get("moneyline") or {}, o.get("pointSpread") or {}, o.get("total") or {}
    g = lambda d, *path: _dig(d, *path)  # noqa: E731
    return {
        "provider": (o.get("provider") or {}).get("name"),
        "ml_home": _odds(g(ml, "home", "close", "odds")), "ml_away": _odds(g(ml, "away", "close", "odds")),
        "ml_home_open": _odds(g(ml, "home", "open", "odds")), "ml_away_open": _odds(g(ml, "away", "open", "odds")),
        "spread_home_line": _line(g(ps, "home", "close", "line")),
        "spread_home_odds": _odds(g(ps, "home", "close", "odds")), "spread_away_odds": _odds(g(ps, "away", "close", "odds")),
        "total_line": _line(g(tot, "over", "close", "line")),
        "over_odds": _odds(g(tot, "over", "close", "odds")), "under_odds": _odds(g(tot, "under", "close", "odds")),
        "total_open": _line(g(tot, "over", "open", "line")),
    }


def _dig(d, *path):
    for k in path:
        d = (d or {}).get(k) if isinstance(d, dict) else None
    return d


def espn_events(days: list[dt.date]) -> list[dict]:
    out = []
    for day in days:
        data = _get_json(ESPN_SB, {"dates": day.strftime("%Y%m%d")}) or {}
        for e in data.get("events", []):
            comp = e["competitions"][0]
            home = next(c for c in comp["competitors"] if c["homeAway"] == "home")["team"]["abbreviation"]
            away = next(c for c in comp["competitors"] if c["homeAway"] == "away")["team"]["abbreviation"]
            odds = (comp.get("odds") or [None])[0]
            out.append({
                "espn_id": e["id"], "start": pd.Timestamp(e["date"]),
                "home": ESPN_TO_NHL_ABBREV.get(home, home), "away": ESPN_TO_NHL_ABBREV.get(away, away),
                "state": e["status"]["type"]["state"], "market": parse_market(odds) if odds else None,
            })
    return out


def match_events(sched_rows: pd.DataFrame, events: list[dict]) -> dict[int, dict]:
    """NHL-API game id -> ESPN event, by home/away teams and start time within 6h."""
    out = {}
    for r in sched_rows.itertuples():
        start = pd.Timestamp(r.start_utc)
        best = None
        for e in events:
            if e["home"] == r.home_abbrev and e["away"] == r.away_abbrev:
                d = abs((e["start"] - start).total_seconds())
                if d <= 6 * 3600 and (best is None or d < best[0]):
                    best = (d, e)
        if best:
            out[int(r.game_id)] = best[1]
    return out


# ---------------------------------------------------------------- goalies

def recent_starters(games: pd.DataFrame, team_id: int, now: pd.Timestamp, k: int = 10) -> list[tuple[float, pd.Timestamp]]:
    h = games[games["home_team_id"] == team_id][["t", "home_goalie"]].rename(columns={"home_goalie": "g"})
    a = games[games["away_team_id"] == team_id][["t", "away_goalie"]].rename(columns={"away_goalie": "g"})
    t = pd.concat([h, a]).dropna().sort_values("t")
    t = t[t["t"] < now].tail(k)
    return list(zip(t["g"], t["t"]))


def candidates(starters: list[tuple[float, pd.Timestamp]], now: pd.Timestamp) -> list[tuple[float, float]]:
    """[(goalie_id, probability)] for the two most likely starters."""
    if not starters:
        return []
    w: dict[float, float] = {}
    for g, _ in starters:
        w[g] = w.get(g, 0.0) + 1.0
    last_g, last_t = starters[-1]
    if (now - last_t).total_seconds() / 3600.0 < BACK_TO_BACK_HOURS:
        w[last_g] *= BACK_TO_BACK_REPEAT_WEIGHT
    top = sorted(w.items(), key=lambda kv: -kv[1])[:2]
    tot = sum(v for _, v in top)
    return [(g, v / tot) for g, v in top]


def goalie_names(goalie_ids: set[float], games: pd.DataFrame, team_ids: set[int]) -> dict[float, str]:
    """Names from the roster of recent games' raw play-by-play."""
    names: dict[float, str] = {}
    sub = games[games["home_team_id"].isin(team_ids) | games["away_team_id"].isin(team_ids)].sort_values("t", ascending=False)
    for r in sub.itertuples():
        if goalie_ids <= set(names):
            break
        path = RAW_PBP / str(int(r.season_year)) / f"{int(r.game_id)}.json.gz"
        if not path.exists():
            continue
        for p in read_gz(path).get("rosterSpots", []):
            if p["playerId"] in goalie_ids and p["playerId"] not in names:
                names[p["playerId"]] = f"{p['firstName']['default']} {p['lastName']['default']}"
    return names


# ------------------------------------------------------------------ predict

def simulate_mixture(fit, tb, home_id: int, away_id: int, home_c, away_c, tracker, now) -> dict:
    combos = [(gh, ga, wh * wa) for gh, wh in (home_c or [(None, 1.0)]) for ga, wa in (away_c or [(None, 1.0)])]
    counts = [int(N_SIMS * w) for _, _, w in combos]
    counts[int(np.argmax([w for _, _, w in combos]))] += N_SIMS - sum(counts)
    parts = []
    for i, ((gh, ga, _), n) in enumerate(zip(combos, counts)):
        if n <= 0:
            continue
        gp = fit.params(home_id, away_id, tracker.rating(gh, now), tracker.rating(ga, now))
        parts.append(simulate(gp, tb, n, seed=(home_id * 31 + away_id * 7 + i) % 2_000_000_011))
    merged = {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}
    return summarize_sim(merged, with_grids=True)


def prediction_row(our_id: int, s: dict, goalies: dict, market: dict | None, now: pd.Timestamp) -> dict:
    grid = lambda pre: [[round(s[f"{pre}_{h}_{a}"], 5) for a in range(10)] for h in range(10)]  # noqa: E731
    return {
        "game_id": our_id, "model_version": MODEL_VERSION, "generated_at": now.isoformat(),
        "p_home": round(s["p_home"], 5), "p_home_reg": round(s["p_home_reg"], 5), "p_tie_reg": round(s["p_tie_reg"], 5),
        "p_shootout": round(s["p_shootout"], 5),
        "exp_home": round(s["exp_home"], 3), "exp_away": round(s["exp_away"], 3), "exp_total": round(s["exp_total_final"], 3),
        "total_dist": {str(k): round(s[f"pt_{k}"], 5) for k in range(17)},
        "margin_dist": {str(k): round(s[f"pm_{k}"], 5) for k in range(-8, 9)},
        "score_matrix": grid("sc"), "score_matrix_reg": grid("rc"),
        "extras": {
            "reg_total_dist": {str(k): round(s[f"pr_{k}"], 5) for k in range(17)},
            "ot_total_dist": {str(k): round(s[f"po_{k}"], 5) for k in range(17)},
            "exp_total_reg": round(s["exp_total_reg"], 3),
            "n_sims": N_SIMS,
        },
        "assumptions": {"goalies": goalies, "goalie_confirmed": False},
        "market": market,
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--horizon-days", type=int, default=4)
    ap.add_argument("--xg-days", type=int, default=10)
    a = ap.parse_args(argv)

    now = pd.Timestamp.now(tz="UTC")
    sched = pd.read_csv(SCHEDULE_CSV)
    sched["t"] = pd.to_datetime(sched["start_utc"], utc=True)
    games = pd.read_csv(GAMES_OUT, usecols=["game_id", "season", "start_utc", "home_team_id", "away_team_id", "home_goalie", "away_goalie"])
    games["t"] = pd.to_datetime(games["start_utc"], utc=True)
    games["season_year"] = games["season"] // 10000

    upcoming = sched[(sched["t"] > now) & (sched["t"] <= now + pd.Timedelta(days=a.horizon_days)) & sched["game_state"].isin(["FUT", "PRE"])]
    recent = sched[(sched["t"] >= now - pd.Timedelta(days=a.xg_days)) & (sched["t"] <= now) & sched["game_state"].isin(["FINAL", "OFF"])]
    print(f"{len(upcoming)} upcoming games in the next {a.horizon_days} days; {len(recent)} finished in the last {a.xg_days} days")

    days = sorted({(t + pd.Timedelta(hours=-5)).date() for t in pd.concat([upcoming["t"], recent["t"]])})
    events = espn_events(days)
    up_map, rec_map = match_events(upcoming, events), match_events(recent, events)
    print(f"matched {len(up_map)}/{len(upcoming)} upcoming and {len(rec_map)}/{len(recent)} finished games to ESPN events")

    tb = load_tables()
    tracker, gr = build_tracker(GOALIE_PRIOR_ATTEMPTS)
    tg = load_sim_team_games(gr)
    fit = fit_block(tg, now, SimConfig(use_goalie=True), tb)
    if fit is None:
        raise SystemExit("not enough history to fit")
    print(f"fit as of {now:%Y-%m-%d %H:%M}Z: goalie beta {fit.beta:+.3f}, power-play scale {fit.pp_scale:.3f}, conv {fit.conv:.3f}")

    preds, snapshots = [], []
    team_ids = set(upcoming["home_team_id"]) | set(upcoming["away_team_id"])
    cands = {t: candidates(recent_starters(games, int(t), now), now) for t in team_ids}
    names = goalie_names({g for c in cands.values() for g, _ in c}, games, team_ids)
    for r in upcoming.sort_values("t").itertuples():
        ev = up_map.get(int(r.game_id))
        if ev is None:
            continue
        hc, ac = cands.get(r.home_team_id, []), cands.get(r.away_team_id, [])
        s = simulate_mixture(fit, tb, int(r.home_team_id), int(r.away_team_id), hc, ac, tracker, now)
        goalies = {side: [{"id": int(g), "name": names.get(g, str(int(g))), "weight": round(w, 3), "rating": round(tracker.rating(g, now), 3)} for g, w in c]
                   for side, c in (("home", hc), ("away", ac))}
        row = prediction_row(_nhl_game_id(ev["espn_id"]), s, goalies, ev["market"], now)
        row["_label"] = f"{r.away_abbrev} @ {r.home_abbrev}"
        preds.append(row)
        if ev["market"]:
            snapshots.append({"captured_at": now.isoformat(), "espn_id": ev["espn_id"], "game_id": row["game_id"], "home": r.home_abbrev, "away": r.away_abbrev, **ev["market"]})

    tgm = pd.read_csv(TEAM_GAMES_OUT)
    xg_rows = []
    for r in recent.itertuples():
        ev = rec_map.get(int(r.game_id))
        g = tgm[tgm["game_id"] == r.game_id]
        if ev is None or len(g) != 2:
            continue
        h, aw = g[g["is_home"] == 1].iloc[0], g[g["is_home"] == 0].iloc[0]
        f = lambda row, c: round(float(row[f"{c}_reg"] + row[f"{c}_ot"]), 3)  # noqa: E731
        xg_rows.append({
            "game_id": _nhl_game_id(ev["espn_id"]),
            "home_xg": f(h, "xg"), "away_xg": f(aw, "xg"),
            "home_xg_ev": round(float(h["xg_reg_ev"] + h["xg_ot_ev"]), 3), "away_xg_ev": round(float(aw["xg_reg_ev"] + aw["xg_ot_ev"]), 3),
            "home_xg_pp": round(float(h["xg_reg_pp"] + h["xg_ot_pp"]), 3), "away_xg_pp": round(float(aw["xg_reg_pp"] + aw["xg_ot_pp"]), 3),
            "home_sog": int(h["sog_for"]) if pd.notna(h["sog_for"]) else None, "away_sog": int(aw["sog_for"]) if pd.notna(aw["sog_for"]) else None,
            "home_corsi": int(h["corsi_for"]) if pd.notna(h["corsi_for"]) else None, "away_corsi": int(aw["corsi_for"]) if pd.notna(aw["corsi_for"]) else None,
            "model_version": MODEL_VERSION,
        })

    # archive the market lines locally - a free, growing closing-line history (the last snapshot before kickoff is the close)
    if snapshots:
        df = pd.DataFrame(snapshots)
        df.to_csv(ODDS_FORWARD_CSV, mode="a", header=not ODDS_FORWARD_CSV.exists(), index=False)

    print(f"\n{'game':<12}{'P(home)':>9}{'exp score':>13}{'exp total':>11}{'P(hm -1.5)':>12}{'  market (DK)':<26}")
    for p in preds:
        m = p["market"] or {}
        pm = p["margin_dist"]
        cover = sum(v for k, v in pm.items() if int(k) >= 2)
        mk = f"{m.get('ml_home')}/{m.get('ml_away')} tot {m.get('total_line')}" if m else "-"
        print(f"{p['_label']:<12}{p['p_home']:>9.3f}{p['exp_home']:>7.2f}-{p['exp_away']:<5.2f}{p['exp_total']:>11.2f}{cover:>12.3f}  {mk}")
    print(f"\n{len(preds)} predictions, {len(xg_rows)} xG rows, {len(snapshots)} market snapshots archived to {ODDS_FORWARD_CSV.name}")

    for p in preds:
        p.pop("_label", None)
    (DATA_DIR / "last_publish.json").write_text(json.dumps({"predictions": preds, "xg": xg_rows}))
    if a.dry_run:
        print("dry run - nothing written to Supabase (payload saved to data/nhl/last_publish.json)")
        return

    from cfbd_ingest.supabase_client import get_client

    client = get_client()
    known = {r["id"] for r in client.table("games").select("id").eq("sport", "nhl").execute().data}
    preds_w = [p for p in preds if p["game_id"] in known]
    xg_w = [x for x in xg_rows if x["game_id"] in known]
    if preds_w:
        client.table("nhl_predictions").upsert(preds_w, on_conflict="game_id").execute()
    if xg_w:
        client.table("nhl_game_xg").upsert(xg_w, on_conflict="game_id").execute()
    print(f"wrote {len(preds_w)} predictions and {len(xg_w)} xG rows ({len(preds) - len(preds_w)} predictions skipped: game not in our games table)")


if __name__ == "__main__":
    main()
