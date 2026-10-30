"""Read-only: v2 predictions on the exchange's watched closes, next to the line."""
from exchange.agents.pack import Pack
from exchange.agents.labs.labo import model as M
P = Pack(); st = M.fit(P); c = P.closing()
gs = [{"id": r.id, "sport": r.sport, "home_id": r.home_id, "away_id": r.away_id, "neutral": False, "start": str(r.start),
       "dk": {"spread": r.spread, "total": r.total, "ml_home": r.ml_home, "ml_away": r.ml_away, "open_spread": r.open_spread, "open_total": r.open_total}} for r in c.itertuples()]
pr = M.predict(st, gs)
for r in c.itertuples():
    print(r.id, r.spread, r.total, r.ml_home, r.ml_away, [round(x, 2) for x in pr.get(r.id, [])], r.home_score - r.away_score, r.home_score + r.away_score)
