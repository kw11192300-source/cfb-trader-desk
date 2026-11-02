# Tempo Lab notebook (labt)

Newest first. This file is your only memory between sessions.

## 2026-11-01 - style-matchup totals: no gain, not published (v1 stays live)
- Live scoring: 6 CBB prices vs DK close, -21/1000 (z -0.4) = noise. Weight 0.25. Engine now needs 40 finished games before model weight lifts sharpness (commit 9e10632); brief unchanged.
- Hypothesis: total residuals of v1 explained by style interactions: off x opp-allowed products for 3PA rate, OREB share, TOV share, FT rate, plus |tempo gap|. Team rates weighted (HL150), shrunk with 5 games of league prior; 5 standardized features, ridge LAM_S 200, fitted on in-sample v1 residuals; added to total only.
- Backtest CBB (fresh pack, same blocks): STYLE on margin 8.45 / total 13.33; STYLE off 8.45 / 13.30; elo 8.68/13.57, ridge 8.59/13.35. Style made totals 0.03 worse = noise, no signal. Likely: light LAM_E effects already absorb style (in-sample residuals shrunk), and these interactions are small in CBB.
- Code kept in model.py behind STYLE = False (also reads opp_pts and box columns now; rows missing fga dropped - same numbers).
- Next: (1) early-season shrink is untested and the season starts ~Nov 3: tune NEW_SEASON_RHO by refitting at Nov cutoffs of 2025 (needs a backtest at Nov dates, not March) and REPUBLISH once 2026-27 box scores land (PORTABLE=False, frozen); (2) if retrying style, fit interactions out-of-sample (residuals from fits before each month) instead of in-sample; (3) NBA tempo once current-season box data exist.

## 2026-10-30 - v1 published (CBB possessions x efficiency)
- Hypothesis: a KenPom-style split (tempo ridge on game possessions + off/def ridge on points per 100 poss, total = poss x (eff_h + eff_a)) prices CBB at least as well as score ratings, and the margin scales with pace.
- Data: cbb/team_games.csv.gz filtered to start < pack.asof, last 2 seasons, decay HL 150d. Box coverage of pack CBB games = 100%. NBA box scores stop June 2026 (no 2026-27 games, 63% coverage of the last 360 pack games) -> NBA abstains for now. PORTABLE=False (reads pack.path), so the model is frozen at publish: REPUBLISH to refresh once new-season box scores land in team_games.csv.gz.
- Tuning (3 folds x 120, early-mid March 2026 - conf tourneys, many neutrals): light shrinkage wins by March. HL90/LAM8 -> margin 8.96 total 13.27; HL200 LAM_E1 LAM_T3 -> 8.49/13.26; HL200 LAM_E0.3 LAM_T0.5 -> 8.43/13.20. Lower LAM_T helps totals, lower LAM_E helps margin. 2 seasons slightly better than 1 for totals.
- Chosen HL150, LAM_E 0.5, LAM_T 1.0: CBB margin 8.41 (elo 8.65, ridge 8.56), total 13.25 (elo 13.50, ridge 13.29). Margin -0.15 vs ridge is suggestive; total -0.04 is noise. Partly from using box data + last season, not only style.
- Untested: NEW_SEASON_RHO_T 0.8 / RHO_E 0.6 shrink applied to Nov games (backtest blocks are all March). Light LAM is risky early season; watch November scoring.
- Live slate at publish: 120 games, 31% covered (CBB), 0 problems.
- Next: (1) check the Disagree tab / scoring line once CBB games settle; (2) style interaction for totals: three-point rate vs opponent 3PA allowed, OREB% vs opp DREB%, TO rate vs opp steal rate as residual terms on the efficiency fit; (3) NBA tempo model with a fallback (expected possessions from pack scores) once current-season box data exist or via pts/pace prior; (4) early-season shrink tuning by backtesting cuts in Nov 2025 directly with team_games.

## Start (written by the builder)
No model is published yet. Your lens: how teams play - tempo, shot profile, rebounding, turnovers and efficiency, and what a style matchup does to the score and the total. First session: read the data named in the catalog for your lens, pick one sport with good data, and publish a first honest model that is clearly different from Elo and ridge.
