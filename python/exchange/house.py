"""The House: the site's own models, entered into the exchange as a syndicate.

The CBB board, the NBA game projections and the NHL simulation already produce an expected margin and total for every game on the site. The
house reads those straight from the database (read-only) and the exchange treats them like any other syndicate's view: the model weight is
earned from settled games, so the exchange becomes a live, market-priced test of whether the site's models beat DraftKings.

Site game ids encode the ESPN id: NBA -(8e9 + espn), CBB -(7e9 + espn), NHL -(5e9 + espn).
"""
from __future__ import annotations

SITE = {"nba": 8_000_000_000, "cbb": 7_000_000_000, "nhl": 5_000_000_000}


def site_id(exchange_id: str) -> int | None:
    sport, _, eid = exchange_id.partition(":")
    return -(SITE[sport] + int(eid)) if sport in SITE and eid.isdigit() else None


def fetch(store, game_ids: list[str]) -> dict[str, list[float]]:
    """{exchange game id: [expected home margin, expected total]} for the games the site has a model view of."""
    c = getattr(store, "c", None)  # only the Supabase store can see the site's tables
    if c is None:
        return {}
    by_sport: dict[str, dict[int, str]] = {}
    for gid in game_ids:
        sid = site_id(gid)
        if sid is not None:
            by_sport.setdefault(gid.split(":")[0], {})[sid] = gid
    out: dict[str, list[float]] = {}
    for sport, ids in by_sport.items():
        keys = list(ids)
        for i in range(0, len(keys), 100):
            chunk = keys[i : i + 100]
            try:
                if sport == "nba":
                    rows = c.table("nba_game_projections").select("game_id,model:detail->model").in_("game_id", chunk).execute().data
                    vals = {r["game_id"]: (r["model"] or {}).get("margin") and [r["model"]["margin"], r["model"].get("total")] for r in rows if r.get("model")}
                elif sport == "cbb":
                    rows = c.table("cbb_game_board").select("game_id,model:payload->model").in_("game_id", chunk).execute().data
                    vals = {r["game_id"]: [r["model"]["spread"], r["model"].get("total")] for r in rows if r.get("model") and r["model"].get("spread") is not None}
                else:
                    rows = c.table("nhl_predictions").select("game_id,exp_home,exp_away,exp_total").in_("game_id", chunk).execute().data
                    vals = {r["game_id"]: [float(r["exp_home"]) - float(r["exp_away"]), float(r["exp_total"])] for r in rows}
            except Exception:  # a missing table or a bad row should not stop a round; the house just abstains on those games
                continue
            for sid, v in vals.items():
                if v and v[0] is not None and v[1] is not None:
                    out[ids[sid]] = [float(v[0]), float(v[1])]
    return out
