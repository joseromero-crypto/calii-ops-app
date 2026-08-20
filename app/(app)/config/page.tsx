import { createServerClient } from '@/lib/supabase-server';
import { KpiTargetsSection } from './KpiTargetsSection';
import { RampTargetsSection, type RampTargetRow, type BadgedPersonRow } from './RampTargetsSection';
import type { KpiTarget } from '../historicos/_shared';
import { defaultComparator } from '@/lib/kpi-direction';
import { lastCompletedWeekStart } from '@/lib/types';
import {
  hydrateTenureRow, tenureStatus, tenureCode,
  type PersonTenureDbRow, type Role as TenureRole,
} from '@/lib/tenure';

export const dynamic = 'force-dynamic';

export default async function ConfigPage() {
  const supabase = createServerClient();

  // Same resolution as /historicos (page.tsx) — needed to know which week's
  // badge to compute for the "En entrenamiento" supervision list below.
  const { data: cw } = await supabase.from('current_week').select('week_start').single();
  let currentWeek = cw?.week_start as string | undefined;
  if (!currentWeek) {
    const { data: latestSnap } = await supabase
      .from('kpi_snapshots')
      .select('week_start')
      .order('week_start', { ascending: false })
      .limit(1)
      .single();
    currentWeek =
      (latestSnap?.week_start as string | undefined) ??
      lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  }

  const [
    { data: apps }, { data: kpis }, { data: hubs }, { data: rules }, { data: scope },
    { data: targets }, { data: ramps }, { data: tenureRowsRaw }, { data: rosterUploads },
  ] = await Promise.all([
    supabase.from('apps').select('id, name_es, scope, expected_files_per_week, active'),
    supabase.from('kpis').select('id, name_es, unit, direction, category, watched_globally, parent_kpi_id, display_order').order('display_order'),
    supabase.from('hubs').select('id, display_name, city, active'),
    supabase.from('behavior_rules').select('id, rule_text, active, display_order').order('display_order'),
    supabase.from('scope_rules').select('id, trigger_text, target_team_id, flag_label_es, active'),
    supabase.from('kpi_targets').select('kpi_id, scope_level, scope_key, target_value, comparator, unit, active').eq('active', true),
    supabase.from('kpi_ramp_targets').select('kpi_id, role, week_number, target_value, stretch_value, comparator, unit, active').eq('active', true),
    // Modo Entrenamiento (session 14, slice 7) — supervision list source data.
    supabase.from('person_tenure').select('*'),
    supabase.from('uploads').select('app_id, week_start').eq('status', 'validated').in('app_id', ['desempeno_operadores', 'desempeno_repartidores']),
  ]);

  const activeHubs = (hubs ?? []).filter((h) => h.active);
  const hubNameById = new Map((hubs ?? []).map((h) => [h.id, h.display_name]));

  const tasaArmadoKpi = (kpis ?? []).find((k) => k.id === 'tasa_armado');

  // ── "En entrenamiento" supervision list — everyone badged this week ────────
  const ROSTER_APP_BY_ROLE: Record<TenureRole, string> = {
    armador: 'desempeno_operadores',
    repartidor: 'desempeno_repartidores',
  };
  const weeksWithDataByRole: Record<TenureRole, Set<string>> = {
    armador: new Set((rosterUploads ?? []).filter((u) => u.app_id === ROSTER_APP_BY_ROLE.armador).map((u) => u.week_start)),
    repartidor: new Set((rosterUploads ?? []).filter((u) => u.app_id === ROSTER_APP_BY_ROLE.repartidor).map((u) => u.week_start)),
  };
  const hydratedRows = ((tenureRowsRaw ?? []) as PersonTenureDbRow[]).map((row) => {
    const hydrated = hydrateTenureRow(row, weeksWithDataByRole[row.role]);
    const status = tenureStatus(hydrated, currentWeek!);
    return {
      person_key: hydrated.person_key,
      role: hydrated.role,
      name: hydrated.display_names[0] ?? hydrated.person_key,
      hub: (hydrated.hub_id_last && hubNameById.get(hydrated.hub_id_last)) || hydrated.hub_id_last || '—',
      badge: tenureCode(status) ?? '',
      first_seen_week: hydrated.first_seen_week,
      confidence: hydrated.confidence,
      source: hydrated.source,
    } satisfies BadgedPersonRow;
  });

  const badged = hydratedRows
    .filter((r) => r.badge !== '') // veteran — not badged, not shown here
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

  // A "Graduar" override takes someone OFF the badged list above — without a
  // separate place to find them, there'd be no way to click "Revertir" on a
  // graduated person ever again. Manual overrides are rare (an escape hatch,
  // not a workflow), so a flat list regardless of current badge is enough.
  const manualOverrides = hydratedRows
    .filter((r) => r.source === 'manual')
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

  return (
    <div>
      <h1 className="text-[22px] font-bold tracking-tight mb-1">Configuración</h1>
      <div className="text-[var(--muted)] text-[13px] mb-6">
        Edita apps, KPIs, contexto AI y reglas sin tocar código. Cambios en reglas/contexto bumpan el prompt_version.
      </div>

      <KpiTargetsSection
        kpis={kpis ?? []}
        hubs={activeHubs}
        initialTargets={(targets ?? []) as KpiTarget[]}
      />

      {tasaArmadoKpi && (
        <RampTargetsSection
          initialRamps={(ramps ?? []) as RampTargetRow[]}
          targets={(targets ?? []) as KpiTarget[]}
          comparator={defaultComparator(tasaArmadoKpi.id, tasaArmadoKpi.direction)}
          unit={tasaArmadoKpi.unit}
          badged={badged}
          manualOverrides={manualOverrides}
        />
      )}

      <Section title="Apps registradas" count={apps?.length ?? 0}>
        <ul className="text-[12.5px]">
          {apps?.map(a => (
            <li key={a.id} className="flex justify-between py-2 border-b border-slate-100">
              <span><b>{a.name_es}</b> <span className="text-[var(--muted)] ml-2">{a.scope}</span></span>
              <span>{a.expected_files_per_week} archivos</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="KPIs en catálogo" count={kpis?.length ?? 0}>
        <ul className="text-[12.5px]">
          {kpis?.map(k => (
            <li key={k.id} className={`flex justify-between py-1.5 ${k.parent_kpi_id ? 'pl-6 text-[var(--muted)]' : ''}`}>
              <span>{k.parent_kpi_id ? '↳ ' : ''}<b>{k.name_es}</b> <span className="ml-2 text-[10.5px] uppercase tracking-wide">{k.category}</span></span>
              <span className="text-[10.5px] uppercase">{k.unit} · {k.direction === 'lower_is_better' ? '↓' : '↑'} {k.watched_globally && <span className="ml-2 bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded">home</span>}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Hubs" count={hubs?.length ?? 0}>
        <ul className="text-[12.5px]">
          {hubs?.map(h => (
            <li key={h.id} className="flex justify-between py-1.5">
              <span><b>{h.display_name}</b></span>
              <span className="text-[var(--muted)]">{h.city}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Behavior rules" count={rules?.length ?? 0}>
        <ul className="text-[12.5px]">
          {rules?.map(r => (
            <li key={r.id} className="py-1.5 border-b border-slate-100">{r.rule_text}</li>
          ))}
        </ul>
      </Section>

      <Section title="Scope rules — flag-to-team" count={scope?.length ?? 0}>
        <ul className="text-[12.5px]">
          {scope?.map(s => (
            <li key={s.id} className="py-1.5 border-b border-slate-100">
              <span className="bg-red-100 text-red-800 px-1.5 py-0.5 rounded text-[10.5px] mr-2">→ {s.target_team_id}</span>
              {s.trigger_text}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-3 flex justify-between">
        {title}<span className="text-[11.5px] text-[var(--muted)] font-normal">{count}</span>
      </h2>
      {children}
    </section>
  );
}
