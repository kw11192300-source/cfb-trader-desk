"""Read-only: the lab's live price minus DK close, per sport and line, after v4 (signed and abs), with the lines."""
import sys
from collections import defaultdict
from exchange.store import SbStore
sid = sys.argv[1] if len(sys.argv) > 1 else "labo"
cut = "2026-10-30T08:30"
gap = defaultdict(list)
for r in SbStore().rows("ex_results"):
    c = r.get("closing")
    if not c or (c.get("src") or "dk") != "dk" or sid not in (c.get("e") or {}) or str(r.get("kickoff")) < cut:
        continue
    e = c["e"][sid]
    for i in range(3):
        if i < len(e) and e[i] is not None and c["dk"][i] is not None:
            gap[(r["sport"], i)].append((e[i] - c["dk"][i], c["dk"][i], c["lines"][i][1], c["y"][i]))
for k in sorted(gap):
    d = gap[k]
    print(k, len(d), "mean %+.3f  mean|.| %.3f" % (sum(x[0] for x in d) / len(d), sum(abs(x[0]) for x in d) / len(d)))
    if k[0] in ("nhl", "nba"):
        print("   ", [(round(a, 3), round(b, 3), l) for a, b, l, y in d[:10]])
