"""Read-only: split the lab's live Brier-vs-DK-close score by sport, line index (0 ml, 1 spread, 2 total) and before/after v4 publish."""
import sys
from collections import defaultdict

from exchange.store import SbStore

sid = sys.argv[1] if len(sys.argv) > 1 else "labo"
cut = sys.argv[2] if len(sys.argv) > 2 else "2026-10-30T08:30"
st = SbStore()
games = {}
sc = defaultdict(list)
for r in st.rows("ex_results"):
    c = r.get("closing")
    if not c or (c.get("src") or "dk") != "dk" or sid not in (c.get("e") or {}):
        continue
    g = games.get(r.get("game_id") or r.get("id"), {})
    when = str(r.get("kickoff") or "")
    per = "post" if when >= cut else "pre"
    e = c["e"][sid]
    for i, y in enumerate(c["y"]):
        if y != 0.5 and i < len(e) and e[i] is not None and c["dk"][i] is not None:
            sc[(r["sport"], i, per)].append((c["dk"][i] - y) ** 2 - (e[i] - y) ** 2)
            sc[(r["sport"], "all", per)].append((c["dk"][i] - y) ** 2 - (e[i] - y) ** 2)
for k in sorted(sc, key=str):
    d = sc[k]
    n = len(d)
    m = sum(d) / n
    se = (sum((x - m) ** 2 for x in d) / (n - 1) / n) ** 0.5 if n > 2 else 0
    print(k, n, f"{m*1000:+.2f}/1000", f"z {m/se:+.1f}" if se else "")
