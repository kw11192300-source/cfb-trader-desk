-- CFB Trader Desk schema
-- Paste into Supabase's SQL editor (Project -> SQL Editor -> New query) and run.
--
-- Design notes:
--   * `id` columns for games/teams reuse CFBD's own numeric IDs directly (no
--     surrogate keys) so ingestion is a plain upsert keyed on CFBD's id.
--   * Advanced/derived stats (PPA, SP+, FPI, SRS, Elo, per-category team
--     stats) vary in shape release to release, so they're stored as JSONB
--     blobs rather than exploded into dozens of columns. Query them with
--     Postgres's `->` / `->>` operators, or flatten in Python with
--     pandas.json_normalize when building model features.
--   * betting_lines keeps one row per (game, provider) so open/close and
--     movement can be compared per book, not just a flattened consensus.

create table if not exists teams (
  id integer primary key,                 -- CFBD team id
  school text not null,
  mascot text,
  conference text,
  classification text,                    -- fbs / fcs / ii / iii
  color text,
  alt_color text,
  logo_url text
);

create table if not exists games (
  id bigint primary key,                  -- CFBD game id
  season integer not null,
  week integer not null,
  season_type text not null default 'regular',   -- regular / postseason
  start_date timestamptz not null,
  completed boolean not null default false,
  neutral_site boolean not null default false,
  venue text,

  home_id integer references teams(id),
  home_team text not null,
  home_conference text,
  home_points integer,

  away_id integer references teams(id),
  away_team text not null,
  away_conference text,
  away_points integer,

  updated_at timestamptz not null default now()
);

create index if not exists games_season_week_idx on games(season, week);
create index if not exists games_home_id_idx on games(home_id);
create index if not exists games_away_id_idx on games(away_id);

-- One row per (game, sportsbook). Open/close captured per provider so line
-- movement can be computed per book rather than only against a consensus.
create table if not exists betting_lines (
  game_id bigint not null references games(id) on delete cascade,
  provider text not null,

  spread numeric,
  spread_open numeric,
  over_under numeric,
  over_under_open numeric,
  home_moneyline integer,
  away_moneyline integer,
  formatted_spread text,

  fetched_at timestamptz not null default now(),

  primary key (game_id, provider)
);

-- Append-only line history: one row per (game, provider) EVERY time
-- poll_lines.py runs, never overwritten. betting_lines above only ever
-- holds the latest snapshot (what the UI reads as "current"); this table is
-- what the line-movement/CLV model trains on — it reconstructs each game's
-- full open-to-close trajectory from these rows, keyed by capture time
-- rather than just open vs. current.
create table if not exists line_snapshots (
  id bigserial primary key,
  game_id bigint not null references games(id) on delete cascade,
  provider text not null,
  spread numeric,
  over_under numeric,
  home_moneyline integer,
  away_moneyline integer,
  captured_at timestamptz not null default now()
);
create index if not exists line_snapshots_game_provider_time_idx on line_snapshots(game_id, provider, captured_at);

-- Season-level team stats (rushing/passing/defense/etc, PPA, success rate,
-- explosiveness, havoc...). One row per (season, team), full payload as JSONB.
create table if not exists team_season_stats (
  season integer not null,
  team_id integer not null references teams(id),
  team text not null,
  stats jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (season, team_id)
);

-- Game-level advanced stats (per-game PPA/success rate/etc). One row per
-- (game, team) since both teams' advanced box-score stats come per game.
create table if not exists team_game_stats (
  game_id bigint not null references games(id) on delete cascade,
  team_id integer not null references teams(id),
  team text not null,
  stats jsonb not null,
  primary key (game_id, team_id)
);

-- Team ratings/power indices by season (and week, where the source
-- publishes weekly updates — e.g. Elo can move week to week). `week` is 0
-- for season-level/final values (SP+, FPI, SRS are season-only; Elo backfill
-- also uses 0 for the season's final rating) — NULL can't be used here since
-- it's part of the primary key, which Postgres treats as implicitly NOT
-- NULL. `source` distinguishes sp_plus / fpi / srs / elo; `rating` holds
-- that source's full payload (composite + sub-components where applicable).
create table if not exists team_ratings (
  season integer not null,
  week integer not null default 0,
  team_id integer not null references teams(id),
  team text not null,
  source text not null,                   -- 'sp_plus' | 'fpi' | 'srs' | 'elo'
  rating jsonb not null,
  primary key (season, team_id, source, week)
);

-- Model output. One row per (game, model_version) so backtests of an older
-- model version stay intact even as newer versions are added.
create table if not exists predictions (
  game_id bigint not null references games(id) on delete cascade,
  model_version text not null,

  predicted_home_win_prob numeric,
  predicted_margin numeric,               -- home points minus away points
  predicted_total numeric,

  market_spread numeric,                  -- home team's spread, matches betting_lines convention
  market_total numeric,
  edge_spread numeric,                    -- predicted_margin - (-market_spread)
  edge_total numeric,                     -- predicted_total - market_total

  predicted_clv_move numeric,             -- expected |close - open| for the best-covered book
  predicted_clv_direction text,           -- which side the line is expected to move toward

  created_at timestamptz not null default now(),

  primary key (game_id, model_version)
);

create index if not exists predictions_game_id_idx on predictions(game_id);

-- Row Level Security: the Next.js app reads Supabase with the PUBLISHABLE
-- key (safe to expose to the browser, unlike SUPABASE_SECRET_KEY which only
-- the Python ingestion scripts and GitHub Actions ever see). With RLS off
-- (the default), that publishable key could read AND write every table
-- through the REST API directly — anyone with devtools open could see it
-- and hit the API themselves. Since every table here is public sports data
-- (no user accounts, nothing private), the fix is simple: turn RLS on and
-- allow SELECT to everyone, INSERT/UPDATE/DELETE to no one. The secret key
-- (service role) bypasses RLS entirely, so the Python ingestion scripts are
-- unaffected — they keep writing exactly as before.
alter table teams enable row level security;
alter table games enable row level security;
alter table betting_lines enable row level security;
alter table line_snapshots enable row level security;
alter table team_season_stats enable row level security;
alter table team_game_stats enable row level security;
alter table team_ratings enable row level security;
alter table predictions enable row level security;

create policy "public read" on teams for select using (true);
create policy "public read" on games for select using (true);
create policy "public read" on betting_lines for select using (true);
create policy "public read" on line_snapshots for select using (true);
create policy "public read" on team_season_stats for select using (true);
create policy "public read" on team_game_stats for select using (true);
create policy "public read" on team_ratings for select using (true);
create policy "public read" on predictions for select using (true);
