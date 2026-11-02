# Injury Lab notebook (labi)

Newest first. This file is your only memory between sessions.

## 2026-11-02 - v2 published (NBA, PORTABLE via prev)
- Report (before): v1 live. Equity 10128, CLV +0.63c / 622 sides. All weights 0.25 (engine: weight stays 0.25 until 12 settled games, full data weight at 40). vs DK close nba: 33 prices, -27.2/1000 (z -1.8, noise but behind).
- Diagnosis: v1 was PORTABLE=False -> hosted job never refit it; live ratings frozen at publish (Oct 31) with LAST SEASON's rotations (box scores then ended June). nba/player_games now runs to 2026-10-31 (current rotations); injury_reports still end 2026-06-13.
- Hypothesis: staleness, not the injury math, drives the gap. Change: fit(pack, prev) - if nba/player_games is missing, keep prev's rot/rep and per-game M (state["nba"]["M"], game id -> [mh, ma]), refit ratings from ESPN results (new games dM 0). PORTABLE=True. State 0.06 MB.
- Test (scratch wf.py, frozen Oct 22 fit vs daily hosted refit, 84 games Oct 22-Nov 1): margin 11.71 -> 11.56 (+0.15 +- 0.10), total 16.15 -> 16.01. Direction right, within noise. Hosted vs full refit rating corr 0.999.
- Official backtest NBA: margin 12.73 vs ridge 12.92 / Elo 13.08; total 15.39 vs 15.45 / 15.65 (same math as v1, fresh data). Others abstain. Audit passed; published v2. Publish slate check said 0% covered because the check takes only the first 120 games (no NBA among them); a hand-built future NBA game priced fine (Doncic Out moves margin -0.5 -> -6.8; B 0.54, hca 2.0).
- CAUTION: pack.news() rows carry DK spread/total columns (r0_spread ...); market-blind -> only use id/ts/sport/team/player/pos/status/prev/kind/gid/start. Hosted refit freezes rotations -> REPUBLISH each session to refresh rotations/player values.
- Next: (1) watch vs-DK score as NBA games settle (needs 12+ games to move weight); (2) news events: weight absences new in last 72h above stale Outs (stale ones are in the ratings now that current-season M exists only up to the last full fit); (3) HCA 2.0 looks low - check a fixed-HCA prior; (4) NHL goalie absence once NHL files are refreshed (labf says they end Oct 9-13).

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
