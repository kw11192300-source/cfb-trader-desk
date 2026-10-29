-- Run once on the exchange tables you already created (adds what the shared-rulebook version needs). Safe to run twice.
alter table ex_syndicates add column if not exists learn jsonb not null default '{}';
alter table ex_games add column if not exists views jsonb;
alter table ex_games add column if not exists learned boolean not null default false;
