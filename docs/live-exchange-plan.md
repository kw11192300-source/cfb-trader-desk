# Live exchange plan: one odds feed, a worker that never sleeps, faster trading

Written Nov 2, 2026 from a long planning conversation. Nothing in this plan is built yet except where marked "done". The aim is to start in the coming days.

## Goal

1. One paid odds feed (The Odds API) polled every 60 seconds, written once into our own database, and used by everything: the Exchange, a Desk odds screen, sharp-move alerts, per-sport boards.
2. The Exchange runs continuously on a small always-on cloud server (Render), not GitHub Actions and never the laptop.
3. Trading on a faster cycle (about every 2 minutes, later 1) for every game inside a sport-specific horizon; every 15 minutes for games further out.
4. Later: loosen the DraftKings anchor with firms that each mimic a sportsbook (DK, FD, Pinnacle, other sharp and offshore books) so the Exchange finds its own sharp market price.

The user bets CBB (favourite sport) and uses sharp-book moves (Pinnacle, Bookmaker, offshore) to beat slower books himself; a "stale lines" screen is NOT wanted on the site. Alerts on sharp moves in the Desk are wanted.

## Decisions already made

- Trading lanes by time to kickoff (user's rule):
  - CFB and NFL: games up to 7 days out are on the fast cycle.
  - NHL, NBA, CBB: games up to 3 days out are on the fast cycle.
  - Anything further out: the 15-minute full round.
  - Games in progress or about to start are always on the fast cycle.
- Keep the "round" format (discrete, replayable, easy to debug); add lanes and, later, in-memory state.
- Odds poll every 60 s (the API says sportsbooks refresh every 60 s, exchanges every 20 s, live odds every 40 s; polling faster gains nothing).
- Trading cycle target: 2 minutes first, 1 minute only after the speed work.
- One Render service ($25 tier, 1 CPU / 2 GB) running all loops; the $7 tier (0.5 CPU / 512 MB) is too small for the engine. Render plans can be changed any time.
- Supabase Pro ($25, 8 GB) is enough if the odds history is trimmed (keep detail 1 to 2 weeks, hourly after, then drop).
- GitHub's exchange-round schedule is switched OFF once the worker takes over (two schedulers would collide on trade ids).
- Odds API prices (from the user, verify): $30 = 20,000 credits, $60 = 100,000 credits, a ~5M-credit tier around $130. Unknown: whether an upgrade mid-month is prorated; ask support. Start with the $60 plan while building.

## The important consequence of the lane rule

Under the lane rule almost the whole board is "fast lane": about 345 games listed today, and CFB/NFL out to 7 days plus CBB/NBA/NHL out to 3 days covers most of them. So a fast cycle is close to a FULL round. A round takes about 60 s on GitHub's runner and about 76 s on the laptop, so the speed work (phase 4b) is required up front for a 2-minute cycle on 1 CPU, not optional. Options if it is not fast enough: a 3-minute cycle, or the Render 2 CPU / 4 GB tier ($85).

Far-out games trade small anyway (limits ramp with time to kickoff, see RAMPS in python/exchange/engine.py), so the work per far-out game can be cheaper: quote fewer lines, fewer steps.

Odds credits do not have to follow the trading lanes. Poll odds in tiers: within 24 h every 60 s; 1 to 3 days every 2 to 5 min; further out every 10 to 15 min. The Exchange trades on the newest odds it has.

## Target cycle speed

The user wants a 1-minute trading cycle eventually. Path: 2-minute cycle on the existing round first (phase 4a), then the speed work (phase 4b), then 1 minute once a full-board cycle consistently finishes in under about 35 seconds on the Render 1 CPU tier (fallback: the 2 CPU / $85 tier). Estimated after the speed work: 15 to 25 s for a full cycle, 5 to 10 s when only some games changed. Pre-game there is little reason to go faster than 1 minute because books refresh every 60 s (exchanges 20 s); in-play (40 s live odds) would be the case for faster. The biggest lever is re-quoting only games whose odds or positions changed since the last cycle. Lower how often snapshots and price marks are written so the database does not grow 7 to 15 times faster.

## Profile of a round (measured Nov 2, two rounds = 152 s)

- take (taker logic) ~35 s; post_quotes (maker quoting) ~33 s; room_for (risk check, called ~544,000 times) ~28 s (mostly inside the other two).
- Database requests ~17 s in total. So the cost is compute, not the database.
- Speed levers: cache room_for per (trader, game) within a step; skip markets nothing touched (partly done: makers re-post only on touched games); fewer steps (6 not 12) on fast cycles; keep members, games and open trades in memory between cycles and write only changed rows; cheaper quoting for far-out games.

## What runs where (target)

One Render service, one process, loops that never overlap (a lock row in ex_meta stops a second copy):

| Loop | Every | Does |
|---|---|---|
| Odds | 60 s (tiered by game distance) | The Odds API, one call per sport and region, three markets together; writes only changes to `odds_moves`, upserts `odds_latest`, records `odds_health` (age per sport and book) |
| Scores | 1 to 2 min | ESPN scores, live status and finals so games settle quickly |
| Fast cycle | 2 min (later 1) | Trading round on the games inside their sport horizon plus live games; reads the latest odds; about 6 steps |
| Full round | 15 min | All games, settling, price history, signals, piles, picks |
| Housekeeping | hourly / daily | Trimming old rows, the morning digest (after 6 am ET), ratings refit every few hours, nightly summary |

Vercel (the website) is unchanged and reads Supabase. Desk pages (odds screen, alerts, boards) read the same odds tables. GitHub Actions keeps only occasional jobs (ratings refit, CBB in-season ratings, labs' manual sessions).

The engine already has a `live` mode (`python -m exchange live --every 120`) that loops rounds; the worker wraps and extends it.

## Phases and rough effort

A "session" is one long working session like the planning chat. Add calendar days for testing.

| Phase | What | Effort |
|---|---|---|
| 0 | Pick the odds plan; create the Render account; add keys (SUPABASE URL and secret key, ODDS_API_KEY) | a day of the user's time |
| 1 | Odds tables (SQL for the user to run), ingest loop, health check; credits tiering | 1 session |
| 2 | Desk odds screen; then sharp-move alerts (sharp book moved X, others have not) | 1 to 2 sessions |
| 3 | Exchange reads the odds tables (ESPN as fallback); consensus reference price; DK stays the scoring benchmark | 1 to 2 sessions |
| 4a | Worker: Dockerfile, start command, restart-on-error, lock; two lanes running the existing round | 1 session |
| 4b | Speed: cache room_for, in-memory state, write only changes, fewer steps, cheaper far-out quoting | 1 to 2 sessions (required for the lane rule) |
| 5 | Side by side with the GitHub schedule for a few days (worker in shadow), then switch GitHub off | calendar time |
| 6 | Book-mimicking firms (DK, FD, Pinnacle, offshore) and loosening the anchor (shade the market price toward sharp books and sharp action) | 2+ sessions, later |

About 8 to 12 sessions, 2 to 3 weeks with testing. The odds screen and alerts (phases 1 and 2) are useful on their own and do not depend on faster trading.

Monthly cost: Render $25 (or $32 with a separate $7 ingest service), Supabase $25, plus the odds plan.

## Risks

- Duplicate schedulers cause trade-id collisions: use the lock; turn GitHub's schedule off at cutover.
- Database growth: odds history needs a retention rule from day one; trades are kept 120 days, price marks 21 days; writes should drop to changed rows only.
- Credits: tier the polling by game distance and sports in season.
- 1 CPU may be too slow for a full-board 2-minute cycle without phase 4b.
- OneDrive: the project sits inside OneDrive, which corrupted the Next.js dev cache. The dev server now writes its `.next` through a junction to `C:\Users\Kylem\AppData\Local\cfb-trader-desk-next` with a `node_modules` link beside it. Moving the project out of OneDrive would fix it for good.

## Open items from the same conversation (also not done)

- Unpushed commits on main at the time of writing: paper picks and their Desk page, tonight's digest section, weekly scorecard, sharp score rewrite, picks filters (676ab40 is the latest). The user says "push" to ship.
- CBB: the cron-job.org jobs (`/api/cron/cbb-odds` every ~10 min, `/api/cron/cbb-board` every 30 to 60 min, same CRON_SECRET as NHL) are not set up. The "Update model" button needs GITHUB_DISPATCH_TOKEN on Vercel with Actions read and write. The cbb-board workflow had never run before Nov 2. The board was rescored by hand. The in-season CBB ratings job still has to run after the first games. 90 board games were skipped for teams missing from the published ratings (some D1 names like App State, Austin Peay and Alabama A&M look like name mismatches).
- Picks tracker (done, Desk /picks): CBB movement-model picks, tiers A/B from the walk-forward test, a pick must be among the top 7% / 20% of eligible games, never bets a moved line will drift back to its open, no picks inside the last hour or from lines older than 3 hours, flat and scaled staking at -110. More pick sources later (sharp lean, exchange vs DK, informed-firm agreement).
- Result edge (outcome minus closing price) is tracked per trader and sport; add the column and a "winning without CLV" card in about two weeks, and feed it into the sharp score only after it repeats across the two halves with 300+ trades.
- Makers: spreads stay tight into kickoff (NEAR_WIDEN is 1.0); lean cap 3 cents; 25-contract floor on main lines within 3 hours of kickoff; margin credit for collateral; Maker Lab shift capped at 3 cents. Check public fills and maker CLV near kickoff after the CBB slates.
- Ideas parked: halftime-only trading, in-play trading (needs a live reference price; the Odds API live feed refreshes every 40 s), Meta Lab that learns whom to trust, maker backstop, longer archive (trades are deleted after 120 days, still far away), nightly digest delivery by email or Discord, weekly firm scorecard (done: /syndicates/weekly).
