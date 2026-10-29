-- Run once on the exchange tables you already have (netting, worst-case risk, price history). Safe to run twice.
alter table ex_trades add column if not exists rem_b numeric;
alter table ex_trades add column if not exists rem_s numeric;
create table if not exists ex_marks (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  game_id text not null,
  lines jsonb not null,
  r jsonb not null
);
create index if not exists ex_marks_game_idx on ex_marks (game_id, ts);
alter table ex_marks enable row level security;
drop policy if exists "public read" on ex_marks;
create policy "public read" on ex_marks for select using (true);
