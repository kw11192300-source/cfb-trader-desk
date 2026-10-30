"""The data an agent can learn from, in one object.

pack.games(sport)    every finished game in the last ~14 months (ESPN): id, start, home/away ids and names, scores, neutral flag. Time-safe: with
                     asof set it holds only games that started before that moment, which is how backtests avoid peeking.
pack.closing(sport)  DraftKings closing lines for games the exchange watched before kickoff (grows every day; empty at first) - market mandates only
pack.path(*parts)    a file under python/data (CBB box scores and closing odds, NBA box scores / injuries / RAPM inputs, NHL events and so on);
                     CATALOG.md in the pack folder lists what is there. Files outside the pack are NOT time-truncated: guard against leaks yourself.
pack.sports, pack.asof, pack.lines_ok
"""
from __future__ import annotations

import gzip
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
PACK_DIR = DATA_DIR / "agent_pack"
SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"]
COLS = ["id", "start", "home_id", "away_id", "home_name", "away_name", "home_score", "away_score", "neutral"]


class Pack:
    def __init__(self, root: str | Path = PACK_DIR, asof: str | datetime | None = None, lines_ok: bool = True):
        self.root = Path(root)
        ts = pd.Timestamp(asof) if asof is not None else None
        self.asof = None if ts is None else ts if ts.tzinfo else ts.tz_localize("UTC")
        self.lines_ok = lines_ok
        self.sports = SPORTS
        self._g: dict[str, pd.DataFrame] = {}

    def games(self, sport: str) -> pd.DataFrame:
        if sport not in self._g:
            f = self.root / f"espn_{sport}.pkl"
            df = pd.read_pickle(f) if f.exists() else pd.DataFrame(columns=COLS)
            if self.asof is not None and len(df):
                df = df[df["start"] < self.asof]
            self._g[sport] = df.reset_index(drop=True)
        return self._g[sport].copy()

    def closing(self, sport: str | None = None) -> pd.DataFrame:
        f = self.root / "closing_lines.pkl"
        if not self.lines_ok or not f.exists():
            return pd.DataFrame()
        df = pd.read_pickle(f)
        if sport:
            df = df[df["sport"] == sport]
        if self.asof is not None and len(df):
            df = df[df["start"] < self.asof]
        return df.reset_index(drop=True)

    def trades(self) -> pd.DataFrame:
        """Every settled trade the exchange has seen (kept for 120 days): when, on which contract, at what price, who took it and how sharp or public that taker is,
        DraftKings' price at the time (ref_p), the closing price (close_p) and the result (outcome 1, 0 or 0.5). For maker research."""
        f = self.root / "exchange_trades.pkl"
        if not f.exists():
            return pd.DataFrame()
        df = pd.read_pickle(f)
        if self.asof is not None and len(df):
            df = df[df["ts"] < self.asof]
        return df.reset_index(drop=True)

    def news(self) -> pd.DataFrame:
        """Injury and availability events the exchange has seen since it started watching (one row each: when, sport, team, player, status, previous status) with the DraftKings line and exchange
        prices when the event was seen and 30 minutes and two hours later, where the event was tied to an upcoming game. Short history: it only starts when the exchange did."""
        f = self.root / "exchange_news.pkl"
        return pd.read_pickle(f) if f.exists() else pd.DataFrame()

    def path(self, *parts: str) -> Path:
        return DATA_DIR.joinpath(*parts)


def to_frame(games: list[dict]) -> pd.DataFrame:
    def ts(x):
        t = pd.Timestamp(x)
        return t.tz_convert("UTC") if t.tzinfo else t.tz_localize("UTC")

    rows = [{"id": g["id"], "start": ts(g["start"]),
             "home_id": g["home"]["id"], "away_id": g["away"]["id"], "home_name": g["home"]["name"], "away_name": g["away"]["name"],
             "home_score": g["home"]["score"], "away_score": g["away"]["score"], "neutral": bool(g["neutral"])} for g in games]
    return pd.DataFrame(rows, columns=COLS)


def write_games(sport: str, games: list[dict], root: Path = PACK_DIR) -> None:
    root.mkdir(parents=True, exist_ok=True)
    to_frame(games).to_pickle(root / f"espn_{sport}.pkl")


def write_closing(store, root: Path = PACK_DIR) -> int:
    """DraftKings' last pre-game lines for every finished game the exchange has watched."""
    rows = []
    for g in store.rows("ex_games", {"completed": True}):
        ref = g.get("ref")
        if not ref or g.get("home_score") is None or g.get("voided"):
            continue
        op = g.get("ref_open") or {}
        rows.append({"id": g["id"], "sport": g["sport"], "start": pd.Timestamp(g["start_utc"]), "home_id": g["home"]["id"], "away_id": g["away"]["id"],
                     "spread": ref.get("spread"), "total": ref.get("total"), "ml_home": ref.get("ml_home"), "ml_away": ref.get("ml_away"),
                     "open_spread": op.get("spread"), "open_total": op.get("total"), "home_score": g["home_score"], "away_score": g["away_score"],
                     "kalshi": (g.get("views") or {}).get("kal")})
    root.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_pickle(root / "closing_lines.pkl")
    return len(rows)


def write_trades(store, root: Path = PACK_DIR) -> int:
    """Settled trades for the maker lab: one row per trade with the taker's current sharpness in the sport."""
    members = {m["id"]: m for m in store.rows("ex_members")}
    starts = {g["id"]: g["start_utc"] for g in store.rows("ex_games")}
    rows = []
    for t in store.rows("ex_trades", {"settled": True}):
        if t.get("outcome") is None or t["game_id"] not in starts:
            continue
        taker = t["buyer"] if t["maker"] == t["seller"] else t["seller"]
        m = members.get(taker)
        if not m:
            continue
        sport = t["game_id"].split(":")[0]
        ts, st = pd.Timestamp(t["ts"]), pd.Timestamp(starts[t["game_id"]])
        rows.append({"id": t["id"], "ts": ts, "game_id": t["game_id"], "sport": sport, "kind": t["kind"], "line": t["line"], "price": t["price"], "qty": t["qty"], "taker": taker,
                     "taker_buys": taker == t["buyer"], "taker_sharp": float((m["stats"].get("sharp") or {}).get(sport, 0.0)), "taker_public": bool(m["params"].get("public")),
                     "maker": t["maker"], "ref_p": t.get("ref_p"), "close_p": t.get("close_p"), "outcome": t["outcome"], "start": st, "hrs": (st - ts).total_seconds() / 3600})
    root.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_pickle(root / "exchange_trades.pkl")
    return len(rows)


def write_news(store, root: Path = PACK_DIR) -> int:
    rows = []
    for r in store.rows("ex_meta"):
        if r["key"] != "news":
            continue
        for e in r["value"].get("events", []):
            row = {k: e.get(k) for k in ("id", "ts", "sport", "team", "team_name", "player", "pos", "status", "prev", "kind", "detail", "gid", "teams", "start")}
            for key in ("r0", "r1", "r2"):
                m = e.get(key) or {}
                row[f"{key}_spread"], row[f"{key}_total"] = m.get("spread"), m.get("total")
                row[f"{key}_x_spread"], row[f"{key}_x_total"] = (m.get("x") or {}).get("spread"), (m.get("x") or {}).get("total")
            rows.append(row)
    root.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_pickle(root / "exchange_news.pkl")
    return len(rows)


def _cols(p: Path) -> list[str] | None:
    try:
        if p.suffix == ".gz":
            with gzip.open(p, "rt", encoding="utf-8", errors="replace") as f:
                return f.readline().strip().split(",")[:40]
        if p.suffix == ".csv":
            with open(p, encoding="utf-8", errors="replace") as f:
                return f.readline().strip().split(",")[:40]
    except Exception:
        return None
    return None


def catalog(root: Path = PACK_DIR) -> str:
    """A readable list of every data file under python/data (top two levels), with column names for the tables."""
    lines = ["# Data available to agents", "", "Paths are relative to python/data and are read with `pack.path(...)`. These files are not time-truncated.", ""]
    for top in sorted(p for p in DATA_DIR.iterdir() if p.is_dir() and p.name != "agent_pack"):
        lines.append(f"## {top.name}/")
        kids = sorted(top.iterdir())
        files = [k for k in kids if k.is_file() and k.suffix in (".csv", ".gz", ".json", ".pkl", ".parquet") and "log" not in k.name]
        dirs = [k for k in kids if k.is_dir()]
        for f in files:
            cols = _cols(f)
            lines.append(f"- `{top.name}/{f.name}` ({f.stat().st_size // 1024} KB)" + (f": {', '.join(cols)}" if cols else ""))
        for d in dirs:
            n = sum(1 for _ in d.iterdir())
            lines.append(f"- `{top.name}/{d.name}/` folder, {n} entries")
        lines.append("")
    root.mkdir(parents=True, exist_ok=True)
    (root / "CATALOG.md").write_text("\n".join(lines), encoding="utf-8")
    return "\n".join(lines)
