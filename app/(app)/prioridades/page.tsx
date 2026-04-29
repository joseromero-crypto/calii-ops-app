import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart, formatWeekRange } from '@/lib/types';
import { InsightCard } from '@/components/InsightCard';
import { GenerateInsightsButton } from '@/components/GenerateInsightsButton';

export const dynamic = 'force-dynamic';

interface PageProps { searchParams: { week?: string; tab?: string } }

const CATEGORIES = [
  { id: 'calidad',       label: 'Calidad' },
  { id: 'inventario',    label: 'Inventario' },
  { id: 'logistica',     label: 'Logística' },
  { id: 'productividad', label: 'Productividad' },
  { id: 'asistencia',    label: 'Asistencia' },
  { id: 'incidentes',    label: 'Incidentes' },
];

export default async function PrioridadesPage({ searchParams }: PageProps) {
  const supabase = createServerClient();

  const { data: cw } = await supabase.from('current_week').select('week_start').single();
  const defaultIso = cw?.week_start ?? lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  const weekStartIso = (searchParams.week && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.week))
    ? searchParams.week
    : defaultIso;
  const week = new Date(weekStartIso + 'T00:00:00');
  const tab = (searchParams.tab as 'general' | 'mh' | 'cat' | undefined) ?? 'general';

  const [{ data: insights }, { data: kpis }, { data: hubs }, { data: roles }] = await Promise.all([
    supabase.from('ai_insights').select('*').eq('week_start', weekStartIso).eq('mode', 'weekly_priorities').order('rank', { ascending: true }),
    supabase.from('kpis').select('id, name_es, owner_role_id, category, watched_globally'),
    supabase.from('hubs').select('id, display_name, city').eq('active', true).order('id'),
    supabase.from('hub_roles').select('id, name_es'),
  ]);

  const kpiById = new Map((kpis ?? []).map((k: any) => [k.id, k]));
  const hubById = new Map((hubs ?? []).map((h: any) => [h.id, h]));
  const roleById = new Map((roles ?? []).map((r: any) => [r.id, r]));

  const general = (insights ?? []).filter((i: any) => i.view === 'global');
  const byHub = groupBy((insights ?? []).filter((i: any) => i.view === 'per_hub'), (i: any) => i.view_key ?? 'unknown');
  const byCat = groupBy((insights ?? []).filter((i: any) => i.view === 'per_category'), (i: any) => i.view_key ?? 'unknown');

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Prioridades de la semana</h1>
          <div className="text-[var(--muted)] text-[13px] mt-1">
            Insights generados por AI. Genera uno por uno por scope — más rápido y permite re-generar sólo lo que necesitas.
          </div>
        </div>
        <span className="inline-flex items-center gap-2 bg-white border border-[var(--line)] rounded-full px-3 py-1.5 text-[12.5px] shadow-soft">
          <span className="w-2 h-2 rounded-full bg-teal-400" />
          {formatWeekRange(week)}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--line)] mb-5">
        <Tab href={tabHref(weekStartIso, 'general')} active={tab === 'general'}>General · Lo que sigo yo</Tab>
        <Tab href={tabHref(weekStartIso, 'mh')} active={tab === 'mh'}>Por micro-hub</Tab>
        <Tab href={tabHref(weekStartIso, 'cat')} active={tab === 'cat'}>Por categoría</Tab>
      </div>

      {tab === 'general' ? (
        <GeneralTab
          insights={general}
          kpiById={kpiById}
          roleById={roleById}
          weekStartIso={weekStartIso}
        />
      ) : tab === 'mh' ? (
        <PerHubTab
          byHub={byHub}
          hubs={hubs ?? []}
          hubById={hubById}
          kpiById={kpiById}
          roleById={roleById}
          weekStartIso={weekStartIso}
        />
      ) : (
        <PerCategoryTab
          byCat={byCat}
          kpiById={kpiById}
          roleById={roleById}
          weekStartIso={weekStartIso}
        />
      )}
    </div>
  );
}

function tabHref(week: string, tab: string) {
  const params = new URLSearchParams();
  if (tab !== 'general') params.set('tab', tab);
  if (week) params.set('week', week);
  return params.toString() ? `/prioridades?${params}` : '/prioridades';
}

function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <a href={href}
      className={`px-3.5 py-2.5 text-[13px] font-medium border-b-2 -mb-px ${
        active ? 'border-teal-400 text-[var(--ink)] font-semibold' : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
      }`}>
      {children}
    </a>
  );
}

function GeneralTab({ insights, kpiById, roleById, weekStartIso }: any) {
  return (
    <div className="space-y-3">
      <div className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[12.5px] text-[var(--muted)]">
          <b className="text-[var(--ink)]">3 prioridades generales</b> de tus KPIs personales — los items que <b>tú</b> sigues semana a semana.
        </div>
        <GenerateInsightsButton
          weekStart={weekStartIso}
          view="global"
          label={insights.length > 0 ? '↻ Regenerar generales' : '✨ Generar 3 insights generales'}
        />
      </div>

      {insights.length === 0 ? (
        <EmptyScopeMsg label="generales" />
      ) : (
        insights.map((i: any) => (
          <InsightCard
            key={i.id}
            insight={i}
            kpiName={kpiById.get(i.kpi_id ?? '')?.name_es}
            ownerRole={roleById.get(kpiById.get(i.kpi_id ?? '')?.owner_role_id ?? '')?.name_es}
          />
        ))
      )}
    </div>
  );
}

function PerHubTab({ byHub, hubs, hubById, kpiById, roleById, weekStartIso }: any) {
  return (
    <div>
      <p className="text-[12.5px] text-[var(--muted)] mb-3">
        Cada hub tiene su propio botón. Genera o re-genera sólo el hub que necesitas analizar.
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
        {hubs.map((hub: any) => {
          const items = byHub.get(hub.id) ?? [];
          return (
            <div key={hub.id} className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
              <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-slate-100 gap-2">
                <div>
                  <h3 className="text-[14px] font-bold">{hub.display_name}</h3>
                  <span className="text-[11px] text-[var(--muted)]">{hub.city}</span>
                </div>
                <GenerateInsightsButton
                  weekStart={weekStartIso}
                  view="per_hub"
                  viewKey={hub.id}
                  size="sm"
                  label={items.length > 0 ? '↻' : '✨ Generar 3'}
                />
              </div>
              {items.length === 0 ? (
                <p className="text-[11.5px] text-[var(--muted)] py-3">Sin insights todavía.</p>
              ) : (
                <div className="space-y-2">
                  {items.slice(0, 3).map((i: any) => (
                    <div key={i.id} className="text-[12.5px]">
                      <div className="flex items-baseline justify-between gap-2">
                        <span>{i.headline_es}</span>
                        <span className="text-[10.5px] text-[var(--muted)] flex-shrink-0">#{i.rank}</span>
                      </div>
                      <div className="text-[10.5px] text-[var(--muted)] mt-0.5">
                        {kpiById.get(i.kpi_id ?? '')?.name_es ?? i.kpi_id ?? '—'}
                        {i.kpi_id && roleById.get(kpiById.get(i.kpi_id)?.owner_role_id ?? '')?.name_es &&
                          ` · ${roleById.get(kpiById.get(i.kpi_id).owner_role_id).name_es}`}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PerCategoryTab({ byCat, kpiById, roleById, weekStartIso }: any) {
  return (
    <div>
      <p className="text-[12.5px] text-[var(--muted)] mb-3">
        Cada categoría tiene su propio botón. Útil para coordinadores externos (Calidad, etc.) que sólo siguen su área.
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {CATEGORIES.map((cat) => {
          const items = byCat.get(cat.id) ?? [];
          return (
            <div key={cat.id} className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
              <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-slate-100 gap-2">
                <h3 className="text-[14px] font-bold">{cat.label}</h3>
                <GenerateInsightsButton
                  weekStart={weekStartIso}
                  view="per_category"
                  viewKey={cat.id}
                  size="sm"
                  label={items.length > 0 ? '↻' : '✨ Generar 3'}
                />
              </div>
              {items.length === 0 ? (
                <p className="text-[11.5px] text-[var(--muted)] py-3">Sin insights todavía.</p>
              ) : (
                <div className="space-y-1.5">
                  {items.slice(0, 3).map((i: any) => (
                    <div key={i.id} className="text-[12.5px] py-1.5 border-t border-slate-100 first:border-0">
                      <div className="font-medium text-slate-700">{i.headline_es}</div>
                      <div className="text-[10.5px] text-[var(--muted)] mt-0.5">
                        {i.scope_key ?? '—'} · {kpiById.get(i.kpi_id ?? '')?.name_es ?? i.kpi_id ?? '—'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyScopeMsg({ label }: { label: string }) {
  return (
    <div className="bg-white border border-dashed border-[var(--line)] rounded-xl p-8 text-center text-[var(--muted)]">
      <div className="text-2xl mb-1">🤖</div>
      <div className="text-[12.5px]">Sin insights {label} todavía. Click en el botón de arriba para generar.</div>
    </div>
  );
}

function groupBy<T, K>(arr: T[], f: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}
