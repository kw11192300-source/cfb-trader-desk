-- Run once: adds the closing-price record to each finished game's result (DraftKings, Kalshi, the exchange and every syndicate's view,
-- plus how each line came out) so the exchange can be judged against DraftKings. Safe to run twice.
alter table ex_results add column if not exists closing jsonb;
