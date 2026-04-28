import { createServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export default async function ConfigPage() {
  const supabase = createServerClient();
  const [{ data: apps }, { data: kpis }, { data: hubs }, { data: rules }, { data: scope }] = await Promise.all([
    supabase.from('apps').select('id, name_es, scope, expected_files_per_week, active'),
    supabase.from('kpis').select('id, name_es, unit, direction, category, watched_globally, parent_kpi_id, display_order').order('display_order'),
    supabase.from('hubs').select('id, display_name, city, active'),
    supabase.from('behavior_rules').select('id, rule_text, active, display_order').order('display_order'),
    supabase.from('scope_rules').select('id, trigger_text, target_team_id, flag_label_es, active'),
  ]);

  return (
    <div>
      <h1 className="text-[22px] font-bold tracking-tight mb-1">Configuración</h1>
      <div className="text-[var(--muted)] text-[13px] mb-6">
        Edita apps, KPIs, contexto AI y reglas sin tocar código. Cambios en reglas/contexto bumpan el prompt_version.
      </div>

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
