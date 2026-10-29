-- Run once (adds the exchange's own price to the price history). Safe to run twice.
alter table ex_marks add column if not exists e jsonb;
