"""Read-only: predict on a few fake games with and without lines."""
from exchange.agents.pack import Pack
from exchange.agents.labs.labo import model as M
P = Pack(); P.sports = ["nhl", "cbb"]; st = M.fit(P)
for sp in ("nhl", "cbb"):
    g = P.games(sp).iloc[-1]
    base = {"id": "x", "sport": sp, "home_id": g.home_id, "away_id": g.away_id, "neutral": False, "start": str(g.start)}
    dk = {"spread": -1.5, "total": 6.5, "ml_home": -150, "ml_away": 130} if sp == "nhl" else {"spread": -4.5, "total": 141.5, "ml_home": -200, "ml_away": 170}
    print(sp, M.predict(st, [{**base, "dk": None}]), M.predict(st, [{**base, "dk": dk}]))
