"""
Publishes the NHL model's per-game output to Supabase for the site:

  nhl_predictions   upcoming games - win probability, expected score, the full
                    total-goals / margin distributions and both score grids,
                    the goalie assumptions, DraftKings' current line, and the
                    simulation inputs (`sim_params`) the site uses to re-run a
                    game instantly when you lock in a goalie
  nhl_game_xg       finished games - xG for/against (even strength / power
                    play), shots

Run from the repo's python/ directory AFTER the local data is current (see
daily.py, which does the whole chain). Everything heavy (history, ratings fit,
simulation) stays local; only these small tables ever reach the database.

WHO'S IN NET, in order of authority:
  1. a manual lock (nhl_goalie_locks, set from the game page)       -> certain
  2. ESPN's "Probable Starting Goalie" when its status is Confirmed -> certain
  3. ESPN's goalie when its status is Expected                      -> 75%, with
     our own usage-based pick (below) taking the other 25%
  4. our usage-based pick - who started each team's last 10 games, the
     previous starter discounted on a back-to-back                   -> used only
     when ESPN lists nobody
ESPN's status flips Expected -> Confirmed when a team announces, so each refresh
picks that up. Why ESPN outranks our guess: early in a season "who started the
last 10 games" still reflects last year's roster and misses off-season goalie
moves - it disagreed with ESPN's projection on ~44% of teams.

A goalie ESPN names that we've never seen in net (a rookie or call-up) is
simulated as a league-average goalie, flagged as such.

Usage:
    python -m nhl_model.publish --dry-run         # print what would be written
    python -m nhl_model.publish                   # write to Supabase
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import unicodedata

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
PROBABLES_FORWARD_CSV = DATA_DIR / "goalie_probables_forward.csv"
BACK_TO_BACK_HOURS = 40.0
BACK_TO_BACK_REPEAT_WEIGHT = 0.3  # chance multiplier for repeating last night's starter on a back-to-back
ESPN_EXPECTED_WEIGHT = 0.75  # how much an "Expected" (not Confirmed) ESPN goalie is trusted
DIRECTORY_GAMES = 1500  # how many recent games' rosters to scan for goalie names


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


def _dig(d, *path):
    for k in path:
        d = (d or {}).get(k) if isinstance(d, dict) else None
    return d


def parse_market(o: dict) -> dict:
    ml, ps, tot = o.get("moneyline") or {}, o.get("pointSpread") or {}, o.get("total") or {}
    return {
        "provider": (o.get("provider") or {}).get("name"),
        "ml_home": _odds(_dig(ml, "home", "close", "odds")), "ml_away": _odds(_dig(ml, "away", "close", "odds")),
        "ml_home_open": _odds(_dig(ml, "home", "open", "odds")), "ml_away_open": _odds(_dig(ml, "away", "open", "odds")),
        "spread_home_line": _line(_dig(ps, "home", "close", "line")),
        "spread_home_odds": _odds(_dig(ps, "home", "close", "odds")), "spread_away_odds": _odds(_dig(ps, "away", "close", "odds")),
        "total_line": _line(_dig(tot, "over", "close", "line")),
        "over_odds": _odds(_dig(tot, "over", "close", "odds")), "under_odds": _odds(_dig(tot, "under", "close", "odds")),
        "total_open": _line(_dig(tot, "over", "open", "line")),
    }


def parse_probable(competitor: dict) -> dict | None:
    """ESPN's probable starting goalie for one side, with its Expected/Confirmed status."""
    for p in competitor.get("probables") or []:
        if p.get("name") == "probableStartingGoalie" and p.get("athlete"):
            return {"name": p["athlete"]["displayName"], "espn_id": p["athlete"].get("id"), "status": (p.get("status") or {}).get("type", "expected")}
    return None


def espn_events(days: list[dt.date]) -> list[dict]:
    out = []
    for day in days:
        data = _get_json(ESPN_SB, {"dates": day.strftime("%Y%m%d")}) or {}
        for e in data.get("events", []):
            comp = e["competitions"][0]
            hc = next(c for c in comp["competitors"] if c["homeAway"] == "home")
            ac = next(c for c in comp["competitors"] if c["homeAway"] == "away")
            odds = (comp.get("odds") or [None])[0]
            out.append({
                "espn_id": e["id"], "start": pd.Timestamp(e["date"]),
                "home": ESPN_TO_NHL_ABBREV.get(hc["team"]["abbreviation"], hc["team"]["abbreviation"]),
                "away": ESPN_TO_NHL_ABBREV.get(ac["team"]["abbreviation"], ac["team"]["abbreviation"]),
                "state": e["status"]["type"]["state"], "market": parse_market(odds) if odds else None,
                "goalies": {"home": parse_probable(hc), "away": parse_probable(ac)},
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

def _norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", s)).strip()


def goalie_directory(games: pd.DataFrame) -> tuple[dict[float, str], dict[str, float]]:
    """(id -> name, normalized name -> id) for every goalie dressed in recent games - the bridge
    between ESPN's names and NHL player ids (which our goalie ratings are keyed on)."""
    id_to_name: dict[float, str] = {}
    for r in games.sort_values("t").tail(DIRECTORY_GAMES).itertuples():
        path = RAW_PBP / str(int(r.season_year)) / f"{int(r.game_id)}.json.gz"
        if not path.exists():
            continue
        for p in read_gz(path).get("rosterSpots", []):
            if p.get("positionCode") == "G":
                id_to_name[p["playerId"]] = f"{p['firstName']['default']} {p['lastName']['default']}"
    return id_to_name, {_norm(n): i for i, n in id_to_name.items()}


def recent_starters(games: pd.DataFrame, team_id: int, now: pd.Timestamp, k: int = 10) -> list[tuple[float, pd.Timestamp]]:
    h = games[games["home_team_id"] == team_id][["t", "home_goalie"]].rename(columns={"home_goalie": "g"})
    a = games[games["away_team_id"] == team_id][["t", "away_goalie"]].rename(columns={"away_goalie": "g"})
    t = pd.concat([h, a]).dropna().sort_values("t")
    t = t[t["t"] < now].tail(k)
    return list(zip(t["g"], t["t"]))


def usage_candidates(starters: list[tuple[float, pd.Timestamp]], now: pd.Timestamp) -> list[tuple[float, float]]:
    """[(goalie_id, probability)] for the two most likely starters by recent usage."""
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


def side_scenarios(espn_g: dict | None, usage: list[tuple[float, float]], lock_id, name_to_id: dict, id_to_name: dict) -> tuple[list[tuple], str, bool]:
    """-> ([(goalie_id|None, name, weight)], source, confirmed) for one side of one game."""
    nm = lambda gid: id_to_name.get(gid, str(int(gid)))  # noqa: E731
    if lock_id is not None:
        if int(lock_id) == 0:
            return [(None, "Other (league-average goalie)", 1.0)], "locked", True
        return [(float(lock_id), nm(float(lock_id)), 1.0)], "locked", True
    if espn_g is not None:
        gid = name_to_id.get(_norm(espn_g["name"]))
        name = espn_g["name"] if gid is None else nm(gid)
        if espn_g["status"] == "confirmed":
            return [(gid, name, 1.0)], "espn_confirmed", True
        alt = next((g for g, _ in usage if g != gid), None)
        if alt is None:
            return [(gid, name, 1.0)], "espn_expected", False
        return [(gid, name, ESPN_EXPECTED_WEIGHT), (alt, nm(alt), 1.0 - ESPN_EXPECTED_WEIGHT)], "espn_expected", False
    return [(g, nm(g), w) for g, w in usage], "usage", False


# ------------------------------------------------------------------ predict

def simulate_mixture(fit, tb, home_id: int, away_id: int, home_s, away_s, tracker, now) -> dict:
    combos = [(gh, ga, wh * wa) for gh, _, wh in (home_s or [(None, "", 1.0)]) for ga, _, wa in (away_s or [(None, "", 1.0)])]
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


def _estimated(espn_g, usage, name_to_id, id_to_name, tracker, now) -> dict:
    scen, src, conf = side_scenarios(espn_g, usage, None, name_to_id, id_to_name)
    return {
        "goalies": [{"id": int(g) if g is not None else None, "name": n, "weight": round(w, 3), "rating": round(tracker.rating(g, now), 3)} for g, n, w in scen],
        "source": src, "confirmed": conf,
    }


def tables_json(tb) -> dict:
    return {
        "pen_minor": tb.pen_minor, "pen_double": tb.pen_double, "pen_major": tb.pen_major,
        "late": {str(m): {"pairs": pairs.tolist(), "cum": [round(float(c), 6) for c in cum]} for m, (pairs, cum) in tb.late.items()},
        "p_ot": tb.p_ot, "home_ot": tb.home_ot, "home_so": tb.home_so,
    }


def prediction_row(our_id: int, s: dict, assumptions: dict, sim_params: dict, market: dict | None, now: pd.Timestamp) -> dict:
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
        "assumptions": assumptions, "sim_params": sim_params, "market": {**market, "fetched_at": now.isoformat()} if market else None,
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

    # manual locks (set from the game page) - read-only here; missing table just means none yet
    client = None
    locks: dict[int, dict] = {}
    try:
        from cfbd_ingest.supabase_client import get_client

        client = get_client()
        locks = {r["game_id"]: r for r in client.table("nhl_goalie_locks").select("*").execute().data}
    except Exception as e:  # noqa: BLE001 - locks are optional; never block a refresh on them
        print(f"(no goalie locks read: {str(e)[:80]})")

    tb = load_tables()
    tracker, gr = build_tracker(GOALIE_PRIOR_ATTEMPTS)
    tg = load_sim_team_games(gr)
    fit = fit_block(tg, now, SimConfig(use_goalie=True), tb)
    if fit is None:
        raise SystemExit("not enough history to fit")
    print(f"fit as of {now:%Y-%m-%d %H:%M}Z: goalie beta {fit.beta:+.3f}, power-play scale {fit.pp_scale:.3f}, conv {fit.conv:.3f}")
    id_to_name, name_to_id = goalie_directory(games)
    tables = tables_json(tb)

    preds, snapshots, probable_rows = [], [], []
    team_ids = set(upcoming["home_team_id"]) | set(upcoming["away_team_id"])
    usage = {t: usage_candidates(recent_starters(games, int(t), now), now) for t in team_ids}
    pool_ids = {t: [g for g, _ in recent_starters(games, int(t), now, k=30)] for t in team_ids}
    for r in upcoming.sort_values("t").itertuples():
        ev = up_map.get(int(r.game_id))
        if ev is None:
            continue
        our_id = _nhl_game_id(ev["espn_id"])
        lock = locks.get(our_id, {})
        sides, assumptions_goalies, sources, confirmed, pool = {}, {}, {}, {}, {}
        for side, team in (("home", r.home_team_id), ("away", r.away_team_id)):
            scen, src, conf = side_scenarios(ev["goalies"][side], usage.get(team, []), lock.get(f"{side}_goalie_id"), name_to_id, id_to_name)
            sides[side] = scen
            assumptions_goalies[side] = [{"id": int(g) if g is not None else None, "name": n, "weight": round(w, 3), "rating": round(tracker.rating(g, now), 3)} for g, n, w in scen]
            sources[side], confirmed[side] = src, conf
            seen, plist = set(), []
            for g in [s[0] for s in scen] + list(dict.fromkeys(pool_ids.get(team, []))):
                if g is None or g in seen:
                    continue
                seen.add(g)
                plist.append({"id": int(g), "name": id_to_name.get(g, str(int(g))), "rating": round(tracker.rating(g, now), 3)})
            pool[side] = plist
            if ev["goalies"][side]:
                probable_rows.append({"captured_at": now.isoformat(), "game_id": our_id, "side": side, "name": ev["goalies"][side]["name"], "status": ev["goalies"][side]["status"]})

        s = simulate_mixture(fit, tb, int(r.home_team_id), int(r.away_team_id), sides["home"], sides["away"], tracker, now)
        base = fit.params(int(r.home_team_id), int(r.away_team_id), fit.gbar, fit.gbar)  # goalie-neutral rates
        sim_params = {
            "rates": {"r_ev_h": base.r_ev_h, "r_ev_a": base.r_ev_a, "r_pp_h": base.r_pp_h, "r_pp_a": base.r_pp_a, "pens_h": base.pens_h,
                      "pens_a": base.pens_a, "r_sh": base.r_sh, "conv": fit.conv, "beta": fit.beta, "gbar": fit.gbar},
            "tables": tables, "pool": pool,
            # what a refresh would assume with NO manual lock - restored when a lock is removed
            "estimated": {side: _estimated(ev["goalies"][side], usage.get(team, []), name_to_id, id_to_name, tracker, now)
                          for side, team in (("home", r.home_team_id), ("away", r.away_team_id))},
        }
        assumptions = {"goalies": assumptions_goalies, "goalie_confirmed": all(confirmed.values()), "sources": sources, "confirmed": confirmed, "pool": pool}
        row = prediction_row(our_id, s, assumptions, sim_params, ev["market"], now)
        row["_label"] = f"{r.away_abbrev} @ {r.home_abbrev}"
        row["_goalies"] = f"{assumptions_goalies['away'][0]['name'] if assumptions_goalies['away'] else '?'} ({sources['away']}) v {assumptions_goalies['home'][0]['name'] if assumptions_goalies['home'] else '?'} ({sources['home']})"
        preds.append(row)
        if ev["market"]:
            snapshots.append({"captured_at": now.isoformat(), "espn_id": ev["espn_id"], "game_id": our_id, "home": r.home_abbrev, "away": r.away_abbrev, **ev["market"]})

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

    # archive locally: market lines (a free, growing closing-line history - the last snapshot before kickoff is the
    # close) and ESPN's goalie calls (to measure later how often "expected"/"confirmed" matches who actually played)
    if snapshots:
        pd.DataFrame(snapshots).to_csv(ODDS_FORWARD_CSV, mode="a", header=not ODDS_FORWARD_CSV.exists(), index=False)
    if probable_rows:
        pd.DataFrame(probable_rows).to_csv(PROBABLES_FORWARD_CSV, mode="a", header=not PROBABLES_FORWARD_CSV.exists(), index=False)

    print(f"\n{'game':<10}{'P(home)':>8}{'exp score':>12}{'exp tot':>8}  goalies (away v home)")
    for p in preds:
        print(f"{p['_label']:<10}{p['p_home']:>8.3f}{p['exp_home']:>6.2f}-{p['exp_away']:<5.2f}{p['exp_total']:>8.2f}  {p['_goalies']}")
    n_conf = sum(1 for p in preds for v in p["assumptions"]["confirmed"].values() if v)
    print(f"\n{len(preds)} predictions ({n_conf}/{2 * len(preds)} goalie slots confirmed or locked), {len(xg_rows)} xG rows, "
          f"{len(snapshots)} market snapshots, {len(probable_rows)} ESPN goalie calls archived")

    for p in preds:
        p.pop("_label", None)
        p.pop("_goalies", None)
    (DATA_DIR / "last_publish.json").write_text(json.dumps({"predictions": preds, "xg": xg_rows}))
    if a.dry_run:
        print("dry run - nothing written to Supabase (payload saved to data/nhl/last_publish.json)")
        return

    if client is None:
        from cfbd_ingest.supabase_client import get_client

        client = get_client()
    known = {r["id"] for r in client.table("games").select("id").eq("sport", "nhl").execute().data}
    preds_w = [p for p in preds if p["game_id"] in known]
    xg_w = [x for x in xg_rows if x["game_id"] in known]
    if preds_w:
        try:
            client.table("nhl_predictions").upsert(preds_w, on_conflict="game_id").execute()
        except Exception as e:  # noqa: BLE001
            if "sim_params" not in str(e):
                raise
            print("!! nhl_predictions has no sim_params column yet - run the SQL migration to enable goalie locking. Writing without it for now.")
            client.table("nhl_predictions").upsert([{k: v for k, v in p.items() if k != "sim_params"} for p in preds_w], on_conflict="game_id").execute()
    if xg_w:
        client.table("nhl_game_xg").upsert(xg_w, on_conflict="game_id").execute()
    print(f"wrote {len(preds_w)} predictions and {len(xg_w)} xG rows ({len(preds) - len(preds_w)} predictions skipped: game not in our games table)")


if __name__ == "__main__":
    main()
