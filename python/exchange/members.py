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
         "Ivy", "Jordan", "Kit", "Lane", "Marlow", "Nova", "Onyx", "Phoenix", "Remy", "Sky", "Teagan", "Ulric", "Vesper", "Wynn", "Yarrow", "Zeke", "Rune", "Sloane", "Tove", "Ash", "Bell", "Cove", "Dune", "Fern", "Glen", "Hale", "Ike", "Jett", "Kerry", "Lark", "Moss", "Noor", "Orin", "Pace", "Quill", "Rhys", "Sol", "Tarn", "Ulla", "Vance", "Wick", "Xia", "Yves", "Zora", "Alma", "Bram", "Cyra", "Dov", "Briar", "Cass", "Dex", "Elio", "Fable", "Gus", "Hux", "Iris", "Joss", "Kade", "Lyra", "Milo", "Nell", "Otis", "Pia", "Quin", "Rhea", "Sabine", "Tobin", "Vera", "Wells", "Yuki", "Zara", "Arlo", "Bree", "Cade", "Dara"]
# (role, number of focus sports): two market makers (a specialist and a generalist), two takers, one who does both
SEATS = [("maker", 2), ("maker", 3), ("taker", 2), ("taker", 1), ("both", 2)]
PUBLIC_UNITS = 25_000.0  # the public-money firm is bigger than the others: a crowd has more money than any one desk
PANEL_NAMES = ["KenPom", "Torvik", "EvanMiya", "Composite Tight", "Composite Careful"]  # the Ratings Panel's traders are named for the rating system they quote from
MOVER_NAMES = ["Totals Steady", "Totals Full", "Spreads Steady", "Spreads Full", "Open Blend"]  # the Open Movers' traders are named for the market they trade and how much of the predicted move they take
MOVER_SEATS = [(["total"], 0.5), (["total"], 1.0), (["spread"], 0.5), (["spread"], 1.0), (["spread", "total"], 0.75)]  # (markets, share of the movement model's predicted move each takes)
PUBLIC_STYLES = ["chalk", "chalk", "lottery", "hot", "model", "homer", "drift", "casual"]  # one trader each; the crowd is not one mind


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
    dict(id="form", name="Form Guide", engine="situation", color="#ea580c", tagline="The schedule spot, not the team: DraftKings' price adjusted for rest, back-to-backs, byes, road trips and a busy week, with the size of each effect learned from results."),
    dict(id="blend", name="Consensus Desk", engine="agree", color="#059669", tagline="No model of its own: it trades where several independent groups push the price the same way, and stays out where they disagree."),
    dict(id="tape", name="Tape Readers", engine="tape", color="#0891b2", tagline="No ratings: follows DraftKings line movement and bets that steam keeps going."),
    dict(id="fade", name="Fade Club", engine="fade", color="#dc2626", tagline="No ratings: bets that big line moves overshoot and fade them."),
    dict(id="pace", name="Totals Desk", engine="pace", color="#ca8a04", tagline="Totals specialists - scoring environment from the ratings, with no view on sides."),
    dict(id="mm", name="Liquidity Partners", engine="ref", color="#475569", tagline="The control group: no model at all, so they quote and trade straight off the DraftKings price."),
    dict(id="house", name="House Models", engine="house", color="#f59e0b",
         tagline="The site's own CBB, NBA and NHL models entered as a trading firm, so they are judged against DraftKings and every other firm on finished games."),
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
    dict(id="labi", name="Injury Lab", engine="agent", color="#fb7185", agent={"lines": False},
         tagline="A research agent that prices who is playing: injury lists, minutes and rotations, what a missing player is worth, built from player data and never from a betting line."),
    dict(id="labt", name="Tempo Lab", engine="agent", color="#fbbf24", agent={"lines": False},
         tagline="A research agent that builds from how teams play, not who they beat: tempo, shot profile and efficiency from box scores, and what a style matchup does to the score and the total. Never sees a betting line."),
    dict(id="main", name="Main Street", engine="public", color="#f97316", public=True,
         tagline="Public money: recreational bettors who lean to favorites, overs and underdog moneylines, pile in during the last few hours before a game, and pay a few cents over fair for it. Not sharp - the flow the market makers live on."),
    dict(id="labk", name="Maker Lab", engine="agent", color="#38bdf8", agent={"lines": True, "mode": "maker"}, mmstyle="lab",
         tagline="A research agent that builds the market-making playbook: where to quote, how wide, and where to lean from what the sharp accounts and public money are doing. It earns the spread and builds positions on the sharp side."),
    dict(id="wing", name="Wing Desk", engine="mm", color="#22d3ee", mmstyle="wing",
         tagline="Market makers for the alternate lines: they quote only the spreads and totals around the main number, where nobody else posts, with a price that keeps DraftKings' main line but fits the width of results to each game (a big favourite or a high total gets a wider curve). They quote wider the further out they go and earn the spread on both sides."),
    dict(id="pan", name="Ratings Panel", engine="mm", color="#a78bfa", mmstyle="panel", units=20_000.0,
         tagline="Market makers for college basketball games DraftKings has not priced yet: they quote from the outside ratings (KenPom first, then Torvik and EvanMiya where fresh) on DraftKings' scale, with bigger limits than other desks, and move their price as sharp money and the crowd trade against them. Once DraftKings posts a line they stay in but pull back to a smaller size and defer to it."),
    dict(id="mov", name="Open Movers", engine="mm", color="#f472b6", mmstyle="mover", units=15_000.0,
         tagline="Trades the college basketball plays the movement model flags: games where the opening line is expected to move before the close (the top tier of predicted moves, which beat the open in out-of-sample tests). Each trader prices the flagged line where the model says it will close, takes a different share of the move, and is judged on whether DraftKings then moves its way."),
]


def roster() -> tuple[list[dict], list[dict]]:
    syns, mems = [], []
    ni = 0  # running index into NAMES, so a syndicate added later never reuses a name
    for si, s in enumerate(SYNDICATES):
        units = PUBLIC_UNITS if s.get("public") else s.get("units", SYNDICATE_UNITS)
        tu_ = units / TRADERS_PER
        syns.append({"id": s["id"], "name": s["name"], "engine": s["engine"], "color": s["color"], "tagline": s["tagline"],
                     "start_units": units, "learn": {"agent": {**s["agent"], "version": 0}} if "agent" in s else {}})
        if s.get("public"):
            for i, style in enumerate(PUBLIC_STYLES):
                r = random.Random(f"{s['id']}-{i}")
                tu = PUBLIC_UNITS / len(PUBLIC_STYLES)
                mems.append({"id": f"{s['id']}-{i + 1}", "syndicate_id": s["id"], "name": NAMES[ni + i], "role": "taker", "staking": "flat",
                             "params": dict(public=True, style=style, focus=SPORTS[:], max_risk=200.0, tol=round(r.uniform(0.015, 0.03), 3), act=round(r.uniform(0.7, 1.4), 2),
                                            sizem=round(r.uniform(0.8, 1.6), 2), kelly=0.0, size=0.0, thr=0.0, half=0.0),
                             "start_units": tu, "cash": tu, "locked": 0.0, "realized": 0.0, "equity": tu, "open_risk": 0.0, "updated_at": None,
                             "stats": {"n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0,
                                       "clv_sum": 0.0, "clv_n": 0, "peak": tu, "max_dd": 0.0, "wins": 0, "losses": 0, "biggest": 0.0}})
            ni += len(PUBLIC_STYLES)
            continue
        pool = SPORTS[:]
        random.Random(s["id"]).shuffle(pool)
        picks = [pool[0:2], pool[2:5], pool[3:5], pool[0:1], pool[1:3]]  # between them the five traders cover every sport
        for i, ((role, _), focus) in enumerate(zip(SEATS, picks)):
            params = {**strategy(s["id"], i, role), "focus": focus}
            if s.get("mmstyle"):  # a dedicated market maker: quotes everything, never takes, no model
                role, focus = "maker", SPORTS[:]
                r = random.Random(f"{s['id']}-mm-{i}")
                tight = s["mmstyle"] == "tight"
                lab = s["mmstyle"] == "lab"
                params.update(focus=focus, mm=True, half=round(r.uniform(0.011, 0.015) if lab else r.uniform(0.008, 0.012) if tight else r.uniform(0.015, 0.019), 4),
                              size=round(r.uniform(70, 90) if lab else r.uniform(90, 100) if tight else r.uniform(55, 75)), tox=0.8 if lab else 0.5 if tight else 1.0,
                              eta=round(r.uniform(0.8, 1.2) if lab else r.uniform(0.7, 1.0) if tight else r.uniform(1.1, 1.5), 2), inv=1.0 if (tight or lab) else 1.5)
                if s["mmstyle"] == "wing":  # alternate-line makers: spreads and totals only, off the main number, wider and a little smaller than the other books
                    params.update(focus=[sp for sp in SPORTS if sp != "nhl"], wing=True, kinds=["spread", "total"], half=round(r.uniform(0.014, 0.020), 4),
                                  size=round(r.uniform(45, 65)), tox=1.0, eta=round(r.uniform(0.9, 1.3), 2), inv=1.5)
                if s["mmstyle"] == "panel":  # the ratings panel: college basketball only, every line near the main number, bigger than the other makers
                    params.update(psys=("kenpom", "torvik", "evanmiya", None, None)[i], focus=["cbb"], panel=True, half=round(r.uniform(0.012, 0.017), 4), size=round(r.uniform(110, 140)), tox=1.0, eta=round(r.uniform(0.9, 1.3), 2), inv=1.0, max_risk=250.0)
                if s["mmstyle"] == "mover":  # the open movers: college basketball spreads and totals the movement model flags, quoted where it expects the line to close; a share of the predicted move per trader
                    kinds_, mw_ = MOVER_SEATS[i]
                    params.update(mover=True, mw=mw_, kinds=kinds_, focus=["cbb"], half=round(r.uniform(0.012, 0.017), 4), size=round(r.uniform(90, 120)), tox=1.0, eta=round(r.uniform(0.9, 1.3), 2), inv=1.0, max_risk=150.0)
                if lab:
                    params["lab"] = True
                    params["max_risk"] = 150.0
                    if i == 4:  # one trader may also take, a little, and only where the sharp accounts are clearly on one side
                        role = "both"
                        params.update(take_scale=0.2, thr=0.03, kelly=0.1)  # its quotes come from the lab's published policy, not from the trader's own strategy
            if s["id"] == "pace":
                params["kinds"] = ["total"]
            mems.append({"id": f"{s['id']}-{i + 1}", "syndicate_id": s["id"], "name": PANEL_NAMES[i] if s.get("mmstyle") == "panel" else MOVER_NAMES[i] if s.get("mmstyle") == "mover" else NAMES[ni], "role": role, "staking": "kelly",
                         "params": params, "start_units": tu_, "cash": tu_, "locked": 0.0, "realized": 0.0,
                         "equity": tu_, "open_risk": 0.0, "updated_at": None,
                         "stats": {"n_maker": 0, "n_taker": 0, "vol_maker": 0.0, "vol_taker": 0.0, "pnl_maker": 0.0, "pnl_taker": 0.0,
                                   "clv_sum": 0.0, "clv_n": 0, "peak": tu_, "max_dd": 0.0, "wins": 0, "losses": 0, "biggest": 0.0}})
            ni += 1
    return syns, mems
