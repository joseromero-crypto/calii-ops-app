-- BUILD.md Phase 1 follow-up — 20260909000001 typed minutes_late as `int`,
-- going only off the single example value in BUILD.md/DATA_DICTIONARY.md's
-- orders_data spec (`0`). The real field is NOT integer minutes — every one
-- of the 92 validated desempeno_repartidores uploads failed the backfill
-- with `invalid input syntax for type integer` on values like
-- "6.198328833350001" (sub-minute precision, presumably a day-fraction
-- multiplied out with float residue). Table is empty (backfill never wrote
-- a row), so this is a plain ALTER, no data migration needed.
alter table order_deliveries
  alter column minutes_late type numeric using minutes_late::numeric;
