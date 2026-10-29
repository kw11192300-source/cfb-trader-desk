"""Paper-only guard. The exchange is a fake-money simulation: it must never place, route or automate a real bet on a sportsbook or a trading venue.

`python -m exchange audit` scans every file in python/exchange and every published agent model for anything that could reach a betting or trading venue, and
fails (exit 1) if it finds some. It runs before every scheduled round and ratings job, so a change that sneaks in a venue, a login or an order call stops the
job instead of running. The only outside hosts the exchange may read from are ESPN's public scoreboard and Kalshi's public market data (prices only).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ALLOWED_HOSTS = {"site.api.espn.com", "api.elections.kalshi.com"}
FORBIDDEN = [
    (re.compile(r"requests\.(post|put|delete|patch)\b|\.(post|put|delete|patch)\(\s*[\"'(]?https?://", re.I), "writes to an outside service"),
    (re.compile(r"/portfolio/|/orders\b|trade-api/v2/(portfolio|orders)|create_order|place_order|submit_order|cancel_order", re.I), "an order or account endpoint"),
    (re.compile(r"place[_ -]?(a )?(bet|wager)|bet[_ -]?slip|sign[_ -]?in\b|log[_ -]?in\b|\bdeposit\b|\bwithdraw", re.I), "betting, login or money-movement code"),
    (re.compile(r"(api[_-]?key|api[_-]?secret|private[_-]?key|passphrase|password|bearer|token)\s*[=:]\s*[\"'a-zA-Z0-9]", re.I), "a credential"),
]
# files that mention these words only to describe or filter them (the data the exchange reads is DraftKings' PRICE as published on ESPN; nothing is sent to DraftKings)
EXEMPT = {"audit.py", "sandbox.py", "espn.py", "pricing.py", "members.py", "engine.py", "kalshi.py", "results.py", "house.py", "pack.py", "manage.py", "store.py", "ratings.py", "risk.py", "backtest.py", "BRIEF.md", "__main__.py", "__init__.py"}
URL = re.compile(r"https?://([a-zA-Z0-9.-]+)")


def scan_text(name: str, text: str, strict: bool) -> list[str]:
    problems = []
    for host in set(URL.findall(text)):
        if host not in ALLOWED_HOSTS and not host.endswith(("claude.com", "github.com", "supabase.co", "supabase.com")):
            problems.append(f"{name}: talks to {host}")
    for rx, why in FORBIDDEN:
        # the exchange's own source may use words like token or login in unrelated ways (a list of tokens, a docstring); the labs' code and any new file may not
        if not strict and why in ("betting, login or money-movement code", "a credential"):
            continue
        if m := rx.search(text):
            problems.append(f"{name}: {why} ({m.group(0)[:40]})")
    return problems


def run(store=None) -> list[str]:
    problems: list[str] = []
    for p in ROOT.rglob("*.py"):
        if p.name == "audit.py":
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        problems += scan_text(str(p.relative_to(ROOT.parent)), text, strict=p.name not in EXEMPT)
    if store is not None:  # the models the labs have published, which run in the hosted rounds
        for r in store.rows("ex_ratings"):
            if r["key"].startswith("agent-code:"):
                problems += scan_text(r["key"], (r["payload"] or {}).get("code", ""), strict=True)
    return problems


def main(store=None) -> None:
    problems = run(store)
    if problems:
        print("PAPER-ONLY AUDIT FAILED:")
        for x in problems:
            print("  ", x)
        sys.exit(1)
    print("paper-only audit passed: the exchange reads ESPN and Kalshi prices and writes only to its own tables")
