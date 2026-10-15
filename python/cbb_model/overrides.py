"""
Hand-entered roster changes on top of ESPN's current rosters (python/cbb_model/roster_overrides.csv).

ESPN's rosters fill in late and in both directions: a team can still list a player who entered the portal, and not yet list
its incoming transfers, international signees or freshmen. This file is how the preseason model learns about them before
the feed does. One row per player:

  team        ESPN's full team name ("St. John's Red Storm")
  player      the player's name
  action      add | remove
  kind        (add) transfer | intl | pro | fr | jc  - what the player is
  from_team   (transfer) the college he played for last season - his box-score line is looked up by name
  net_value   (add, optional) points per 100 possessions he is worth vs an average D1 player; blank = the default for his kind
  floor_share (add, optional) share of the team's floor time he should get, 0-1 (0.5 = 20 minutes a game); blank = default
  note, source  free text for you

Defaults come from history: a first-year player's value is the average of newcomers who actually earned rotation minutes,
internationals/pros are one notch better than that, and a transfer from a college keeps the value of his old box-score line
(then the preseason model discounts or boosts it by how the move changes the level of competition).
"""
from __future__ import annotations

import re
import unicodedata

import numpy as np
import pandas as pd

from .ingest import DATA_DIR

from pathlib import Path

OVERRIDES_CSV = Path(__file__).resolve().parent / "roster_overrides.csv"

DEFAULT_SHARE = {"fr": 0.35, "intl": 0.50, "pro": 0.55, "jc": 0.40, "transfer": 0.45}
KIND_BONUS = {"fr": 0.0, "jc": 0.0, "intl": 1.0, "pro": 1.5, "transfer": 0.0}  # net points per 100 over the newcomer average


def norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", s)
    return re.sub(r"[^a-z]", "", s)


TRANSFERS_CSV = Path(__file__).resolve().parent / "transfers_2026.csv"
GAP_CSV = Path(__file__).resolve().parent / "roster_gap.csv"


def load() -> pd.DataFrame:
    cols = ["team", "player", "action", "kind", "from_team", "net_value", "floor_share", "note", "source"]
    ov = pd.read_csv(OVERRIDES_CSV, comment="#") if OVERRIDES_CSV.exists() else pd.DataFrame(columns=cols)
    if TRANSFERS_CSV.exists():
        # a published list of portal moves (player, from, to): each becomes "add as a transfer to the new school" (the
        # school names are matched to ESPN team names in apply())
        t = pd.read_csv(TRANSFERS_CSV)
        add = pd.DataFrame(
            {"team": t["to_school"], "player": t["player"], "action": "add", "kind": "transfer", "from_team": t["from_school"], "net_value": np.nan,
             "floor_share": np.nan, "note": "portal move", "source": t["source"]}
        )
        ov = pd.concat([add, ov], ignore_index=True)  # hand entries come last so they win
    if GAP_CSV.exists():
        # roster completeness check against an outside list: only fills players neither ESPN's feed nor a published portal list has,
        # so it goes in FIRST and anything above overrides it
        g = pd.read_csv(GAP_CSV)
        known = set(zip(ov["team"].astype(str).str.lower(), ov["player"].map(norm)))
        g = g[[(t.lower(), norm(p)) not in known for t, p in zip(g["team"], g["player"])]]
        ov = pd.concat([g[cols], ov], ignore_index=True)
    return ov


def newcomer_values(ps40: pd.DataFrame, weights: dict, seasons: range) -> tuple[float, float]:
    """Average (offence, defence) value of players who had no earlier D1 season and still earned rotation minutes."""
    from .bpm import STATS

    xs = [f"x_{s}" for s in STATS]
    first_year = []
    seen: set = set()
    for s in sorted(ps40["season"].unique()):
        cur = ps40[ps40["season"] == s]
        new = cur[~cur["player_id"].isin(seen) & (cur["f"] >= 0.3)]
        if s in seasons and len(new):
            allp = cur
            vo = allp[xs].to_numpy() @ weights["off"][1:]
            vd = allp[xs].to_numpy() @ weights["de"][1:]
            cen_o, cen_d = np.average(vo, weights=allp["f"]), np.average(vd, weights=allp["f"])
            idx = allp.index.get_indexer(new.index)
            first_year.append((np.average(vo[idx] - cen_o, weights=new["f"]), np.average(vd[idx] - cen_d, weights=new["f"])))
        seen |= set(cur["player_id"])
    if not first_year:
        return 0.0, 0.0
    a = np.mean(first_year, axis=0)
    return float(a[0]), float(a[1])


def apply(roster: pd.DataFrame, ps40: pd.DataFrame, teams: pd.Series, weights: dict, last_season: int) -> tuple[pd.DataFrame, pd.DataFrame, list[str]]:
    """Returns (roster with removals/transfer-adds applied, extras for players with no D1 history, human-readable notes)."""
    ov = load()
    notes: list[str] = []
    if ov.empty:
        return roster, pd.DataFrame(columns=["team_id", "f", "v_off", "v_de", "name", "kind"]), notes
    name_to_team = {n.lower(): int(i) for i, n in teams.items()}
    # published lists use school names ("Kentucky", "St. John's", "UConn"): ESPN's `location` field matches them
    from .ingest import DATA_DIR as D

    names_csv = D / "team_names.csv"
    if names_csv.exists():
        for sch, i in zip(pd.read_csv(names_csv)["school"], pd.read_csv(names_csv)["id"]):
            name_to_team.setdefault(str(sch).lower(), int(i))
    by_name = ps40[ps40["season"] >= last_season - 2].copy()
    by_name["key"] = by_name["name"].map(norm)
    nv_o, nv_d = newcomer_values(ps40, weights, range(max(ps40["season"].min() + 1, last_season - 4), last_season + 1))
    roster = roster.copy()
    extras = []
    for r in ov.itertuples():
        team_id = name_to_team.get(str(r.team).lower())
        if team_id is None:
            notes.append(f"unknown team: {r.team}")
            continue
        key = norm(r.player)
        if str(r.action).lower() == "remove":
            hit = roster[(roster["team_id"] == team_id) & (roster["name"].map(norm) == key)]
            if len(hit):
                roster = roster.drop(hit.index)
                notes.append(f"removed {r.player} from {r.team}")
            continue
        kind = str(r.kind).lower() if isinstance(r.kind, str) else "intl"
        listed = (roster["team_id"] == team_id) & (roster["name"].map(norm) == key)
        if kind == "newcomer" and listed.any():
            continue  # ESPN already lists him
        if kind == "newcomer":
            # on the roster but nothing is known about him: listed like an ESPN freshman with no history (no floor share of his own -
            # the model's "unfilled" term already stands for a typical incoming class)
            import zlib

            roster = pd.concat(
                [roster, pd.DataFrame([{"team_id": team_id, "player_id": -(zlib.crc32(f"{team_id}:{key}".encode()) + 1), "name": r.player}])], ignore_index=True
            )
            notes.append(f"listed newcomer {r.player} -> {r.team}")
            continue
        share = float(r.floor_share) if pd.notna(getattr(r, "floor_share", np.nan)) else DEFAULT_SHARE.get(kind, 0.45)
        found = by_name[by_name["key"] == key].sort_values("season", ascending=False).head(1)
        if kind == "transfer" and len(found):
            # a college player: his old line carries (the roster join picks up his id); keep his own floor share unless one is set
            pid = int(found.iloc[0]["player_id"])
            # leave the old school's roster (ESPN may still list him there) and join the new one
            roster = roster[~((roster["player_id"] == pid) | (roster["name"].map(norm) == key))]
            roster = pd.concat([roster, pd.DataFrame([{"team_id": team_id, "player_id": pid, "name": r.player}])], ignore_index=True)
            notes.append(f"added transfer {r.player} -> {r.team}")
        else:
            if listed.any():
                roster = roster[~listed]  # a priced entry replaces ESPN's bare listing of the same player
            net = float(r.net_value) if pd.notna(getattr(r, "net_value", np.nan)) else None
            half = (nv_o + nv_d) / 2.0 + KIND_BONUS.get(kind, 0.0) / 2.0 if net is None else net / 2.0
            extras.append({"team_id": team_id, "f": share, "v_off": half if net is not None else nv_o + KIND_BONUS.get(kind, 0.0) / 2.0,
                           "v_de": -half if net is not None else nv_d - KIND_BONUS.get(kind, 0.0) / 2.0, "name": r.player, "kind": kind})
            notes.append(f"added {kind} {r.player} -> {r.team}")
    return roster, pd.DataFrame(extras, columns=["team_id", "f", "v_off", "v_de", "name", "kind"]), notes
