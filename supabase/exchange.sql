-- ---------------------------------------------------------------------------------------------------------------------
-- Syndicates exchange (python/exchange): a paper-only exchange where rating-system "syndicates" trade binary contracts against each
-- other around the DraftKings price. Independent of every other table; read-only for the site, written by the Python jobs.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists ex_syndicates (
  id text primary key,
  name text not null,
  engine text not null,
  color text,
  tagline text,
  start_units numeric not null,
  learn jsonb not null default '{}'
);
create table if not exists ex_members (
  id text primary key,
  syndicate_id text not null references ex_syndicates(id),
  name text not null,
  role text not null,
  staking text not null,
  params jsonb not null default '{}',
  start_units numeric not null,
  cash numeric not null,
  locked numeric not null default 0,
  realized numeric not null default 0,
  equity numeric,
  open_risk numeric default 0,
  stats jsonb not null default '{}',
  updated_at timestamptz
);
create table if not exists ex_games (
  id text primary key,
  sport text not null,
  start_utc timestamptz not null,
  state text,
  completed boolean not null default false,
  voided boolean not null default false,
  neutral boolean not null default false,
  home jsonb,
  away jsonb,
  home_score integer,
  away_score integer,
  detail text,
  ref jsonb,
  ref_open jsonb,
  book jsonb,
  views jsonb,
  learned boolean not null default false,
  updated_at timestamptz
);
create index if not exists ex_games_open_idx on ex_games (completed);
create table if not exists ex_trades (
  id text primary key,
  ts timestamptz not null,
  round integer not null,
  game_id text not null,
  kind text not null,
  line numeric not null,
  price numeric not null,
  qty numeric not null,
  buyer text not null,
  seller text not null,
  maker text not null,
  ref_p numeric,
  rem_b numeric,
  rem_s numeric,
  settled boolean not null default false,
  outcome numeric,
  close_p numeric
);
create index if not exists ex_trades_settled_idx on ex_trades (settled);
create index if not exists ex_trades_ts_idx on ex_trades (ts desc);
create index if not exists ex_trades_game_idx on ex_trades (game_id);
create table if not exists ex_snapshots (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  subject text not null,
  equity numeric not null,
  realized numeric,
  open_risk numeric
);
create index if not exists ex_snapshots_subject_idx on ex_snapshots (subject, ts);
create table if not exists ex_marks (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  game_id text not null,
  lines jsonb not null,
  r jsonb not null,
  e jsonb
);
create index if not exists ex_marks_game_idx on ex_marks (game_id, ts);
create table if not exists ex_results (
  id text primary key,
  day date not null,
  sport text not null,
  kickoff timestamptz not null,
  home jsonb,
  away jsonb,
  home_score integer,
  away_score integer,
  n_trades integer not null default 0,
  contracts numeric not null default 0,
  traded numeric not null default 0,
  syn jsonb not null default '{}',
  traders jsonb not null default '{}',
  top jsonb,
  closing jsonb,
  settled_at timestamptz not null default now()
);
create index if not exists ex_results_day_idx on ex_results (day desc);
create table if not exists ex_ratings (
  key text primary key,
  payload jsonb not null,
  fitted_at timestamptz
);
create table if not exists ex_meta (
  key text primary key,
  value jsonb not null
);
alter table ex_syndicates enable row level security;
alter table ex_members enable row level security;
alter table ex_games enable row level security;
alter table ex_trades enable row level security;
alter table ex_snapshots enable row level security;
alter table ex_marks enable row level security;
alter table ex_results enable row level security;
alter table ex_ratings enable row level security;
alter table ex_meta enable row level security;
create policy "public read" on ex_syndicates for select using (true);
create policy "public read" on ex_members for select using (true);
create policy "public read" on ex_games for select using (true);
create policy "public read" on ex_trades for select using (true);
create policy "public read" on ex_snapshots for select using (true);
create policy "public read" on ex_marks for select using (true);
create policy "public read" on ex_results for select using (true);
create policy "public read" on ex_meta for select using (true);
-- ex_ratings is read by the Python jobs only (secret key bypasses RLS), so it has no public policy.
