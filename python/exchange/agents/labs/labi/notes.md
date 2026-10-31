# Injury Lab notebook (labi)

Newest first. This file is your only memory between sessions.

## 2026-10-30 - v1 published (NBA only)
- Hypothesis: NBA team ratings fitted at FULL strength (ridge with a learned coefficient B on missing-player value M), then subtract the pre-game injury list. Player value = shrunk Game Score/min above replacement (20th pct) x mean minutes in the team's last 10 games; M = value of rotation players (>=2 apps in last 10) who sat. Backtests read the official NBA injury report issued >=30 min before tip (stored in state only for games after the cut); live uses g["news"]. Status weights Out 1 / Doubtful .85 / Questionable, DTD .4 / Probable .05. PORTABLE=False (reads pack.path files).
- Fitted B ~0.45-0.53 (Jokic out ~ -7 pts margin). HCA comes out low (1.1-1.6).
- Backtest NBA: margin 12.83 vs ridge 13.01 / Elo 13.64; total 14.84 vs ridge 14.96. Other sports abstain.
- Ablation by block (margin MAE, list vs same model with typical M): Mar 26-Apr 10: 11.70 vs 12.58 (gain +0.88 +- 0.33 se, real); Apr 11-Jun: 13.45 vs 13.40 (-0.05 +- 0.26, flat); Oct 2026: no reports, identical (13.34 vs ridge 13.22, base slightly worse than ridge).
- Totals: list-based total adjustment (G*(Mh+Ma)) HURT in Apr-Jun (16.73 vs 15.92 with typical M) - heavy rest/tank lists don't lower scoring. So totals use typical M; the list moves the margin only.
- Known weaknesses: nba/player_games and injury_reports end 2026-06-14, so live rotations are LAST season's (summer trades/rookies not counted; preseason injuries partly double-counted since recent ratings already absorbed them). Name matching normalised (accents, Jr/II, spaces).
- Next: (1) check the Disagree tab and the market score once NBA games settle; (2) use g["news"]["events"] to weight NEW absences (last 72h) above stale ones - stale Outs are already in the ratings; (3) refine player value with on/off or plus-minus blended into Game Score; (4) NHL starting-goalie absence (nhl/games.csv goalies) as a second sport.

## Start (written by the builder)
No model is published yet. Your lens: who is playing - injuries, minutes and rotations, and what a missing player is worth to the margin and the total. First session: read the data named in the catalog for your lens, pick one sport with good data, and publish a first honest model that is clearly different from Elo and ridge.
