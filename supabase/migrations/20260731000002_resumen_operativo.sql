-- ============================================================================
-- Migration: "Resumen operativo" — hub-level weekly Retool rollup
--
-- New app (resumen_operativo, per_city, 4 files/week), its 20-column schema,
-- and 8 new KPIs (category = 'operacion' — the routing key the frontend uses
-- to keep these out of Por Hub tiles / Comparativa / the coordinator report
-- until the filter-only commit + this migration have both landed — see
-- PLAN_RESUMEN_OPERATIVO.md §5 / §9a).
--
-- Explicit column lists throughout: production `apps` has group_id /
-- group_label_es columns that exist in no local migration file (the
-- migrations folder has drifted from production) — do not use `insert into
-- apps default values` or a bare column-less insert here.
--
-- Depends on 20260731000001_kpi_unit_currency_avg.sql having been run first
-- (own transaction) so 'currency_avg' is a committed enum value before this
-- file's kpis insert can use it.
-- ============================================================================

INSERT INTO apps (id, name_es, scope, expected_files_per_week, description) VALUES
  ('resumen_operativo', 'Resumen operativo semanal', 'per_city', 4, 'Rollup hub-level semanal exportado de Retool')
ON CONFLICT (id) DO NOTHING;

-- app_columns — all 20 CSV columns, exact header strings (accents + spaces
-- matter — coerceRows matches on literal header string). Every metric is
-- required:false — MH San Pedro ships the literal string 'NaN' in several
-- columns, and validate.ts only counts NaN as a type_mismatch for required
-- numeric columns (>5% hard-fails the whole upload). Only Hub is required.
INSERT INTO app_columns (app_id, position, name, type, role, required) VALUES
  ('resumen_operativo',  0, 'Hub',                                       'string',   'dimension', true),
  ('resumen_operativo',  1, 'Pedidos (#)',                                'int',      'metric',    false),
  ('resumen_operativo',  2, 'Pendiente entrega (#)',                      'int',      'metric',    false),
  ('resumen_operativo',  3, 'Armadores (#)',                              'int',      'metric',    false),
  ('resumen_operativo',  4, 'Pedidos con faltantes armador (%)',          'float',    'metric',    false),
  ('resumen_operativo',  5, 'Retrasos armado (%)',                        'float',    'metric',    false),
  ('resumen_operativo',  6, 'Nro. de pedidos / armador / día',            'float',    'metric',    false),
  ('resumen_operativo',  7, 'Comienzo armado',                            'datetime', 'ignored',   false),
  ('resumen_operativo',  8, 'Finalización armado',                        'datetime', 'ignored',   false),
  ('resumen_operativo',  9, 'Pendiente armado (#)',                       'int',      'metric',    false),
  ('resumen_operativo', 10, 'Repartidores (#)',                           'int',      'metric',    false),
  ('resumen_operativo', 11, 'Retrasos entrega (%)',                       'float',    'metric',    false),
  ('resumen_operativo', 12, 'Nro. de entregas / repartidor / día',        'float',    'metric',    false),
  ('resumen_operativo', 13, 'Comienzo entregas',                          'datetime', 'ignored',   false),
  ('resumen_operativo', 14, 'Finalización entregas',                      'datetime', 'ignored',   false),
  ('resumen_operativo', 15, 'Pedidos con incidentes clientes (%)',        'float',    'metric',    false),
  ('resumen_operativo', 16, 'Pedidos con mala calidad (%)',                'float',    'metric',    false),
  ('resumen_operativo', 17, 'Pedidos con faltantes cliente (%)',          'float',    'metric',    false),
  ('resumen_operativo', 18, 'AOV',                                        'float',    'metric',    false),
  ('resumen_operativo', 19, 'Entregas fallidas (%)',                      'float',    'metric',    false)
ON CONFLICT DO NOTHING;

-- kpis — 8 rows, all category='operacion' (the isResumenKpi routing key).
-- numerator_field/denominator_field are null: values are computed by the
-- dedicated extractResumenOperativoValues extractor (lib/kpi-compute.ts),
-- not the generic numerator_field/denominator_field CSV-lookup path used by
-- desempeno_operadores/desempeno_repartidores KPIs. Same pattern as
-- faltantes_armador_pct (direct-read KPI, no CSV field shorthand).
-- owner_role_id left null — these are hub-wide volume/staffing facts, not
-- owned by a single role. weight=3 (kpis_weight_check requires 1-5).
INSERT INTO kpis (id, name_es, source_app_id, parent_kpi_id, numerator_field, denominator_field,
                  unit, direction, category, owner_role_id, watched_globally, weight, active, display_order) VALUES
  ('pedidos_hub',                 'Pedidos (#)',                   'resumen_operativo', null, null, null, 'count',        'higher_is_better', 'operacion', null, false, 3, true, 200),
  ('pedidos_entregados',          'Pedidos entregados (#)',        'resumen_operativo', null, null, null, 'count',        'higher_is_better', 'operacion', null, false, 3, true, 201),
  ('aov_mxn',                     'AOV',                           'resumen_operativo', null, null, null, 'currency_avg', 'higher_is_better', 'operacion', null, false, 3, true, 202),
  ('ingresos_hub',                'Ingresos estimados',            'resumen_operativo', null, null, null, 'currency',     'higher_is_better', 'operacion', null, false, 3, true, 203),
  ('pedidos_por_armador_dia',     'Pedidos / armador / día',       'resumen_operativo', null, null, null, 'rate',         'higher_is_better', 'operacion', null, false, 3, true, 204),
  ('entregas_por_repartidor_dia', 'Entregas / repartidor / día',   'resumen_operativo', null, null, null, 'rate',         'higher_is_better', 'operacion', null, false, 3, true, 205),
  ('armadores_activos',           'Armadores (#)',                 'resumen_operativo', null, null, null, 'count',        'higher_is_better', 'operacion', null, false, 3, true, 206),
  ('repartidores_activos',        'Repartidores (#)',              'resumen_operativo', null, null, null, 'count',        'higher_is_better', 'operacion', null, false, 3, true, 207)
ON CONFLICT (id) DO NOTHING;
