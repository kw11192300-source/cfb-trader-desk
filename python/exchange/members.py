"""The roster: eight syndicates with 10,000 units each, split among five traders of 2,000.

Every trader knows every sport, and some focus on a few where they trade bigger and accept smaller edges. They all have the same goal (beat the closing DraftKings price, which in the long run is the same as making money) and works inside the
same rulebook; each builds its own strategy inside it:

  rulebook   (engine.RULES) fair price is DraftKings' no-vig price nudged toward the syndicate's model by a weight the syndicate learns
             from settled games, and never more than 12 cents from DraftKings; at most 100 units (1% of the syndicate's bankroll) on one game
             and market type; quarter Kelly at most; at most 70% of a desk's bankroll tied up; never both sides of the same line;
             a trader asks for at least a 1-cent edge and quotes at least 1 cent each side
  strategy   (per trader) how big an edge it demands, how tight it quotes, how hard it bets, how far it trusts its syndicate's model - set at
             the start, then reviewed from its own results: takes that close worse than they were paid raise the edge it demands, quotes that
             get picked off widen, and good results tighten it up
A contract pays 1 unit, so a 40-cent contract bought 100 times risks 40 units.
"""
from __future__ import annotations

import random

SYNDICATE_UNITS = 10_000.0
SPORTS = ["nfl", "cfb", "nhl", "nba", "cbb"]
TRADERS_PER = 5
TRADER_UNITS = SYNDICATE_UNITS / TRADERS_PER
NAMES = ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Gray", "Harper", "Indigo", "Jules", "Kai", "Logan", "Morgan", "Nico", "Oakley", "Parker",
         "Quinn", "Reese", "Sage", "Tatum", "Uma", "Val", "Wren", "Xan", "Yael", "Zion", "Arden", "Bryn", "Cleo", "Dale", "Eden", "Flynn", "Gale", "Hollis",
         "Ivy", "Jordan", "Kit", "Lane", "Marlow", "Nova", "Onyx", "Phoenix", "Remy", "Sky", "Teagan", "Ulric", "Vesper", "Wynn", "Yarrow", "Zeke", "Rune", "Sloane", "Tove", "Ash", "Bell", "Cove", "Dune", "Fern", "Glen", "Hale", "Ike", "Jett", "Kerry", "Lark", "Moss", "Noor", "Orin", "Pace", "Quill", "Rhys", "Sol", "Tarn", "Ulla", "Vance", "Wick", "Xia", "Yves", "Zora", "Alma", "Bram", "Cyra", "Dov"]
# (role, number of focus sports): two market makers (a specialist and a generalist), two takers, one who does both
SEATS = [("maker", 2), ("maker", 3), ("taker", 2), ("taker", 1), ("both", 2)]


def strategy(sid: str, i: int, role: str) -> dict:
    """Each trader starts with its own take on the shared rulebook - how big an edge it wants, how tight it quotes, how hard it bets, how far it
    trusts its syndicate's model - and then adapts it from its own results (engine.adapt). The rulebook itself (engine.RULES) caps all of it."""
    r = random.Random(f"{sid}-{i}")
    return dict(max_risk=100.0, thr=round(r.uniform(0.012, 0.03), 3), half=round(r.uniform(0.01, 0.022), 3), kelly=round(r.uniform(0.1, 0.25), 2),
                size=round(r.uniform(60, 100)), skew=round(r.uniform(0.0001, 0.0004), 5), trust=round(r.uniform(0.7, 1.3), 2),
                follow=round(r.uniform(0.2, 0.9), 2))


SYNDICATES = [
    dict(id="elo", name="Elo Works", engine="elo", color="#2563eb", tagline="Margin Elo: every result moves a team's rating, the off-season pulls it back toward average."),
    dict(id="ridge", name="Ridge Rangers", engine="ridge_long", color="#7c3aed", tagline="Offence/defence ridge regression with a long memory - the slow, stable view of team quality."),
    dict(id="form", name="Form Guide", engine="ridge_short", color="#ea580c", tagline="The same regression with a short memory: who is hot or cold right now."),
    dict(id="blend", name="Consensus Desk", engine="blend", color="#059669", tagline="Averages the three rating systems, so it only disagrees with the market when they all do."),
    dict(id="tape", name="Tape Readers", engine="tape", color="#0891b2", tagline="No ratings: follows DraftKings line movement and bets that steam keeps going."),
    dict(id="fade", name="Fade Club", engine="fade", color="#dc2626", tagline="No ratings: bets that big line moves overshoot and fade them."),
    dict(id="pace", name="Pace Lab", engine="pace", color="#ca8a04", tagline="Totals specialists - scoring environment from the ratings, with no view on sides."),
    dict(id="mm", name="Liquidity Partners", engine="ref", color="#475569", tagline="The control group: no model at all, so they quote and trade straight off the DraftKings price."),
    dict(id="house", name="House Models", engine="house", color="#f59e0b",
         tagline="The site's own CBB, NBA and NHL models entered as a syndicate, so they are judged against DraftKings and every other syndicate on finished games."),
    dict(id="labf", name="Fundamentals Lab", engine="agent", color="#f472b6", agent={"lines": False},
         tagline="A research agent that builds its own model from results, team and player data and never sees a betting line, so any edge it finds is its own."),
    dict(id="labm", name="Market Lab", engine="agent", color="#a3e635", agent={"lines": True},
         tagline="A research agent that studies the market itself - how lines move, which moves hold and which fade - and builds a model of that."),
    dict(id="labo", name="Open Lab", engine="agent", color="#e879f9", agent={"lines": True},
         tagline="A research agent with everything: results, player data and market lines, free to combine them however it finds works."),
    dict(id="kalshi", name="Kalshi Followers", engine="kalshi", color="#10b981",
         tagline="No model: treats Kalshi's real-money prices as the truth and trades whatever gap there is between Kalshi and DraftKings."),
    dict(id="mmt", name="Tight Book", engine="mm", color="#14b8a6", mmstyle="tight",
         tagline="Pure market makers: quote both sides of every line tight and fast, earn the spread, stay flat, and move their price as order flow reveals where the game is."),
    dict(id="mmc", name="Careful Book", engine="mm", color="#6366f1", mmstyle="careful",
         tagline="Pure market makers who quote wider and smaller, back off after being picked off, and rebuild their price from who is trading against them."),
]


def roster() -> tuple[list[dict], list[dict]]:
    syns, mems = [], []
    for si, s in enumerate(SYNDICATES):
        syns.append({"id": s["id"], "name": s["name"], "engine": s["engine"], "color": s["color"], "tagline": s["tagline"],
                     "start_units": SYNDICATE_UNITS, "learn": {"agent": {**s["agent"], "version": 0}} if "agent" in s else {}})
        pool = SPORTS[:]
        random.Random(s["id"]).shuffle(pool)
        picks = [pool[0:2], pool[2:5], pool[3:5], pool[0:1], pool[1:3]]  # between them the five traders cover every sport
        for i, ((role, _), focus) in enumerate(zip(SEATS, picks)):
            params = {**strategy(s["id"], i, role), "focus": focus}
            if s.get("mmstyle"):  # a dedicated market maker: quotes everything, never takes, no model
                role, focus = "maker", SPORTS[:]
                r = random.Random(f"{s['id']}-mm-{i}")
                tight = s["mmstyle"] == "tight"
                params.update(focus=focus, mm=True, half=round(r.uniform(0.008, 0.012) if tight else r.uniform(0.018, 0.026), 4),
                              size=round(r.uniform(90, 100) if tight else r.uniform(55, 75)), tox=0.5 if tight else 1.0, eta=round(r.uniform(0.7, 1.0) if tight else r.uniform(1.1, 1.5), 2),
                              inv=1.0 if tight else 1.5)
            if s["id"] == "pace":
                params["kinds"] = ["total"]
            mems.append({"id": f"{s['id']}-{i + 1}", "syndicate_id": s["id"], "name": NAMES[si * TRADERS_PER + i], "role": role, "staking": "kelly",
                         "params": params, "start_units": TRADER_UNITS, "cash": TRADER_UNITS, "locked": 0.0, "realized": 0.0,
                         "equity": TRADER_UNITS, "open_risk": 0.0, "updated_at": None,
                         "stats": {"n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0,
                                   "clv_sum": 0.0, "clv_n": 0, "peak": TRADER_UNITS, "max_dd": 0.0, "wins": 0, "losses": 0, "biggest": 0.0}})
    return syns, mems
