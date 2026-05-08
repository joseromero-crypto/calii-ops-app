-- ============================================================
-- Calii Ops — Discrepancia KPI Setup  (v2 — includes app_columns)
-- Run once in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Register the upload app
INSERT INTO apps (id, name_es, scope, expected_files_per_week, active)
VALUES ('discrepancia', 'Discrepancia repartidores', 'total', 1, true)
ON CONFLICT (id) DO UPDATE SET
  name_es                 = EXCLUDED.name_es,
  scope                   = EXCLUDED.scope,
  expected_files_per_week = EXCLUDED.expected_files_per_week,
  active                  = EXCLUDED.active;

-- 2. Register all 15 CSV columns for the app
--    Columns with role='ignored' are stored but not used by kpi-compute.
--    The four key columns (Repartidor, Hub, expected, deposited) are required=true.
--    Defining all columns eliminates the 15 "extra column" upload warnings.
DELETE FROM app_columns WHERE app_id = 'discrepancia';

INSERT INTO app_columns (app_id, position, name, type, role, required, notes) VALUES
  ('discrepancia',  1,  'Operator ID',                    'string',  'id',        false, 'ID de operador en Retool'),
  ('discrepancia',  2,  'Repartidor',                     'string',  'dimension', true,  'Nombre completo del repartidor'),
  ('discrepancia',  3,  'Hub',                            'string',  'dimension', true,  'Nombre del hub (resuelto a mh_* por kpi-compute)'),
  ('discrepancia',  4,  'Apodo',                          'string',  'free_text', false, 'Apodo / nombre corto'),
  ('discrepancia',  5,  'ID efectivo',                    'string',  'id',        false, 'ID de efectivo en Retool'),
  ('discrepancia',  6,  'Cálculo digital efectivo',       'float',   'metric',    true,  'Monto esperado según pedidos entregados'),
  ('discrepancia',  7,  'Conciliación manual',            'float',   'metric',    true,  'Monto realmente depositado / conciliado'),
  ('discrepancia',  8,  'Conciliación Panamericano',      'float',   'ignored',   false, NULL),
  ('discrepancia',  9,  'Diferencia Panamericano',        'float',   'ignored',   false, NULL),
  ('discrepancia', 10,  'Cálculo digital vales',          'float',   'ignored',   false, NULL),
  ('discrepancia', 11,  'Conciliación Clip',              'float',   'ignored',   false, NULL),
  ('discrepancia', 12,  'Diferencia vales',               'float',   'ignored',   false, NULL),
  ('discrepancia', 13,  'Por devolver',                   'int',     'ignored',   false, NULL),
  ('discrepancia', 14,  'Devoluciones confirmadas',       'int',     'ignored',   false, NULL),
  ('discrepancia', 15,  'Diferencia devoluciones',        'float',   'ignored',   false, NULL);

-- 3. Register the KPI
INSERT INTO kpis (
  id, name_es, unit, direction, category,
  active, display_order, source_app_id,
  watched_globally, numerator_field, denominator_field, parent_kpi_id, owner_role_id
)
VALUES (
  'discrepancia_mxn',
  'Discrepancia ($)',
  'currency',
  'lower_is_better',
  'Repartidores',
  true,
  999,
  'discrepancia',
  true,
  NULL,
  NULL,
  NULL,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_es          = EXCLUDED.name_es,
  unit             = EXCLUDED.unit,
  direction        = EXCLUDED.direction,
  category         = EXCLUDED.category,
  active           = EXCLUDED.active,
  display_order    = EXCLUDED.display_order,
  source_app_id    = EXCLUDED.source_app_id,
  watched_globally = EXCLUDED.watched_globally;

-- ============================================================
-- After running this SQL:
--   1. Go to /upload, re-upload the discrepancia CSV for the week
--      (the previous upload stored empty rows — needs a re-upload)
--   2. Hit Recompute
--   3. discrepancia_mxn KPI tile + driver WoW chart appear in Por Hub
-- ============================================================
