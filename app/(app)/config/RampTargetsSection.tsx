'use client';

/**
 * "Entrenamiento / Rampa" editor for /config — per-week mínimo/esperado for
 * new armadores (tasa_armado only, 10-week ramp). See
 * PLAN_MODO_ENTRENAMIENTO.md §8.
 *
 * Every week always has a row (seeded by the kpi_ramp_targets migration) —
 * unlike Metas/Targets above, there's no "blank = inherit" concept here, so
 * inputs always show a value and a blank commit just reverts rather than
 * clearing the row. Mínimo is what flags in the report; esperado is
 * reference only — labeled explicitly so nobody later assumes esperado
 * flags (PLAN §2.2's ⚠️).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { resolveTarget, type KpiTarget } from '../historicos/_shared';

export interface RampTargetRow {
  kpi_id: string;
  role: 'armador' | 'repartidor';
  week_number: number;
  target_value: number;
  stretch_value: number | null;
  comparator: 'gte' | 'lte' | 'gt' | 'lt';
  unit: string;
  active: boolean;
}

/**
 * One row of the "En entrenamiento" supervision list — everyone currently
 * badged (trainee or reentry), computed server-side in config/page.tsx since
 * it needs tenureStatus() run against the current week for every ledger row.
 */
export interface BadgedPersonRow {
  person_key: string;
  role: 'armador' | 'repartidor';
  name: string;
  hub: string;             // display name, resolved server-side; '—' if unknown
  badge: string;            // 'S3' | 'RI' — bare code, see lib/tenure.ts's tenureCode
  first_seen_week: string;
  confidence: 'high' | 'low';
  source: 'derived' | 'manual';
}

const KPI_ID = 'tasa_armado';
const ROLE = 'armador' as const;
const RAMP_WEEKS = 10;

export function RampTargetsSection({
  initialRamps,
  targets,
  comparator,
  unit,
  badged,
  manualOverrides,
}: {
  initialRamps: RampTargetRow[];
  targets: KpiTarget[];
  comparator: 'gte' | 'lte';
  unit: string;
  badged: BadgedPersonRow[];
  manualOverrides: BadgedPersonRow[];
}) {
  // resolveTarget lives in a 'use client' module — must be called from a
  // client component, not the server page.tsx (that's the "resolveTarget is
  // not a function" trap: 'use client' exports become opaque client
  // references when imported into a server component).
  const veteranTarget = resolveTarget('tasa_armado', null, targets)?.target_value ?? null;

  const [ramps, setRamps] = useState<Map<number, RampTargetRow>>(() => {
    const m = new Map<number, RampTargetRow>();
    for (const r of initialRamps) {
      if (r.kpi_id === KPI_ID && r.role === ROLE) m.set(r.week_number, r);
    }
    return m;
  });

  function upsertLocal(r: RampTargetRow) {
    setRamps((prev) => {
      const next = new Map(prev);
      next.set(r.week_number, r);
      return next;
    });
  }

  const weeks = Array.from({ length: RAMP_WEEKS }, (_, i) => i + 1);

  return (
    <>
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-1 flex justify-between">
        Entrenamiento / Rampa<span className="text-[11.5px] text-[var(--muted)] font-normal">{ramps.size}</span>
      </h2>
      <div className="text-[11.5px] text-[var(--muted)] mb-3">
        Meta individual por semana de rampa para armadores nuevos (tasa_armado). El{' '}
        <b>mínimo</b> es su meta individual — eso es lo que flaguea en el reporte semanal, no el
        estándar del hub. El <b>esperado</b> es solo referencia, nunca flaguea. Semana 11+ usa la
        meta veterana{veteranTarget != null ? ` (${veteranTarget})` : ''}.
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase text-[var(--muted)] border-b border-slate-100">
              <th className="py-1.5 font-medium pr-3">Semana</th>
              <th className="py-1.5 font-medium pr-3">Mínimo (meta individual)</th>
              <th className="py-1.5 font-medium">Esperado (referencia)</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((wk) => {
              const row = ramps.get(wk);
              const isLastWeek = wk === RAMP_WEEKS;
              return (
                <tr key={wk} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-medium">S{wk}</td>
                  <td className="py-2 pr-3">
                    <RampInput
                      row={row}
                      weekNumber={wk}
                      field="target_value"
                      comparator={comparator}
                      unit={unit}
                      placeholder={veteranTarget != null ? String(veteranTarget) : '—'}
                      onSaved={upsertLocal}
                    />
                  </td>
                  <td className="py-2">
                    <RampInput
                      row={row}
                      weekNumber={wk}
                      field="stretch_value"
                      comparator={comparator}
                      unit={unit}
                      placeholder={isLastWeek ? '100+' : veteranTarget != null ? String(veteranTarget) : '—'}
                      onSaved={upsertLocal}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>

    <EnEntrenamientoSection badged={badged} />
    <ManualOverridesSection manualOverrides={manualOverrides} />
    </>
  );
}

/**
 * Read-only supervision list — everyone currently badged (trainee or
 * reentry) — plus a manual override per person: hand-set first_seen_week,
 * or "Graduar" to force veteran status. Needed for a rehire under a new id
 * or a bad derivation, since the algorithm itself has no other fix (PLAN §8).
 */
function EnEntrenamientoSection({ badged }: { badged: BadgedPersonRow[] }) {
  return (
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-1 flex justify-between">
        En entrenamiento<span className="text-[11.5px] text-[var(--muted)] font-normal">{badged.length}</span>
      </h2>
      <div className="text-[11.5px] text-[var(--muted)] mb-3">
        Todos los badgeados esta semana (S1–S10 armadores, S1–S4 repartidores, o RI). Vista de
        supervisión — así se revisa que la derivación esté badgeando a las personas correctas.
        Override manual disponible por si hay una recontratación bajo un id nuevo o una derivación
        incorrecta.
      </div>

      {badged.length === 0 ? (
        <div className="text-[12px] text-[var(--muted)] opacity-60 py-3">Nadie badgeado esta semana.</div>
      ) : (
        <PersonTable rows={badged} />
      )}
    </section>
  );
}

/**
 * A "Graduar" override removes someone from the badged list above — without
 * this section there would be no way to ever find them again to click
 * "Revertir a derivado". Manual overrides are an escape hatch, not a normal
 * workflow, so this stays a flat list regardless of current badge status.
 */
function ManualOverridesSection({ manualOverrides }: { manualOverrides: BadgedPersonRow[] }) {
  if (manualOverrides.length === 0) return null;
  return (
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-1 flex justify-between">
        Overrides manuales<span className="text-[11.5px] text-[var(--muted)] font-normal">{manualOverrides.length}</span>
      </h2>
      <div className="text-[11.5px] text-[var(--muted)] mb-3">
        Personas con un override activo (fecha de inicio ajustada a mano, o graduadas manualmente a
        veterano). Estas filas nunca se sobrescriben en el siguiente refresh — revertir aquí las
        regresa a la derivación automática.
      </div>
      <PersonTable rows={manualOverrides} />
    </section>
  );
}

function PersonTable({ rows }: { rows: BadgedPersonRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[10.5px] uppercase text-[var(--muted)] border-b border-slate-100">
            <th className="py-1.5 font-medium pr-3">Nombre</th>
            <th className="py-1.5 font-medium pr-3">Rol</th>
            <th className="py-1.5 font-medium pr-3">Hub</th>
            <th className="py-1.5 font-medium pr-3">Badge</th>
            <th className="py-1.5 font-medium pr-3">Inicio</th>
            <th className="py-1.5 font-medium pr-3">Confianza</th>
            <th className="py-1.5 font-medium">Override</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.person_key}|${p.role}`} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3">{p.name}</td>
              <td className="py-2 pr-3 text-[var(--muted)]">{p.role}</td>
              <td className="py-2 pr-3 text-[var(--muted)]">{p.hub}</td>
              <td className="py-2 pr-3 font-semibold">{p.badge || 'veterano'}</td>
              <td className="py-2 pr-3 text-[var(--muted)]">{p.first_seen_week}</td>
              <td className="py-2 pr-3">
                <span className={p.confidence === 'low' ? 'text-amber-600' : 'text-[var(--muted)]'}>
                  {p.confidence}{p.source === 'manual' ? ' · manual' : ''}
                </span>
              </td>
              <td className="py-2">
                <PersonOverrideControls person={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonOverrideControls({ person }: { person: BadgedPersonRow }) {
  const router = useRouter();
  const [weekInput, setWeekInput] = useState(person.first_seen_week);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function callApi(method: 'PUT' | 'DELETE', body: object) {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/person-tenure', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? `Error ${res.status}`);
      }
      // Membership in this list, and the badge itself, can change after an
      // override — re-run the server fetch rather than guessing the new
      // state client-side (same pattern as RecomputeButton).
      router.refresh();
      setStatus('idle');
    } catch (e: any) {
      setStatus('error');
      setErrorMsg(e.message ?? 'Error');
    }
  }

  async function setFirstSeen() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekInput)) {
      setStatus('error');
      setErrorMsg('Formato: AAAA-MM-DD');
      return;
    }
    await callApi('PUT', {
      person_key: person.person_key,
      role: person.role,
      action: 'set_first_seen',
      first_seen_week: weekInput,
    });
  }

  async function graduate() {
    await callApi('PUT', { person_key: person.person_key, role: person.role, action: 'graduate' });
  }

  async function revert() {
    await callApi('DELETE', { person_key: person.person_key, role: person.role });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={weekInput}
          onChange={(e) => { setWeekInput(e.target.value); setStatus('idle'); }}
          placeholder="AAAA-MM-DD"
          className="w-24 text-[11px] border border-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-slate-400"
        />
        <button
          type="button"
          onClick={setFirstSeen}
          disabled={status === 'saving'}
          className="text-[10.5px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
        >
          Guardar inicio
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={graduate}
          disabled={status === 'saving'}
          className="text-[10.5px] px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
        >
          Graduar
        </button>
        {person.source === 'manual' && (
          <button
            type="button"
            onClick={revert}
            disabled={status === 'saving'}
            className="text-[10.5px] px-2 py-0.5 rounded bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            Revertir a derivado
          </button>
        )}
        {status === 'saving' && <span className="text-[10.5px] text-slate-400">guardando…</span>}
        {status === 'error' && <span className="text-[10.5px] text-red-600">{errorMsg ?? 'error'}</span>}
      </div>
    </div>
  );
}

function unitSuffix(unit: string): string {
  if (unit === 'pct') return '%';
  if (unit === 'currency' || unit === 'currency_avg') return '$';
  return '';
}

function RampInput({
  row,
  weekNumber,
  field,
  comparator,
  unit,
  placeholder,
  onSaved,
}: {
  row: RampTargetRow | undefined;
  weekNumber: number;
  field: 'target_value' | 'stretch_value';
  comparator: 'gte' | 'lte';
  unit: string;
  placeholder: string;
  onSaved: (r: RampTargetRow) => void;
}) {
  const value = row ? row[field] : null;
  const [text, setText] = useState(value !== null ? String(value) : '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function commit() {
    const trimmed = text.trim();

    // No "clear" concept for this table — every week always has a row.
    // A blank commit just reverts to the last known value.
    if (trimmed === '') {
      setText(value !== null ? String(value) : '');
      return;
    }

    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      setStatus('error');
      setText(value !== null ? String(value) : '');
      return;
    }
    if (num === value) return; // unchanged

    setStatus('saving');
    try {
      const res = await fetch('/api/ramp-targets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kpi_id: KPI_ID,
          role: ROLE,
          week_number: weekNumber,
          comparator,
          unit,
          target_value: field === 'target_value' ? num : row?.target_value,
          stretch_value: field === 'stretch_value' ? num : row?.stretch_value ?? null,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { ramp } = await res.json();
      onSaved(ramp);
      setStatus('saved');
    } catch {
      setStatus('error');
      setText(value !== null ? String(value) : ''); // revert
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-20 text-[12px] text-right border border-slate-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-slate-400"
      />
      <span className="text-[10.5px] text-[var(--muted)] w-3">{unitSuffix(unit)}</span>
      <span className="w-3 text-[10.5px]">
        {status === 'saving' && <span className="text-slate-400">…</span>}
        {status === 'saved' && <span className="text-emerald-600">✓</span>}
        {status === 'error' && <span className="text-red-600">!</span>}
      </span>
    </div>
  );
}
