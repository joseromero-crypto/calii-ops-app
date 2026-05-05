import { createServerClient } from '@/lib/supabase-server';
import { lastCompletedWeekStart, formatWeekRange, weekStartFriday } from '@/lib/types';
import { UploadDropzone } from '@/components/UploadDropzone';
import { WeekSelector } from '@/components/WeekSelector';
import { RecomputeButton } from '@/components/RecomputeButton';

const CITIES = ['Monterrey', 'Saltillo', 'Guadalajara', 'CDMX'] as const;

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { week?: string };
}

export default async function UploadPage({ searchParams }: PageProps) {
  const supabase = createServerClient();

  // Default selected week: explicit ?week=YYYY-MM-DD param > most recently uploaded > most recently completed
  const defaultDate = lastCompletedWeekStart(new Date());
  const defaultIso = defaultDate.toISOString().slice(0, 10);

  let weekStartIso = defaultIso;
  if (searchParams.week && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.week)) {
    // Snap to the Friday of the requested week, defensively
    const requested = new Date(searchParams.week + 'T00:00:00');
    weekStartIso = weekStartFriday(requested).toISOString().slice(0, 10);
  }
  const week = new Date(weekStartIso + 'T00:00:00');

  // Compact list of weeks that already have uploads (last 26)
  const { data: pastWeeksRaw } = await supabase
    .from('uploads')
    .select('week_start, status')
    .order('week_start', { ascending: false })
    .limit(500);

  const pastWeekMap = new Map<string, number>();
  for (const u of pastWeeksRaw ?? []) {
    pastWeekMap.set(u.week_start, (pastWeekMap.get(u.week_start) ?? 0) + 1);
  }
  const weeksWithUploads = [...pastWeekMap.entries()]
    .map(([week_start, uploaded_count]) => ({ week_start, uploaded_count }))
    .sort((a, b) => b.week_start.localeCompare(a.week_start))
    .slice(0, 26);

  // Apps registry — what tiles to show
  const { data: apps } = await supabase
    .from('apps')
    .select('id, name_es, scope, expected_files_per_week')
    .eq('active', true)
    .order('id');

  // Hubs list (used for per_hub tiles)
  const { data: hubs } = await supabase
    .from('hubs')
    .select('id, display_name, city')
    .eq('active', true)
    .order('id');

  // Uploads for the current week — what's already in
  const { data: uploads } = await supabase
    .from('uploads')
    .select('app_id, city, hub_id, status, uploaded_at, row_count')
    .eq('week_start', weekStartIso);

  const total = (apps ?? []).reduce((s, a) => s + a.expected_files_per_week, 0);
  const done = (uploads ?? []).filter(u => u.status === 'validated').length;
  const warnings = (uploads ?? []).filter(u => u.status === 'pending').length;
  const missing = total - done - warnings;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-[22px] font-bold tracking-tight">Subir archivos</h1>
        <div className="text-[var(--muted)] text-[13px] mt-1">
          Carga los CSVs de cada Retool app. Los CSVs no llevan fecha embebida — selecciona la semana a la que pertenecen los datos antes de subir.
        </div>
      </div>

      <WeekSelector
        selectedWeek={weekStartIso}
        defaultWeek={defaultIso}
        weeksWithUploads={weeksWithUploads}
      />

      <div className="flex items-center justify-end mb-4">
        <RecomputeButton weekStart={weekStartIso} allWeeks={weeksWithUploads.map(w => w.week_start)} />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] gap-4 mb-5">
        <div className="bg-white border border-[var(--line)] rounded-xl p-6 flex gap-6 items-center shadow-soft">
          <ProgressRing pct={pct} done={done} total={total} />
          <div>
            <h2 className="text-base font-semibold m-0 mb-1.5">
              {missing > 0
                ? `${missing} archivos pendientes para ${weekStartIso === defaultIso ? 'esta semana' : 'esta semana seleccionada'}`
                : '¡Semana completa!'}
            </h2>
            <p className="text-[var(--muted)] text-[12.5px] m-0">
              {weekStartIso === defaultIso
                ? 'Sube los CSVs cada viernes para que el cron de la 1pm regenere insights.'
                : 'Estás subiendo datos para una semana pasada (backfill). Re-subir un slot reemplaza la versión anterior.'}
            </p>
            <div className="flex gap-4 mt-3">
              <Stat n={done} l="subidos OK" tone="ok" />
              <Stat n={warnings} l="con warning" tone="warn" />
              <Stat n={missing} l="faltantes" tone="danger" />
            </div>
          </div>
        </div>
        <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
          <h3 className="text-[13px] font-semibold m-0 mb-3 flex items-center gap-1.5">
            Validaciones a revisar
            <span className="text-[10px] text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full font-bold">{warnings}</span>
          </h3>
          {warnings === 0 && <p className="text-[12.5px] text-[var(--muted)] m-0">Sin pendientes.</p>}
          {/* Real warning list will land in the next pass */}
        </div>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
        {(apps ?? []).map(app => (
          <AppTile
            key={app.id}
            app={app}
            uploads={(uploads ?? []).filter(u => u.app_id === app.id)}
            hubs={hubs ?? []}
            weekStartIso={weekStartIso}
          />
        ))}
        <AddAppCard />
      </div>
    </div>
  );
}

// --------- helpers ---------

function Stat({ n, l, tone }: { n: number; l: string; tone: 'ok' | 'warn' | 'danger' }) {
  const colors = { ok: 'text-emerald-500', warn: 'text-amber-500', danger: 'text-red-500' };
  return (
    <div>
      <div className={`font-semibold text-[15px] ${colors[tone]}`}>{n}</div>
      <div className="text-[11px] text-[var(--muted)]">{l}</div>
    </div>
  );
}

function ProgressRing({ pct, done, total }: { pct: number; done: number; total: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div className="relative w-[100px] h-[100px] flex-none">
      <svg width="100" height="100" className="-rotate-90">
        <circle cx="50" cy="50" r={r} stroke="#e5e7eb" fill="none" strokeWidth="10" />
        <circle
          cx="50" cy="50" r={r}
          stroke="var(--teal)" fill="none" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[22px] font-bold">
          {done}<span className="text-[12px] text-[var(--muted)] font-medium">/{total}</span>
        </div>
        <div className="text-[10px] tracking-[1px] uppercase text-[var(--muted)]">archivos</div>
      </div>
    </div>
  );
}

function AppTile({
  app, uploads, hubs, weekStartIso
}: {
  app: { id: string; name_es: string; scope: string; expected_files_per_week: number };
  uploads: any[];
  hubs: { id: string; display_name: string; city: string }[];
  weekStartIso: string;
}) {
  const done = uploads.filter(u => u.status === 'validated').length;

  // Build the slot list based on scope
  const slots: { key: string; label: string; city?: string; hub_id?: string; uploadedRow?: any }[] =
    app.scope === 'total'
      ? [{ key: 'total', label: 'Todas las ciudades' }]
      : app.scope === 'per_city'
        ? CITIES.map(c => ({ key: c, label: c, city: c }))
        : hubs.map(h => ({ key: h.id, label: h.display_name, hub_id: h.id }));

  // Match uploads onto slots
  for (const slot of slots) {
    slot.uploadedRow = uploads.find(u => u.city === (slot.city ?? null) && u.hub_id === (slot.hub_id ?? null));
  }

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl p-5 shadow-soft">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h3 className="text-[15px] font-semibold m-0 mb-1">{app.name_es}</h3>
          <span className="text-[10.5px] text-[var(--muted)] bg-slate-100 px-2 py-0.5 rounded font-semibold uppercase tracking-wide">
            {app.scope === 'total' ? 'Total · 1 archivo' : app.scope === 'per_city' ? 'Por ciudad · 4 archivos' : 'Por hub · 7 archivos'}
          </span>
        </div>
        <div className="text-right">
          <div className="text-[12.5px] text-[var(--muted)]">
            <b className="text-[var(--ink)] font-bold">{done}</b>/{app.expected_files_per_week} listos
          </div>
        </div>
      </div>
      <div className={`grid gap-1.5 ${slots.length > 4 ? 'grid-cols-4' : slots.length > 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {slots.map(slot => (
          <UploadDropzone
            key={slot.key}
            appId={app.id}
            weekStart={weekStartIso}
            city={slot.city}
            hubId={slot.hub_id}
            label={slot.label}
            alreadyUploaded={slot.uploadedRow?.status === 'validated'}
          />
        ))}
      </div>
    </div>
  );
}

function AddAppCard() {
  return (
    <div className="border border-dashed border-[var(--line)] rounded-xl p-5 flex flex-col items-center justify-center text-center min-h-[170px] text-[var(--muted)]">
      <div className="text-2xl text-teal-400 mb-1.5">+</div>
      <div className="font-semibold text-[var(--ink)]">Registrar nueva app</div>
      <div className="text-[11.5px] mt-1">Define columnas esperadas y los KPIs que produce.</div>
    </div>
  );
}
