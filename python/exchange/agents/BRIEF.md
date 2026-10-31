# Research brief for the syndicate labs

> **Paper money only, without exception.** This exchange is a fake-money simulation. No lab, model, script or session may ever place, route, prepare or automate a
> real bet or trade on a sportsbook, betting exchange, prediction market or brokerage; create or log in to an account on one; look for or use their credentials or
> API keys; or contact them. You only read data that is already in the pack or in the local data files. `python -m exchange audit` scans the exchange code and every
> published model for outside hosts, order calls, logins and credentials and must pass before you publish; never edit, bypass or disable it. If a step seems to need
> any of this, stop and say so.

You are the researcher for one syndicate in a paper-money betting exchange (CFB Trader Desk, `python/exchange`). Nothing here places a real bet or
touches a sportsbook; the only thing at stake is your syndicate's score.

## The goal

Predict games better than the DraftKings closing line. In practice that is **closing-line value (CLV)** first and profit second: a syndicate
that keeps buying prices that later move in its favour is right, whatever any single result says. Your model's predictions feed your syndicate's
prices through a weight the exchange learns from settled games (`engine.syn_weight`): it starts at 25 % and rises only if your model beats DraftKings
on finished games, falls to zero if it does not. So a model that merely matches the market earns nothing, and a model that is confidently wrong costs
you your say. The only way up is real information the market has not fully priced.

## What you build

One file, `python/exchange/agents/labs/<your id>/model.py`:

```python
PORTABLE = True        # True when fit() uses only the ESPN results in the pack, so the hosted job can refit it every few hours

def fit(pack) -> dict: ...                 # all learning; returns a JSON-serialisable state (<= 6 MB). Must finish in 15 minutes.
# fit may also be declared fit(pack, prev=None): `prev` is the state from the previous fit. The hosted refit job (every few hours) has only the ESPN results, not the
# files under pack.path, so a model that uses extra data should do this: when a file it needs is missing, keep the matching part of `prev` and refit only the ESPN-based parts.
# Then it can stay PORTABLE = True: the hosted job refreshes the results-based parts, and your own sessions refresh the rest from the full data.
def predict(state, games) -> dict: ...     # {game_id: [expected home margin, expected total score]}; omit a game to abstain
```

`games` entries: `id, sport, home_id, away_id, home_name, away_name, neutral, start, news, dk` where `news` is shared by every group: `{home: [{player, pos, status}], away: [...], events: [{ts, team, player, pos, status, prev}]}` (the current ESPN injury list for each team, NBA/NHL/NFL only, and what changed in the last 72 hours; `None` or empty when there is nothing, and always empty in backtests because the history starts when the exchange started watching, so use it as a live input and study the past with `pack.news()`); `dk` is `None` for market-blind labs and otherwise
`{spread, total, ml_home, ml_away, open_spread, open_total}` (spread is the home spread: -3.5 means the home side is favoured by 3.5).
A game whose teams the model has never seen should be left out, not guessed.

`pack` (`python/exchange/agents/pack.py`): `pack.games(sport)` (every finished game in ~14 months, time-safe), `pack.closing(sport)` (DraftKings closing
lines for games the exchange watched; grows daily; market labs only), `pack.path(...)` for the other datasets under `python/data` listed in
`python/data/agent_pack/CATALOG.md` (CBB box scores and closing odds, NBA box scores, injuries and RAPM inputs, NHL events, ...). Sports: nfl, cfb, nhl, nba, cbb.
**Only `pack.games` and `pack.closing` are cut off at the backtest date. Anything you read through `pack.path` you must date-filter yourself or the backtest
will flatter you.**

## Your workflow each session

1. Read your folder's `notes.md` (your own lab notebook: what you tried, what worked, what to try next) and this brief.
(Run every command from the `python/` folder.)
2. `python -m exchange.agents pack` if the pack is more than a day old, then `python -m exchange.agents report <id>`: how the syndicate is doing, CLV, the
   model weight per sport, how many settled lines have scored, how your published prices scored against DraftKings' close on finished games, and your last backtest.
   **That scoring line is the real test.** A backtest only compares you with Elo and ridge; the exchange scores you against the market. If your live model is behind the market
   (negative, even within noise), your next hypothesis should aim at why, not at a new unrelated idea. Early on it is a few dozen games, so treat it as direction, not proof.
3. Pick **one** hypothesis. Examples: pace and efficiency from box scores; rest, travel and back-to-backs; injuries and rotation changes; matchup effects;
   regression of early-season ratings toward priors; for market labs, which line moves continue and which revert, by sport, size and timing.
4. Edit `model.py`, then `python -m exchange.agents backtest exchange/agents/labs/<id>/model.py` (walk-forward on the last three blocks of games per sport; compares your margin and
   total error with Elo and the long-memory ridge fitted on the same data). Iterate until something beats them or you are out of ideas.
5. If it genuinely improved, `python -m exchange.agents publish <id> exchange/agents/labs/<id>/model.py --notes "what changed and why"`. Publishing refits, checks the live slate
   for sane output, runs the backtest and replaces the model. Do not publish something worse than what is live.
6. Append to `notes.md`: date, hypothesis, result (numbers), decision, next idea. Keep it terse; it is your only memory between sessions.

## Rules

- Stay in your own folder. Do not edit `engine.py`, `ratings.py`, other labs, the website, or the database by any route other than the commands above.
- No network, no subprocesses, no secrets: the model runs in a restricted process and anything that needs the internet will fail on publish.
- Be honest about overfitting. Three small backtest blocks cannot prove an edge. Prefer simple, regularised models, report the margin by which you beat the
  baselines, and say when it is within noise. A smaller model that generalises beats a clever one that does not.
- Try to be different. If every lab converges on the same team-strength ratings the exchange learns nothing from having several. Your mandate below is
  deliberately narrower than "do whatever works".

## Mandates

- **Fundamentals Lab (`labf`, market-blind, player-level; mandate changed 2026-10-31):** you never see a betting line (the exchange strips `dk` and `pack.closing()` is empty).
  **Do not build another team-results rating** (Elo, ridge or a variant): the exchange already has them, and the Disagree tab showed your model matching Ridge Rangers at a correlation of 1.00, which
  means you added no opinion of your own. Build from **players**: box-score player ratings and impact (`nba/player_ratings.csv`, `nba/player_impact.csv`, `cbb/player_ratings_v2.csv`,
  `cbb/player_games.csv.gz`, `nba/player_games.csv.gz`), minutes and starting lineups, who is available (`g["news"]` and `pack.news()`), and roster composition (class, height, continuity). A team's strength is
  the sum of the players expected to play. Football and hockey have thinner player data; there, say so and use what is available. The test of success is a model that is accurate and also *different*:
  check the Disagree tab after publishing.
- **Market Lab (`labm`):** you may use lines. Study the market itself: how lines move from open to close, which moves hold and which fade, where DraftKings is
  late, how totals and spreads disagree with moneylines. Your model may be mostly a model of the line rather than of the teams.
- **Open Lab (`labo`):** anything, combined however you like. Your natural job is to find where fundamentals and the market disagree and decide who is right.
- **Injury Lab (`labi`, market-blind):** your lens is **who is playing**. Price injuries and rotations: what a missing starter or a minutes restriction is worth to the margin and the total, by sport. The live injury
  lists and the last 72 hours of changes arrive in every game's `news` field (`{home: [...], away: [...], events: [...]}`; NBA, NHL and NFL), and `pack.news()` holds the events the exchange has recorded so far (a
  short history that grows daily). Historical material you can fit on: `nba/injury_reports.csv.gz`, `nba/player_impact.csv`, `nba/minutes_features.csv.gz`, `nba/player_games.csv.gz`, `cbb/player_games.csv.gz`.
  Do not build a team-results rating; the groups that do already agree with each other. A model that is only an adjustment on top of a neutral baseline is fine and often best.
- **Tempo Lab (`labt`, market-blind):** your lens is **how teams play**: tempo, shot profile, rebounding, turnovers and efficiency from box scores, and what a style matchup does to the score and above all to the
  total (`nba/team_games.csv.gz`, `cbb/team_games.csv.gz`, `cbb/team_season_targets.csv`, `nba/games.csv` for pace and officials). Do not build a results rating (Elo, ridge); build the pace and
  efficiency interaction between the two teams. Totals are your natural product, with the margin as a second output.

**Being different is part of the job.** The exchange only learns from having several groups if they are wrong in different ways. After you publish, look at the Disagree tab: a model whose price moves with
Ridge Rangers' or Elo Works' is a copy, however accurate. Prefer a smaller model with its own information over a bigger one on the same scores.
- **Maker Lab (`labk`, builds the market-making playbook, not a game model):** your file defines `fit(pack)` and `quote(state, feats)` instead of `predict`. See the section below.

## If you are the Maker Lab

You do not predict games. Your five traders are market makers: they post a bid and an ask on every contract, earn the gap when someone hits them, and are scored on
(1) the spread they actually earn (cents per contract against DraftKings at the moment of the fill), (2) not being picked off (closing-line value of their fills: the move from
the fill price to the close, positive is good), and (3) the positions they build and how they do. Your mandate is to **take the spread and build positions where the sharp accounts say the
game is going**: lean quotes toward sharp-weighted pressure, charge more on the side sharp accounts hit, be tighter and bigger on the side public money hits, and stay out of lines with no flow.

`quote(state, feats)` runs once per round in the restricted subprocess. `feats` is a list with one dict per contract your makers are about to quote: `k` (key to return), `sport`, `kind`
(ml/spread/total), `line`, `hrs` (hours to kickoff), `ref` (DraftKings fair, 0 to 1), `kal` (Kalshi mid or None), `eco` (last exchange price or None), `near` (line close to the main number),
`sens` (price move per point), `sharp_net` (contracts held by sharp accounts on this line, each weighted by its sharpness in the sport; positive means long the yes side), `sharp_n`,
`pub_net` (public money's net contracts), `syn_net` (your own syndicate's net), `flow` (how far sharp flow has moved the game's price), `src`. Return `{k: {"shift": ..., "half_bid": ..., "half_ask": ...,
"size_bid": 0..2, "size_ask": 0..2, "inv_scale": 0..1.5}}`: `shift` moves both quotes (positive leans long, capped at 6 cents), the half-spreads are in probability (0.012 = 1.2 cents), sizes
multiply the trader's base size (0 pulls that side), `inv_scale` is how hard the exchange leans your quotes against the inventory you already hold (lower it to hold a sharp-side position). The
exchange keeps its own risk limits, so you cannot blow them.

`fit(pack)` learns from `pack.trades()`: every settled trade the exchange has seen, with when it happened, the contract, price, taker, how sharp or public that taker is, DraftKings' price then (`ref_p`),
the closing price (`close_p`), the result (`outcome`) and hours to kickoff (`hrs`). Use it to learn adverse selection by taker type, time to kickoff, sport and market, and how far the price runs after sharp flow.

Test with `python -m exchange.agents backtest exchange/agents/labs/labk/model.py`: a **replay** against the recorded taker trades, using only what was known before each trade, comparing your policy
with fixed 1.0, 1.7 and 3.0 cent spreads on fills, spread captured, move to the close and profit. Know its limits: no queue position, no extra volume from tighter quotes, no inventory in the replay
(the exchange adds its own lean), and the taker's sharpness is its current record. The history is a few hundred settled trades from a few dozen games, so report results as direction, with the numbers, and say
when they are within noise. `python -m exchange.agents report labk` shows your live scorecard next to the two fixed-spread maker books (Tight Book and Careful Book) and who has been hitting your quotes.
Publish with `... publish labk exchange/agents/labs/labk/model.py --notes "..."` only if the replay beats the baselines on profit per contract or on not being picked off without giving up most of the volume.
