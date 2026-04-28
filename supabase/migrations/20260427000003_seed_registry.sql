-- ============================================================================
-- Migration 003: Seed registry data
-- All seed values come from proposal §10, §11.4–11.7, §12.3.
-- Idempotent — safe to re-run via `supabase db reset`.
-- ============================================================================

-- Initial prompt version
insert into prompt_versions (id, notes, created_by) values
  (1, 'Initial seed', 'jose.romero@calii.com')
on conflict (id) do nothing;

-- Subdivisions (apply to SKUs and auxiliar focus, NOT to armadores — §11.4)
insert into subdivisions (id, name_es, description) values
  ('graneles_abarrotes', 'Graneles y abarrotes', 'Producto seco — abarrotes en general'),
  ('carnes',             'Carnes',                'Refrigerados y congelados — carnes, lácteos, embutidos'),
  ('frutas_verduras',    'Frutas y verduras',     'Producto fresco — FyV')
on conflict (id) do nothing;

-- Hubs (7 MHs across 4 cities — CH Guadalupe excluded entirely)
insert into hubs (id, display_name, city) values
  ('mh_contry',     'MH Contry',      'Monterrey'),
  ('mh_cumbres',    'MH Cumbres',     'Monterrey'),
  ('mh_san_nicolas','MH San Nicolás', 'Monterrey'),
  ('mh_guadalupe',  'MH Guadalupe',   'Monterrey'),
  ('mh_avicola',    'MH Avícola',     'Saltillo'),
  ('mh_zapopan',    'MH Zapopan',     'Guadalajara'),
  ('mh_condesa',    'MH Condesa',     'CDMX')
on conflict (id) do nothing;

-- Hub roles
insert into hub_roles (id, name_es, scope, responsibilities) values
  ('coordinador',         'Coordinador',                'per_hub',   'Estrategia del MH, escalamientos, ownership de KPIs hub-wide'),
  ('aux_inventarios',     'Auxiliar de inventarios',    'per_hub',   'Recepciones, inventarios, MNA abarrotes & carnes'),
  ('aux_calidad',         'Auxiliar de calidad',        'per_hub',   'Recepción y MNA de FyV, abastecimiento del cuarto de armado, calidad inbound'),
  ('aux_turno_matutino',  'Auxiliar de turno (AM)',     'per_shift', 'Liderar armadores y repartidores del turno matutino'),
  ('aux_turno_vespertino','Auxiliar de turno (PM)',     'per_shift', 'Liderar armadores y repartidores del turno vespertino'),
  ('armador',             'Armador',                    'per_hub',   'Armado de pedidos (todas las subdivisiones)'),
  ('repartidor',          'Repartidor',                 'per_hub',   'Entregas en ventana de 2h')
on conflict (id) do nothing;

-- Cross-team scope
insert into teams (id, name_es, decides) values
  ('operaciones', 'Operaciones', 'Recepciones, armado, entrega, depuración MNA, asistencia, calidad inbound del MH'),
  ('compras',     'Compras',     'Solicitudes al CH, cantidades, tiers, negociación con proveedores, devoluciones, deshabilitar compra'),
  ('comercial',   'Comercial',   'Catálogo en app, precios, promociones, ventana de disponibilidad por SKU'),
  ('tecnologia',  'Tecnología',  'App de armado, integraciones, infraestructura')
on conflict (id) do nothing;

-- Driver exclusion patterns (test/pickup accounts — §11.6)
insert into driver_exclusion_patterns (pattern, reason) values
  ('pickup',      'Self-pickup placeholder driver'),
  ('prueba',      'Test/QA driver'),
  ('mcc android', 'QA mobile-app test driver'),
  ('test',        'Generic test driver')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Apps + their column schemas
-- ----------------------------------------------------------------------------
insert into apps (id, name_es, scope, expected_files_per_week, description) values
  ('desempeno_operadores', 'Desempeño operadores',  'per_city', 4, 'Métricas semanales por armador'),
  ('faltantes_armador',    'Faltantes armador',     'total',    1, 'Eventos de faltante reportados por armadores'),
  ('mna',                  'MNA · Mercancía no apta','per_hub', 7, 'Snapshot semanal por SKU por hub'),
  ('incidentes',           'Incidentes',            'per_city', 4, 'Incidentes reportados (manuales + automáticos)'),
  ('desempeno_repartidores','Desempeño repartidores','per_city',4, 'Métricas semanales por repartidor')
on conflict (id) do nothing;

-- desempeno_operadores columns (41 columns from sample)
insert into app_columns (app_id, position, name, type, role, required) values
  ('desempeno_operadores',  0, 'operator_id',                              'string',   'id',         true),
  ('desempeno_operadores',  1, 'city',                                     'string',   'dimension',  true),
  ('desempeno_operadores',  2, 'geofence',                                 'string',   'dimension',  true),
  ('desempeno_operadores',  3, 'assembler',                                'string',   'dimension',  true),
  ('desempeno_operadores',  4, 'subdivision',                              'string',   'dimension',  false),
  ('desempeno_operadores',  5, 'num_assembled',                            'int',      'metric',     true),
  ('desempeno_operadores',  6, 'num_orders_with_missing_items',            'int',      'metric',     true),
  ('desempeno_operadores',  7, 'num_orders_with_partial_missing',          'int',      'metric',     true),
  ('desempeno_operadores',  8, 'num_orders_with_full_missing',             'int',      'metric',     true),
  ('desempeno_operadores',  9, 'num_orders_with_bad_quality',              'int',      'metric',     true),
  ('desempeno_operadores', 10, 'num_orders_with_incidents',                'int',      'metric',     true),
  ('desempeno_operadores', 11, 'num_absences_including_justified',         'int',      'metric',     true),
  ('desempeno_operadores', 12, 'num_idle_days',                            'int',      'metric',     true),
  ('desempeno_operadores', 13, 'num_tardy',                                'int',      'metric',     true),
  ('desempeno_operadores', 14, 'num_tardy_including_justified',            'int',      'metric',     true),
  ('desempeno_operadores', 15, 'issues_comments',                          'list',     'free_text',  false),
  ('desempeno_operadores', 16, 'issues_order_ids',                         'list',     'ignored',    false),
  ('desempeno_operadores', 17, 'order_issue_ids',                          'list',     'ignored',    false),
  ('desempeno_operadores', 18, 'entries_with_missing_assembly_ids',        'list',     'ignored',    false),
  ('desempeno_operadores', 19, 'order_total_multiplier',                   'float',    'metric',     false),
  ('desempeno_operadores', 20, 'entries_with_missing_barcode_ids',         'list',     'ignored',    false),
  ('desempeno_operadores', 21, 'entries_with_missing_expiration_date_ids', 'list',     'ignored',    false),
  ('desempeno_operadores', 22, 'num_orders_with_missing_barcode',          'int',      'metric',     true),
  ('desempeno_operadores', 23, 'num_orders_with_missing_expiration_date',  'int',      'metric',     true),
  ('desempeno_operadores', 24, 'num_orders_with_pending_confirmation',     'int',      'metric',     true),
  ('desempeno_operadores', 25, 'num_orders_with_faltante_armador',         'int',      'metric',     true),
  ('desempeno_operadores', 26, 'last_acknowledgement_at',                  'datetime', 'ignored',    false),
  ('desempeno_operadores', 27, 'total_num_min_of_assembly',                'float',    'metric',     true),
  ('desempeno_operadores', 28, 'total_idle_time_min',                      'float',    'metric',     true),
  ('desempeno_operadores', 29, 'avg_finish_time',                          'string',   'dimension',  false),
  ('desempeno_operadores', 30, 'avg_start_time',                           'string',   'dimension',  false),
  ('desempeno_operadores', 31, 'avg_min_per_assembly',                     'float',    'metric',     true),
  ('desempeno_operadores', 32, 'backcompat_avg_min_per_assembly',          'float',    'metric',     false),
  ('desempeno_operadores', 33, 'num_assembled_late',                       'int',      'metric',     true),
  ('desempeno_operadores', 34, 'percent_assembled_late',                   'float',    'metric',     true),
  ('desempeno_operadores', 35, 'num_skus_per_hour_assembly_rate',          'float',    'metric',     true),
  ('desempeno_operadores', 36, 'num_skus_assembled',                       'int',      'metric',     true),
  ('desempeno_operadores', 37, 'normalized_num_assembly_minutes',          'float',    'metric',     true),
  ('desempeno_operadores', 38, 'num_absences',                             'int',      'metric',     true),
  ('desempeno_operadores', 39, 'receives_bonus',                           'bool',     'metric',     false),
  ('desempeno_operadores', 40, 'performance_alerts',                       'string',   'free_text',  false)
on conflict do nothing;

-- faltantes_armador columns (11)
insert into app_columns (app_id, position, name, type, role, required) values
  ('faltantes_armador',  0, 'Geofence ID',           'int',      'ignored',   false),
  ('faltantes_armador',  1, 'Hub',                   'string',   'dimension', true),
  ('faltantes_armador',  2, 'Ciudad',                'string',   'dimension', true),
  ('faltantes_armador',  3, 'Item ID',               'string',   'id',        true),
  ('faltantes_armador',  4, 'Producto',              'string',   'dimension', true),
  ('faltantes_armador',  5, 'Operator ID',           'string',   'id',        true),
  ('faltantes_armador',  6, 'Armador',               'string',   'dimension', true),
  ('faltantes_armador',  7, 'Fecha',                 'datetime', 'dimension', true),
  ('faltantes_armador',  8, 'Inventario disponible', 'int',      'metric',    false),
  ('faltantes_armador',  9, 'Notas armador',         'string',   'free_text', false),
  ('faltantes_armador', 10, 'Anulado',               'string',   'ignored',   false)
on conflict do nothing;

-- mna columns (22)
insert into app_columns (app_id, position, name, type, role, required) values
  ('mna',  0, 'Producto',                       'string',   'dimension', true),
  ('mna',  1, 'SKU Calii',                      'string',   'id',        true),
  ('mna',  2, 'SKU Proveedor',                  'string',   'id',        false),
  ('mna',  3, 'Código de barras',               'string',   'id',        false),
  ('mna',  4, 'Tiers',                          'string',   'dimension', false),
  ('mna',  5, 'Proveedor',                      'string',   'dimension', true),
  ('mna',  6, 'Kg/Pz',                          'string',   'dimension', true),
  ('mna',  7, 'Source price',                   'float',    'metric',    false),
  ('mna',  8, 'Recibido',                       'float',    'metric',    false),
  ('mna',  9, 'MNA (kg/pz)',                    'float',    'metric',    false),
  ('mna', 10, 'MNA ($)',                        'float',    'metric',    true),
  ('mna', 11, 'MNA (%)',                        'float',    'metric',    true),
  ('mna', 12, 'Inventario',                     'float',    'metric',    true),
  ('mna', 13, '1 en N pedidos',                 'float',    'metric',    false),
  ('mna', 14, 'Out-of-stock (%)',               'float',    'metric',    true),
  ('mna', 15, 'Consumo / día',                  'float',    'metric',    false),
  ('mna', 16, 'Compra deshabilitada',           'bool',     'metric',    false),
  ('mna', 17, 'Disponible en app',              'bool',     'metric',    false),
  ('mna', 18, 'Hubs out of stock',              'int',      'metric',    false),
  ('mna', 19, 'city',                           'string',   'dimension', true),
  ('mna', 20, 'Días de inventario',             'string',   'metric',    false),
  ('mna', 21, 'Represanta X% de merma total',   'float',    'metric',    false)
on conflict do nothing;

-- incidentes columns (5)
insert into app_columns (app_id, position, name, type, role, required) values
  ('incidentes', 0, 'Notas',             'string',   'free_text', false),
  ('incidentes', 1, 'Fecha',             'datetime', 'dimension', true),
  ('incidentes', 2, 'Responsable',       'string',   'dimension', true),
  ('incidentes', 3, 'Operador',          'string',   'dimension', true),
  ('incidentes', 4, 'Tipo de incidente', 'string',   'dimension', true)
on conflict do nothing;

-- desempeno_repartidores columns (30)
insert into app_columns (app_id, position, name, type, role, required) values
  ('desempeno_repartidores',  0, 'driver_id',                      'string',   'id',        true),
  ('desempeno_repartidores',  1, 'driver_name',                    'string',   'dimension', true),
  ('desempeno_repartidores',  2, 'driver_nickname',                'string',   'dimension', false),
  ('desempeno_repartidores',  3, 'hub',                            'string',   'dimension', true),
  ('desempeno_repartidores',  4, 'orders_for_driver_ids',          'list',     'ignored',   false),
  ('desempeno_repartidores',  5, 'orders_data',                    'json',     'ignored',   false),
  ('desempeno_repartidores',  6, 'num_orders',                     'int',      'metric',    true),
  ('desempeno_repartidores',  7, 'num_undelivered_orders',         'int',      'metric',    true),
  ('desempeno_repartidores',  8, 'num_assigned_orders',            'int',      'metric',    true),
  ('desempeno_repartidores',  9, 'num_late_orders',                'int',      'metric',    true),
  ('desempeno_repartidores', 10, 'num_early_orders',               'int',      'metric',    false),
  ('desempeno_repartidores', 11, 'num_admin_incidents',            'int',      'metric',    true),
  ('desempeno_repartidores', 12, 'num_absences',                   'int',      'metric',    true),
  ('desempeno_repartidores', 13, 'num_tardy',                      'int',      'metric',    true),
  ('desempeno_repartidores', 14, 'admin_incidents',                'list',     'ignored',   false),
  ('desempeno_repartidores', 15, 'client_issues_for_driver',       'list',     'free_text', false),
  ('desempeno_repartidores', 16, 'num_orders_with_missing_items',  'int',      'metric',    true),
  ('desempeno_repartidores', 17, 'num_orders_with_partial_missing','int',      'metric',    true),
  ('desempeno_repartidores', 18, 'num_orders_with_full_missing',   'int',      'metric',    true),
  ('desempeno_repartidores', 19, 'num_orders_with_bad_quality',    'int',      'metric',    true),
  ('desempeno_repartidores', 20, 'num_orders_with_incidents',      'int',      'metric',    true),
  ('desempeno_repartidores', 21, 'num_orders_with_three_or_more_wrong','int',  'metric',    false),
  ('desempeno_repartidores', 22, 'total_num_missing_items',        'int',      'metric',    false),
  ('desempeno_repartidores', 23, 'issues_comments',                'list',     'free_text', false),
  ('desempeno_repartidores', 24, 'order_issue_ids',                'list',     'ignored',   false),
  ('desempeno_repartidores', 25, 'num_driver_orders_with_eggs',    'int',      'metric',    false),
  ('desempeno_repartidores', 26, 'num_issues_with_eggs',           'int',      'metric',    false),
  ('desempeno_repartidores', 27, 'km_per_hr',                      'float',    'metric',    false),
  ('desempeno_repartidores', 28, 'total_driving_distance_km',      'float',    'metric',    false),
  ('desempeno_repartidores', 29, 'delivery_rate_computed_at',      'datetime', 'ignored',   false)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- KPIs — the catalog (parent + breakdown structure from proposal §10.3a)
-- ----------------------------------------------------------------------------
insert into kpis (id, name_es, source_app_id, parent_kpi_id, numerator_field, denominator_field,
                  unit, direction, category, owner_role_id, watched_globally, weight, display_order) values

  -- Productividad
  ('tasa_armado',         'Tasa de armado',          'desempeno_operadores', null,
   'num_skus_per_hour_assembly_rate', null, 'rate',  'higher_is_better', 'productividad',
   'aux_turno_matutino', true, 5, 10),

  ('pct_armado_tardio',   '% armado tardío',         'desempeno_operadores', null,
   'percent_assembled_late', null, 'pct',  'lower_is_better', 'productividad',
   'aux_turno_matutino', false, 3, 20),

  -- Inventario / MNA
  ('mna_pct',             'MNA (%)',                 'mna', null,
   'MNA ($)', 'Recibido', 'pct', 'lower_is_better', 'inventario',
   'aux_inventarios', true, 5, 30),

  ('mna_graneles_pct',    'MNA Graneles (%)',        'mna', 'mna_pct',
   null, null, 'pct', 'lower_is_better', 'inventario',
   'aux_inventarios', false, 4, 31),

  ('mna_carnes_pct',      'MNA Carnes (%)',          'mna', 'mna_pct',
   null, null, 'pct', 'lower_is_better', 'inventario',
   'aux_inventarios', false, 4, 32),

  ('mna_fyv_pct',         'MNA FyV (%)',             'mna', 'mna_pct',
   null, null, 'pct', 'lower_is_better', 'inventario',
   'aux_calidad', false, 4, 33),

  -- Faltantes armador (pre-entrega)
  ('faltantes_armador_pct','Faltantes armador (%)', 'faltantes_armador', null,
   null, 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_turno_matutino', true, 5, 40),

  -- Incidentes manuales (de cliente) — parent + breakdown
  ('incidentes_manuales_pct', 'Incidentes manuales (%)', 'desempeno_operadores', null,
   'num_orders_with_incidents', 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_turno_matutino', true, 5, 50),

  ('incidentes_calidad_pct',  'Calidad (%)',          'desempeno_operadores', 'incidentes_manuales_pct',
   'num_orders_with_bad_quality', 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_calidad', false, 4, 51),

  ('incidentes_faltantes_pct','Faltantes incidentes (%)','desempeno_operadores', 'incidentes_manuales_pct',
   'num_orders_with_missing_items', 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_inventarios', false, 4, 52),

  ('incidentes_faltantes_completos_pct','Faltantes completos (%)','desempeno_operadores', 'incidentes_faltantes_pct',
   'num_orders_with_full_missing', 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_inventarios', false, 3, 53),

  ('incidentes_faltantes_parciales_pct','Faltantes parciales (%)','desempeno_operadores', 'incidentes_faltantes_pct',
   'num_orders_with_partial_missing', 'num_assembled', 'pct', 'lower_is_better', 'calidad',
   'aux_turno_matutino', false, 3, 54),

  -- Logística reparto
  ('pct_tardias_reparto', '% entregas tardías',      'desempeno_repartidores', null,
   'num_late_orders', 'num_orders', 'pct', 'lower_is_better', 'logistica',
   'aux_turno_matutino', true, 5, 60),

  ('pct_undelivered',     '% entregas no realizadas','desempeno_repartidores', null,
   'num_undelivered_orders', 'num_assigned_orders', 'pct', 'lower_is_better', 'logistica',
   'aux_turno_matutino', false, 3, 61),

  ('eggs_issue_rate',     'Issues con huevos (%)',   'desempeno_repartidores', null,
   'num_issues_with_eggs', 'num_driver_orders_with_eggs', 'pct', 'lower_is_better', 'calidad',
   'aux_turno_matutino', false, 2, 62),

  -- Calidad — derived "entregas erróneas" KPI (count, classified from Notas)
  ('entregas_erroneas',   'Entregas erróneas (count)','incidentes', null,
   null, null, 'count', 'lower_is_better', 'calidad',
   'aux_turno_matutino', true, 5, 70)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Behavior rules (§11.7) — into the AI's system prompt
-- ----------------------------------------------------------------------------
insert into behavior_rules (rule_text, rationale, display_order, prompt_version_added) values
  ('No actuar sobre operadores con <3 semanas de tenencia salvo z-score ≥ 5σ.',
   'Gente nueva tiene ruido alto; recomendar acción puede ser injusto.',
   10, 1),

  ('No repetir el mismo top-3 dos semanas seguidas — si persiste, escalar como "3ª semana consecutiva — escalamiento estructural".',
   'Evita repetición sin valor; promueve cuando el patrón se vuelve crónico.',
   20, 1),

  ('Headlines auto-contenidos: nombrar KPI, sujeto, magnitud y peer group con scope explícito.',
   'Headlines ambiguos no son accionables.',
   30, 1),

  ('Comparaciones de hubs ponderar más same-city que cross-city. MTY vs GDL no son peers naturales (diferente cadena de suministro).',
   'GDL/CDMX se reabastecen 1× por semana; MTY 2× por día.',
   40, 1),

  ('Armadores no se segmentan por subdivisión. Peer-grouping por hub → ciudad → global.',
   'Cada picker arma pedidos de las 3 categorías; subdivisión no es peer key.',
   50, 1),

  ('Lenguaje: español neutro, terminología interna (MH, armador, repartidor, MNA, FyV, MA, ventana, faltante, depuración).',
   'Coincide con el vocabulario operacional.',
   60, 1),

  ('Respeta scope cross-team. Recomendaciones primarias sólo para roles de Operaciones. Hallazgos cross-team se rotulan "Flag a [equipo]".',
   'Operaciones no negocia con proveedores ni construye solicitudes al CH.',
   70, 1),

  ('Citar la fuente de datos en cada insight (archivo CSV, semanas/filas, paso de procesamiento).',
   'El usuario debe poder verificar sin pedir permiso.',
   80, 1),

  ('Semana operativa: viernes a jueves. "Esta semana" = semana vie-jue más recientemente subida.',
   'Lunes-domingo no es la semana operativa de Calii.',
   90, 1)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Scope rules (§12.3) — flag-to-team rules
-- ----------------------------------------------------------------------------
insert into scope_rules (trigger_text, target_team_id, flag_label_es, example_good, example_bad, prompt_version_added) values
  ('supplier negotiations / renegotiate tier / vendor returns',
   'compras', 'Flag a Compras',
   'Flag a Compras: SSQ938 (Salsa Pa'' Todo) lleva 4 sem concentrando 11% de la MNA Zapopan; candidato a renegociar tier o devolución.',
   'Negociar con Salsa Pa'' Todo cambio de tier.',
   1),

  ('build / adjust solicitud al CH / next supply order',
   'compras', 'Flag a Compras',
   'Flag a Compras: Reducir Crackers Susalia 144g en próximo abasto del jue 30 abr (30 días de inventario actual + 38% MNA contribución).',
   'Ajustar la solicitud al CH para reducir Crackers Susalia.',
   1),

  ('tier changes / disable purchase / sku activation',
   'compras', 'Flag a Compras',
   'Flag a Compras: 8 SKUs de Carnes con >30 días de inventario — candidatos a ajuste de tier.',
   'Bajar tier de 8 SKUs de Carnes.',
   1),

  ('catalog changes / enable-disable SKU in app / pricing',
   'comercial', 'Flag a Comercial',
   'Flag a Comercial: SKU X candidato a desactivar en catálogo por baja rotación.',
   'Desactivar SKU X en la app.',
   1),

  ('app changes / integrations / scanner issues',
   'tecnologia', 'Flag a Tecnología',
   'Flag a Tecnología: 12% de armadores reportan errores de escaneo en codes de Crackers Susalia — revisar barcode parsing.',
   'Arreglar el bug de escaneo.',
   1)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Headline examples — few-shot good/bad for the AI
-- ----------------------------------------------------------------------------
insert into headline_examples (kind, text_es, reasoning, prompt_version_added) values
  ('good',
   'Tasa de armado de Miguel A. Escobedo (MH Guadalupe): 78 SKUs/hr — 26% debajo del promedio de armadores en MTY (105 SKUs/hr), 3ª semana consecutiva',
   'Nombra KPI, sujeto, magnitud absoluta y peer group con scope explícito. Adicionalmente nota la recurrencia (3ª sem).',
   1),

  ('bad',
   'Miguel sigue 26% por debajo del promedio de Graneles',
   'No nombra el KPI. Peer group inválido (los pickers no se segmentan por subdivisión). Magnitud ambigua sin valor absoluto.',
   1),

  ('good',
   'MNA de abarrotes en MH Zapopan creció 38% WoW; sólo 5 días hasta el siguiente abasto desde CH',
   'Nombra KPI con subdivisión, scope, magnitud relativa, y contexto urgente (cadencia de reabasto).',
   1),

  ('bad',
   'MNA subió mucho en GDL',
   'Sin magnitud, sin subdivisión, sin contexto temporal.',
   1)
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Operating context sections (§11) — markdown editable in Configuración
-- ----------------------------------------------------------------------------
insert into context_sections (id, display_order, title_es, body_md, updated_by) values
  ('overview', 10, 'Calii — qué hace',
'Calii es una empresa de entrega de supermercado a domicilio en México, operando en 4 ciudades: Monterrey (4 MHs + 1 CH), Saltillo (1 MH), Guadalajara (1 MH), CDMX (1 MH). El modelo central es entrega rápida — ventana de 2 horas — con armado y last-mile entregado por personal propio.

Tres categorías: Graneles y abarrotes (seco), Carnes (refrigerados/congelados), Frutas y verduras (fresco).',
   'jose.romero@calii.com'),

  ('supply_chain', 20, 'Cadena de suministro por ciudad',
'MTY (4 MHs): 2 abastos diarios desde CH — AM abarrotes, PM FyV (comprada en MA) + carnes.
Saltillo (1 MH): 1 abasto diario desde CH (las 3 categorías consolidadas).
GDL (1 MH) y CDMX (1 MH): 1 abasto semanal desde CH (sólo abarrotes y carnes); FyV se compra diaria en MA local.

**Implicación:** OOS o MNA en abarrotes/carnes en GDL/CDMX es mucho más urgente que en MTY — no hay reabasto rápido.',
   'jose.romero@calii.com'),

  ('roles', 30, 'Estructura del MH y roles',
'Coordinador (1) · Aux. inventarios (Graneles + Carnes) · Aux. calidad (FyV) · Aux. turno matutino · Aux. turno vespertino · Armadores · Repartidores.

**Armadores: NO se segmentan por subdivisión.** Cada picker arma pedidos que incluyen las 3 categorías. Subdivisión sí aplica a SKUs en MNA y al área de enfoque de cada auxiliar.

3PL: introducido hace ~3 sem, <10% de entregas. No aparece en `desempeno_repartidores`.',
   'jose.romero@calii.com'),

  ('cross_team', 40, 'Estructura cross-team — Ops vs Compras vs Comercial',
'**Operaciones (esta app):** recepciones, armado, entrega, depuración MNA, asistencia, calidad inbound del MH, inventario del MH.
**Compras (CH):** construcción de solicitud al CH, cantidades, tiers, negociación con proveedores, devoluciones, deshabilitar compra.
**Comercial:** catálogo en app, precios, promociones, ventana de disponibilidad por SKU.
**Tecnología:** app de armado, integraciones, infraestructura.

Recomendaciones primarias deben ser ejecutables por Operaciones. Hallazgos cross-team se rotulan **"Flag a [equipo]"**, no como acciones de Ops.',
   'jose.romero@calii.com'),

  ('metric_nuances', 50, 'Métricas con matices',
'**Tasa de armado:** cuenta desde asignación, no desde el inicio físico del armado. Idle alto + tasa baja = problema de arranque, no de velocidad.

**Tardías reparto:** contrastar con km/hr y % armado tardío para diagnosticar fault.

**Undelivered:** reprogramado/cancelado al EOD. Outlier vs peers usualmente = protocolo no cumplido (10 min + 3 llamadas).

**Faltantes:** tres causas — error de inventario, mala calidad, no localizado. Cada causa rutea a un rol distinto.',
   'jose.romero@calii.com'),

  ('week_definition', 60, 'Definición de semana operativa',
'La semana corre de **viernes a jueves** (no lunes a domingo).

Cadencia de uploads: cada viernes en la mañana, Jose descarga de Retool los datos cubriendo el viernes-anterior hasta el jueves-de-ayer. El `week_start` en la base es ese viernes; el label "Sem del vie DD MMM — jue DD MMM".

"Esta semana" siempre se refiere a la semana vie-jue más recientemente subida. La regeneración automática de insights se programa los viernes después del último upload del día.',
   'jose.romero@calii.com')
on conflict (id) do nothing;
