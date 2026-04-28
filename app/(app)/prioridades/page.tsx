import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart, formatWeekRange } from '@/lib/types';
import { InsightCard } from '@/components/InsightCard';
import { GenerateInsightsButton } from '@/components/GenerateInsightsButton';

export const dynamic = 'force-dynamic';

interface PageProps { searchParams: { week?: string; tab?: string } }

export default async function PrioridadesPage({ searchParams }: PageProps) {
  const supabase = createServerClient();

  // Default week: most recently uploaded
  const { data: cw } = await supabase.from('current_week').select('week_start').single();
  const defaultIso = cw?.week_start ?? lastCompletedWeekStart(new Date()).toISOString().slice(0, 10);
  const weekStartIso = (searchParams.week && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.week))
    ? searchParams.week
    : defaultIso;
  const week = new Date(weekStartIso + 'T00:00:00');
  const tab = (searchParams.tab as 'general' | 'mh' | 'cat' | undefined) ?? 'general';

  // Fetch insights for the week + KPI metadata for display
  const [{ data: insights }, { data: kpis }, { data: hubs }, { data: roles }] = await Promise.all([
    supabase.from('ai_insights')
      .select('*')
      .eq('week_start', weekStartIso)
      .eq('mode', 'weekly_priorities')
      .order('rank', { ascending: true }),
    supabase.from('kpis').select('id, name_es, owner_role_id, category, watched_globally'),
    supabase.from('hubs').select('id, display_name, city'),
    supabase.from('hub_roles').select('id, name_es'),
  ]);

  const kpiById = new Map((kpis ?? []).map((k: any) => [k.id, k]));
  const hubById = new Map((hubs ?? []).map((h: any) => [h.id, h]));
  const roleById = new Map((roles ?? []).map((r: any) => [r.id, r]));

  const hasAny = (insights ?? []).length > 0;
  const generatedAt = (insights ?? [])[0]?.generated_at;
  const promptVersion = (insights ?? [])[0]?.prompt_version;

  // Group by view for the tab structure
  const general = (insights ?? []).filter((i: any) => i.view === 'global');
  const byHub = groupBy((insights ?? []).filter((i: any) => i.view === 'per_hub'), (i: any) => i.view_key ?? 'unknown');
  const byCat = groupBy((insights ?? []).filter((i: any) => i.view === 'per_category'), (i: any) => i.view_key ?? 'unknown');

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">Prioridades de la semana</h1>
          <div className="text-[var(--muted)] text-[13px] mt-1">
            Insights generados por AI a partir de los archivos subidos. Cada item incluye evidencia, owner sugerido y fuente de datos.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-2 bg-white border border-[var(--line)] rounded-full px-3 py-1.5 text-[12.5px] shadow-soft">
            <span className="w-2 h-2 rounded-full bg-teal-400" />
            {formatWeekRange(week)}
            {generatedAt && (
              <>
                {' · '}
                <span className="text-[var(--muted)]">
                  Generado {new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(generatedAt))}
                  {promptVersion ? ` · prompt v${promptVersion}` : ''}
                </span>
              </>
            )}
          </span>
          <GenerateInsightsButton weekStart={weekStartIso} label={hasAny ? '↻ Regenerar' : '✨ Generar insights'} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--line)] mb-5">
        <Tab href={tabHref(weekStartIso, 'general')} active={tab === 'general'}>General · Lo que sigo yo</Tab>
        <Tab href={tabHref(weekStartIso, 'mh')} active={tab === 'mh'}>Por micro-hub</Tab>
        <Tab href={tabHref(weekStartIso, 'cat')} active={tab === 'cat'}>Por categoría</Tab>
      </div>

      {!hasAny ? (
        <Empty weekStartIso={weekStartIso} />
      ) : tab === 'general' ? (
        <GeneralTab insights={general} kpiById={kpiById} roleById={roleById} />
      ) : tab === 'mh' ? (
        <PerHubTab byHub={byHub} hubById={hubById} kpiById={kpiById} roleById={roleById} />
      ) : (
        <PerCategoryTab byCat={byCat} kpiById={kpiById} roleById={roleById} />
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

function GeneralTab({ insights, kpiById, roleById }: any) {
  const top3 = insights.filter((i: any) => i.rank !== null && i.rank <= 3);
  const more = insights.filter((i: any) => i.rank !== null && i.rank > 3);

  return (
    <div className="space-y-3">
      <div className="bg-teal-50 border border-teal-200 rounded-md p-3 text-[12.5px] text-teal-800 flex items-start gap-2.5">
        <div className="w-5 h-5 rounded-full bg-teal-400 text-white flex items-center justify-center text-[12px] font-bold flex-shrink-0">i</div>
        <div>
          <b className="text-[var(--ink)]">Top 3 destacadas</b> de tus KPIs personales (MNA, Faltantes, Incidentes, Tasa de armado, % tardías reparto, Entregas erróneas).
          Cada tarjeta tiene 👍/👎 (entrena al sistema), <b>Reformular</b> (regenera con otra perspectiva), y <b>Fuera de scope</b> (crea regla en Configuración).
        </div>
      </div>

      {top3.map((i: any) => (
        <InsightCard
          key={i.id}
          insight={i}
          kpiName={kpiById.get(i.kpi_id ?? '')?.name_es}
          ownerRole={roleById.get(kpiById.get(i.kpi_id ?? '')?.owner_role_id ?? '')?.name_es}
        />
      ))}

      {more.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer px-3 py-2.5 border border-dashed border-[var(--line)] rounded-md text-[12.5px] font-semibold text-[var(--muted)] hover:border-teal-400 hover:text-teal-700">
            ▾ Más para esta semana ({more.length} ítems adicionales)
          </summary>
          <div className="mt-3 space-y-2">
            {more.map((i: any) => (
              <InsightCard
                key={i.id}
                insight={i}
                kpiName={kpiById.get(i.kpi_id ?? '')?.name_es}
                ownerRole={roleById.get(kpiById.get(i.kpi_id ?? '')?.owner_role_id ?? '')?.name_es}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PerHubTab({ byHub, hubById, kpiById, roleById }: any) {
  if (byHub.size === 0) {
    return <p className="text-[12.5px] text-[var(--muted)]">Sin insights por micro-hub esta semana. Regenerar para producir.</p>;
  }
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
      {[...byHub.entries()].map(([hubId, items]: any) => {
        const hub = hubById.get(hubId);
        return (
          <div key={hubId} className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
            <div className="flex items-baseline justify-between mb-2 pb-2 border-b border-slate-100">
              <h3 className="text-[14px] font-bold">{hub?.display_name ?? hubId}</h3>
              <span className="text-[11px] text-[var(--muted)]">{hub?.city ?? ''}</span>
            </div>
            <div className="space-y-2">
              {items.slice(0, 3).map((i: any) => (
                <div key={i.id} className="text-[12.5px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{i.headline_es}</span>
                    <span className="text-[10.5px] text-[var(--muted)] flex-shrink-0">#{i.rank}</span>
                  </div>
                  <div className="text-[10.5px] text-[var(--muted)] mt-0.5">
                    {kpiById.get(i.kpi_id ?? '')?.name_es ?? i.kpi_id}
                    {i.kpi_id && roleById.get(kpiById.get(i.kpi_id)?.owner_role_id ?? '')?.name_es &&
                      ` · ${roleById.get(kpiById.get(i.kpi_id).owner_role_id).name_es}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PerCategoryTab({ byCat, kpiById, roleById }: any) {
  if (byCat.size === 0) {
    return <p className="text-[12.5px] text-[var(--muted)]">Sin insights por categoría esta semana. Regenerar para producir.</p>;
  }
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
      {[...byCat.entries()].map(([cat, items]: any) => (
        <div key={cat} className="bg-white border border-[var(--line)] rounded-xl p-4 shadow-soft">
          <h3 className="text-[14px] font-bold mb-2 capitalize flex items-center gap-2">
            {cat}
            <span className="text-[10px] px-1.5 py-0.5 bg-teal-50 text-teal-800 rounded font-bold">{items.length}</span>
          </h3>
          <div className="space-y-1.5">
            {items.slice(0, 4).map((i: any) => (
              <div key={i.id} className="text-[12.5px] py-1.5 border-t border-slate-100 first:border-0">
                <div className="font-medium text-slate-700">{i.headline_es}</div>
                <div className="text-[10.5px] text-[var(--muted)] mt-0.5">
                  {i.scope_key ?? '—'} · {kpiById.get(i.kpi_id ?? '')?.name_es ?? i.kpi_id}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ weekStartIso }: { weekStartIso: string }) {
  return (
    <div className="bg-white border border-dashed border-[var(--line)] rounded-xl p-12 text-center text-[var(--muted)]">
      <div className="text-3xl mb-2">🤖</div>
      <div className="font-semibold text-[var(--ink)] mb-1">Sin insights generados para esta semana</div>
      <div className="text-[12px] max-w-md mx-auto leading-relaxed mb-4">
        Sube los CSVs de la semana → corre <code className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px]">Recomputar snapshots</code> en /upload → regresa aquí y haz click en <b>Generar insights</b>.
      </div>
      <div className="inline-flex gap-2">
        <a href={`/upload?week=${weekStartIso}`} className="px-3 py-1.5 border border-[var(--line)] rounded-lg text-[12px] font-medium hover:border-black">
          Ir a uploads →
        </a>
        <GenerateInsightsButton weekStart={weekStartIso} label="✨ Generar insights ahora" />
      </div>
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
