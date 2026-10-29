# Research brief for the syndicate labs

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
def predict(state, games) -> dict: ...     # {game_id: [expected home margin, expected total score]}; omit a game to abstain
```

`games` entries: `id, sport, home_id, away_id, home_name, away_name, neutral, start, dk` where `dk` is `None` for market-blind labs and otherwise
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
   model weight per sport, how many settled lines have scored, and your last backtest.
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

- **Fundamentals Lab (`labf`, market-blind):** you never see a betting line (the exchange strips `dk` and `pack.closing()` is empty). Build from results,
  team and player data, schedule and situational factors. Any edge you show is yours alone.
- **Market Lab (`labm`):** you may use lines. Study the market itself: how lines move from open to close, which moves hold and which fade, where DraftKings is
  late, how totals and spreads disagree with moneylines. Your model may be mostly a model of the line rather than of the teams.
- **Open Lab (`labo`):** anything, combined however you like. Your natural job is to find where fundamentals and the market disagree and decide who is right.
