# Exchange evolution plan: firms that improve, spin off, retire, and learn who is informed

Written Nov 2, 2026. None of this is built. It follows the live-exchange worker work in `docs/live-exchange-plan.md` (every added trader slows the rounds, so the faster cycle comes first).

## Where things stand (how firms "improve" today)

- Elo Works, Ridge Rangers, Form Guide: ratings refit every few hours on new results (Form Guide also relearns the size of each schedule effect). Structure does not change.
- Tape Readers and Fade Club: a fixed rule (extend or fade the DraftKings line move since the open). Only their model weight and thresholds adapt.
- Consensus Desk, Totals Desk, Kalshi Followers, House Models, Liquidity Partners (a control with no model): logic fixed; inputs update.
- Market makers: quote width and inventory lean adapt; no view of the game.
- Every non-lab trader: `adapt()` moves its edge threshold or spread 0.25 cents at a time from its own CLV.
- Every firm: model weight by sport (25% to 75%) learned from results.
- Labs: fundamentally change only when the user runs a lab session (Fundamentals v3, Open v4, Market v3, Maker v2, Injury v1, Tempo v1). Labs are never scheduled; the user runs them by hand.

So almost nothing changes structure by itself. These ideas add selection and learning without anyone rewriting models.

## 1. Spin-offs (a good trader leaves and starts a small firm)

The user likes this. The system PROPOSES spin-offs and retirements; the user APPROVES every one (a click on a review page, or by asking). Nothing happens automatically.

- Trigger: on a schedule (about monthly). Rank traders by the low end of their CLV range and their result edge. Candidates need a clearly positive CLV range over a decent record (suggest 300+ settled trades).
- The new firm: copy that trader's settings (edge threshold, half-spread, size, kelly, `follow`, `eta`, sport focus) with small random mutations; optionally a different mix of model inputs.
- Capital: a small bankroll (about half normal) with reduced limits during probation of about 300 settled trades.
- Verdict after probation: CLV range clearly positive means graduate to normal size; clearly negative means flag for retirement; in between keeps going.
- Fixed headcount: every added trader slows each round, so a spin-off replaces a retired trader and total traders stay capped (about 100 to 120). This matters most once the cycle runs every 1 to 2 minutes.
- Build: roster currently comes from `python/exchange/members.py`; firms and traders are rows in `ex_syndicates` and `ex_members`. Needs: dynamic creation of rows at runtime, a probation flag and counters, a proposals table (`ex_meta` key), and a "Review" page with approve and reject. About 1 to 2 sessions, after the live worker.

## 2. Retire or reset (flagged, user decides)

- Flag a firm or trader when its CLV range stays below zero after a few hundred trades and results agree.
- Options on each flag: retire (stop trading, keep history), reset (fresh settings), or replace with a spin-off. Nothing is deleted.
- Shown on the same Review page.

## 3. Move capital toward what works

- Monthly (or on approval): shift some bankroll from firms with clearly negative CLV ranges toward firms with clearly positive ones. Gives real selection without rewriting models. Proposed on the Review page, approved by the user.

## 4. Tuning job for Elo, Ridge and Form settings

- Offline walk-forward job that tests how fast ratings move, home advantage, memory length and regularization per sport on past games and proposes the best set with its backtest gain.
- Run by hand; the user reviews before applying. Heavy on CPU, so run locally or in a GitHub Action, not in the worker loop. About 1 session.

## 5. Teach the firms who is informed (flow learning)

What exists: every trader sees the same engine-computed sharp score for every other trader. A maker hit by a taker moves its read by `MM_REACT * eta * IMPACT * (0.5 + taker sharp score)` (public money counts far less, `PUBLIC_REACT`) and widens that contract's quote (`tox`). Every trader shifts its prices toward sharp traders' flow by its own fixed `follow` setting. Fixed constants: `follow`, `eta`, `IMPACT`.

What is not learned: `follow` and `eta` never adjust; nobody tests whether following the flow improved its own CLV; counterparties are known only through the sharp score; the belief-update formula is a constant.

Ideas:
- Let `follow` and `eta` adjust from results the way the edge threshold does in `adapt()`.
- Measure what a counterparty's hit does to the exchange price afterwards (price impact), in addition to its CLV against the close.
- Score informativeness by sport, market kind and time before kickoff.
- This is the core of the Meta Lab idea. Risk: herding, where everyone follows the same few sharp traders and the price amplifies their noise; the sharp score is already discounted for short records (about 25 trades for half credit).

## 6. Other firm types not yet built (most useful first)

1. Firms that read the Exchange's own flow: a public fader (fades Main Street) and a sharp follower.
2. News and late-information firm using the shared injury events and the logged price reactions (cheapest to build).
3. Meta firm that learns whom to trust (see 5).
4. Weather, travel and officiating labs for football and NBA totals.
5. NHL goalie and CBB roster versions of Injury Lab.
6. Book-mimicking firms (DK, FD, Pinnacle, offshore) once the odds feed exists; later loosen the DK anchor.
7. Early-season and opening-line specialist (matters for CBB).

## 7. Housekeeping ideas

- A model changelog per lab on the Models tab (what each version changed, and whether it helped).
- Weekly firm scorecard exists (`/syndicates/weekly`); result-edge column and a "winning without CLV" card in about two weeks.
