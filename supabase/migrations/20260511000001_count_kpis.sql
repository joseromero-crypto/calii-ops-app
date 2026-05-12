-- ============================================================================
-- Migration 006: Count KPIs for the report generator
--
-- pedidos_armados : raw order count per assembler — provides denominator
--                   context so the report can say "X% en Y pedidos".
--
-- retardos_count  : count of times a repartidor arrived late to work
--                   (num_tardy). Distinct from entregas tardías (pct_tardias_reparto),
--                   which measures delivery-window performance. Shown as count
--                   in the Retardos section of the weekly report.
-- ============================================================================

insert into kpis (
  id, name_es, source_app_id, parent_kpi_id,
  numerator_field, denominator_field,
  unit, direction, category,
  owner_role_id, watched_globally, weight, display_order
) values
  -- Order count per assembler (context for incidentes % interpretation)
  (
    'pedidos_armados', 'Pedidos armados',
    'desempeno_operadores', null,
    'num_assembled', null,
    'count', 'higher_is_better', 'productividad',
    'aux_turno_matutino', false, 1, 9
  ),

  -- Times late to work per driver (NOT late deliveries — that is pct_tardias_reparto)
  (
    'retardos_count', 'Retardos (conteo)',
    'desempeno_repartidores', null,
    'num_tardy', null,
    'count', 'lower_is_better', 'logistica',
    'aux_turno_matutino', false, 1, 59
  )
on conflict (id) do nothing;
