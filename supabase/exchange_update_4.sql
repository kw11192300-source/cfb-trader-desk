-- Run once: the historical record of finished games (results, daily history and digest, housekeeping). Safe to run twice.
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
  settled_at timestamptz not null default now()
);
create index if not exists ex_results_day_idx on ex_results (day desc);
alter table ex_results enable row level security;
drop policy if exists "public read" on ex_results;
create policy "public read" on ex_results for select using (true);
