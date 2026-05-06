-- ============================================================================
-- Migration: Faltantes armador hub % upload types + subcategory KPIs
--
-- Replaces the computed hub-level faltantes % with direct Retool exports.
-- Adds 3 subcategory KPIs (FyV / Carnes / Graneles) whose tile flips show
-- top SKUs by count from the existing breakdown upload.
-- ============================================================================

-- Rename existing breakdown app so the upload page label is clear
UPDATE apps SET name_es = 'Faltantes Armador · Todos (breakdown)' WHERE id = 'faltantes_armador';

-- 4 new apps — one per hub % export from Retool (all identical column schema)
INSERT INTO apps (id, name_es, scope, expected_files_per_week, description) VALUES
  ('faltantes_hub_general_pct',  'Faltantes Armador · % General',             'total', 1, 'Hub-level % general exportado de Retool'),
  ('faltantes_hub_fyv_pct',      'Faltantes Armador · % FyV',                 'total', 1, 'Hub-level % FyV exportado de Retool'),
  ('faltantes_hub_carnes_pct',   'Faltantes Armador · % Carnes',              'total', 1, 'Hub-level % Carnes exportado de Retool'),
  ('faltantes_hub_graneles_pct', 'Faltantes Armador · % Graneles y Abarrotes','total', 1, 'Hub-level % Graneles exportado de Retool')
ON CONFLICT (id) DO NOTHING;

-- Column schemas — same format for all 4 hub % apps
INSERT INTO app_columns (app_id, position, name, type, role, required) VALUES
  ('faltantes_hub_general_pct',  0, 'Geofence ID',          'int',   'ignored',   false),
  ('faltantes_hub_general_pct',  1, 'Hub',                  'string','dimension', true),
  ('faltantes_hub_general_pct',  2, 'Ciudad',               'string','dimension', true),
  ('faltantes_hub_general_pct',  3, 'Faltante armador (%)', 'float', 'metric',    true),

  ('faltantes_hub_fyv_pct',      0, 'Geofence ID',          'int',   'ignored',   false),
  ('faltantes_hub_fyv_pct',      1, 'Hub',                  'string','dimension', true),
  ('faltantes_hub_fyv_pct',      2, 'Ciudad',               'string','dimension', true),
  ('faltantes_hub_fyv_pct',      3, 'Faltante armador (%)', 'float', 'metric',    true),

  ('faltantes_hub_carnes_pct',   0, 'Geofence ID',          'int',   'ignored',   false),
  ('faltantes_hub_carnes_pct',   1, 'Hub',                  'string','dimension', true),
  ('faltantes_hub_carnes_pct',   2, 'Ciudad',               'string','dimension', true),
  ('faltantes_hub_carnes_pct',   3, 'Faltante armador (%)', 'float', 'metric',    true),

  ('faltantes_hub_graneles_pct', 0, 'Geofence ID',          'int',   'ignored',   false),
  ('faltantes_hub_graneles_pct', 1, 'Hub',                  'string','dimension', true),
  ('faltantes_hub_graneles_pct', 2, 'Ciudad',               'string','dimension', true),
  ('faltantes_hub_graneles_pct', 3, 'Faltante armador (%)', 'float', 'metric',    true)
ON CONFLICT DO NOTHING;

-- Update existing KPI: source is now the hub % file, not the event log
UPDATE kpis
SET source_app_id    = 'faltantes_hub_general_pct',
    denominator_field = null
WHERE id = 'faltantes_armador_pct';

-- 3 new subcategory KPIs — hub % read directly, tile flip shows SKU ranking
INSERT INTO kpis (id, name_es, source_app_id, parent_kpi_id, numerator_field, denominator_field,
                  unit, direction, category, owner_role_id, watched_globally, weight, display_order)
VALUES
  ('faltantes_fyv_pct',      'Faltantes FyV (%)',             'faltantes_hub_fyv_pct',      'faltantes_armador_pct', null, null, 'pct', 'lower_is_better', 'calidad', 'aux_turno_matutino', false, 4, 41),
  ('faltantes_carnes_pct',   'Faltantes Carnes (%)',          'faltantes_hub_carnes_pct',   'faltantes_armador_pct', null, null, 'pct', 'lower_is_better', 'calidad', 'aux_turno_matutino', false, 4, 42),
  ('faltantes_graneles_pct', 'Faltantes Graneles y Aba. (%)', 'faltantes_hub_graneles_pct', 'faltantes_armador_pct', null, null, 'pct', 'lower_is_better', 'calidad', 'aux_turno_matutino', false, 4, 43)
ON CONFLICT (id) DO NOTHING;
