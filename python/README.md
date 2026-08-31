# CFB Trader Desk — data & modeling

Python package that owns all data ingestion — historical backfill and
in-season sync from **two separate providers** — and (eventually) the
prediction models. The Next.js app never talks to either API directly — it
just reads whatever this package has already written into Supabase.

- **CFBD** (collegefootballdata.com) — games, historical data/stats/ratings,
  and points-only betting lines from 3 books (DraftKings, ESPN Bet, Bovada).
  Source of truth for everything except real per-book pricing.
- **The Odds API** (the-odds-api.com) — real per-side juice (-110, -105,
  etc.) and a wider book set (FanDuel, BetMGM, BetRivers, Caesars, Bovada,
  and more). Current-state only, no historical depth — supplements CFBD's
  odds rather than replacing them. See `cfbd_ingest/team_match.py` for how
  its events get matched to our CFBD-sourced games (no shared game id
  between the two providers).

## Setup

```bash
cd python
python -m venv .venv
./.venv/Scripts/activate   # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
```

Config is read from the **repo-root** `.env.local` (same file the Next.js
app uses — see `cfbd_ingest/config.py`), not a separate `python/.env`.

## Scripts

| Script | What it does | Typical cadence |
|---|---|---|
| `python -m cfbd_ingest.backfill --start 2015 --end 2026` | One-time historical pull: teams, games, lines, stats, ratings for a season range. Safe to re-run (everything upserts on CFBD's own ids). | once, or whenever you want to widen the history range |
| `python -m cfbd_ingest.sync_results` | Refreshes scores/completion, team stats, ratings for the *current* season only (~11 CFBD calls/run). Does **not** touch betting lines. | a few times a day |
| `python -m cfbd_ingest.poll_lines` | Fetches the current week's lines, updates `betting_lines` (latest snapshot) and appends to `line_snapshots` (full history — what the CLV/movement model trains on). 1 CFBD call/run. | every 1–15 min during game week |
| `python -m cfbd_ingest.sync_odds_api` | Fetches current NCAAF odds from The Odds API, matches events to our games, upserts `odds_api_lines` (current state, with real juice). 1 API call/run = 3 credits. | every 4–6 hrs on the free tier |

Both `sync_results` and `poll_lines` figure out "the current week" from our
own `games` table (`cfbd_ingest/current_week.py`) — the earliest
not-yet-completed game this calendar year.

## Scheduling (GitHub Actions)

`.github/workflows/sync-results.yml`, `poll-lines.yml`, and
`poll-odds-api.yml` run these on a cron schedule, reading `CFBD_API_KEY`,
`ODDS_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` from the repo's
Actions secrets (Settings → Secrets and variables → Actions).

## Call budget by poll-lines cadence

Each `poll_lines` run is exactly **1 CFBD call**, so the math is simple —
pick a cadence based on your CFBD tier (see `collegefootballdata.com/api-tiers`):

| Cadence | Calls/month (24/7) | Fits in |
|---|---|---|
| Every 15 min | ~2,900 | Free tier (1,000/mo) if only run during game weeks; Tier 1 ($1/mo, 5k) for 24/7 |
| Every 5 min | ~8,600 | Tier 1 ($1/mo, 5k) during game weeks; Tier 2 ($5/mo, 30k) for 24/7 |
| Every 2 min | ~21,600 | Tier 2 ($5/mo, 30k) |
| Every 1 min | ~43,200 | Tier 3 ($10/mo, 75k) |
| Every 30 sec | ~86,400 | Tier 4 ($15/mo, 125k) |

CFBD tier upgrades are just a Patreon pledge linked to your existing
account — same API key, no code or secret changes needed, higher quota
applies automatically. See `collegefootballdata.com/api-tiers` and
`patreon.com/cw/collegefootballdata`.

`sync_results` adds roughly 11 calls per run on top of whatever
`poll_lines` cadence you pick — negligible at a few runs/day.

## Call budget by sync_odds_api cadence

Separate quota from CFBD — The Odds API's free tier is 500 credits/month,
and each `sync_odds_api` run costs 3 credits (spreads+totals+h2h, `us`
region) regardless of how many games it covers:

| Cadence | Credits/month (24/7) | Fits in |
|---|---|---|
| Every 6 hrs | ~360 | Free tier (500/mo) — current default |
| Every 4 hrs | ~540 | Just over — needs $30/mo (20k) |
| Every 2 hrs | ~1,080 | $30/mo tier (20k), plenty of headroom |
| Every 1 min | ~130,000 | $119/mo tier (5M) |

Juice moves far slower than the point spread itself (books mostly sit at
standard pricing and only reprice on real signal), so tight cadence matters
much less here than for `poll_lines`. Upgrading is the same trivial story
as CFBD: same API key, no code changes, just change plans in their
dashboard. See `the-odds-api.com/#get-access` for current pricing.
