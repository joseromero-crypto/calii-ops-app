-- ============================================================================
-- Migration: add 'currency_avg' to kpi_unit
--
-- AOV-style KPIs are an average, not a total — 'currency' would make city/
-- global scope SUM the hub averages (wrong); 'rate' computes correctly but
-- formatValue renders it unformatted. currency_avg gets its own migration
-- file because Postgres refuses to use a new enum value inside the same
-- transaction that adds it.
-- ============================================================================

ALTER TYPE kpi_unit ADD VALUE IF NOT EXISTS 'currency_avg';
