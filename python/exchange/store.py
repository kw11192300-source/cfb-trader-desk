"""Where the exchange keeps its state: Supabase (ex_ tables) in the jobs, or a local JSON file for dry runs."""
from __future__ import annotations

import json
from pathlib import Path

LOCAL = Path(__file__).resolve().parents[1] / "data" / "exchange_local.json"
TABLES = ("ex_syndicates", "ex_members", "ex_games", "ex_trades", "ex_snapshots", "ex_ratings", "ex_meta")
KEYS = {"ex_syndicates": "id", "ex_members": "id", "ex_games": "id", "ex_trades": "id", "ex_ratings": "key", "ex_meta": "key"}


class FileStore:
    def __init__(self, path: Path = LOCAL):
        self.path = path
        self.d: dict[str, list[dict]] = {t: [] for t in TABLES}
        if path.exists():
            self.d.update(json.loads(path.read_text()))

    def rows(self, table: str, where: dict | None = None) -> list[dict]:
        return [r for r in self.d[table] if all(r.get(k) == v for k, v in (where or {}).items())]

    def upsert(self, table: str, rows: list[dict], ignore_existing: bool = False) -> None:
        key = KEYS[table]
        idx = {r[key]: i for i, r in enumerate(self.d[table])}
        for r in rows:
            if r[key] in idx:
                if not ignore_existing:
                    self.d[table][idx[r[key]]] = r
            else:
                idx[r[key]] = len(self.d[table])
                self.d[table].append(r)

    def insert(self, table: str, rows: list[dict]) -> None:
        self.d[table].extend(rows)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.d))


class SbStore:
    def __init__(self):
        from cfbd_ingest.supabase_client import get_client

        self.c = get_client()

    def rows(self, table: str, where: dict | None = None) -> list[dict]:
        out, start = [], 0
        order = KEYS.get(table, "ts")
        while True:
            q = self.c.table(table).select("*")
            for k, v in (where or {}).items():
                q = q.eq(k, v)
            page = q.order(order).range(start, start + 999).execute().data
            out += page
            if len(page) < 1000:
                return out
            start += 1000

    def upsert(self, table: str, rows: list[dict], ignore_existing: bool = False) -> None:
        for i in range(0, len(rows), 400):
            self.c.table(table).upsert(rows[i : i + 400], ignore_duplicates=ignore_existing).execute()

    def insert(self, table: str, rows: list[dict]) -> None:
        for i in range(0, len(rows), 400):
            self.c.table(table).insert(rows[i : i + 400]).execute()

    def save(self) -> None:
        pass
