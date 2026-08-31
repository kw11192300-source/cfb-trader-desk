# CFB Trader Desk — data & modeling

Python package that owns everything CFBD-related: historical backfill,
in-season sync, and (eventually) the prediction models. The Next.js app
never talks to CFBD directly — it just reads whatever this package has
already written into Supabase.

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

Both `sync_results` and `poll_lines` figure out "the current week" from our
own `games` table (`cfbd_ingest/current_week.py`) — the earliest
not-yet-completed game this calendar year.

## Scheduling (GitHub Actions)

`.github/workflows/sync-results.yml` and `.github/workflows/poll-lines.yml`
run these on a cron schedule, reading `CFBD_API_KEY`, `SUPABASE_URL`, and
`SUPABASE_SECRET_KEY` from the repo's Actions secrets (Settings → Secrets
and variables → Actions).

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
