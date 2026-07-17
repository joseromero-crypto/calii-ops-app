'use client';

/**
 * "Metas / Targets" editor for /config — global + per-hub KPI targets.
 *
 * Writes go to /api/kpi-targets (PUT to set, DELETE to clear). A blank
 * input clears the row rather than writing target_value=null: row absence
 * is what "no target" means everywhere else in this feature (see
 * resolveTarget in historicos/_shared.ts) — that's also why blank hub
 * inputs fall back to the global value, and blank global inputs fall back
 * to whatever code default the report/dashboard already use.
 *
 * Comparator is not user-editable here — it's derived from the KPI's
 * effective direction (lib/kpi-direction.ts, the single source of truth
 * for the tasa_armado override, HANDOFF §12) and sent along with every
 * write so the report's UMBRAL line stays unambiguous.
 */

import { useState } from 'react';
import { defaultComparator, effectiveDirection } from '@/lib/kpi-direction';
import { resolveTarget, type KpiTarget } from '../historicos/_shared';

interface ConfigKpi {
  id: string;
  name_es: string;
  unit: string;
  direction: string;
  category: string;
  parent_kpi_id: string | null;
  display_order: number;
}

interface ConfigHub {
  id: string;
  display_name: string;
  city: string;
}

// KPIs that flag on "outlier > 2x hub mean" today when no target is set
// (HANDOFF §13, DRIVER_KPI_DEFS). Everything else falls back to the
// existing σ-vs-own-history dashboard coloring / no report flagging.
const OUTLIER_2X_KPI_IDS = new Set(['pct_tardias_reparto', 'pct_undelivered']);

function targetKey(kpiId: string, scopeLevel: 'global' | 'hub', scopeKey: string | null) {
  return `${kpiId}|${scopeLevel}|${scopeKey ?? ''}`;
}

function unitSuffix(unit: string): string {
  if (unit === 'pct') return '%';
  if (unit === 'currency') return '$';
  return '';
}

export function KpiTargetsSection({
  kpis,
  hubs,
  initialTargets,
}: {
  kpis: ConfigKpi[];
  hubs: ConfigHub[];
  initialTargets: KpiTarget[];
}) {
  // Keyed by targetKey() so both the global row and every hub override for
  // every KPI live in one flat map — easy to resolve, easy to update in place.
  const [targets, setTargets] = useState<Map<string, KpiTarget>>(() => {
    const m = new Map<string, KpiTarget>();
    for (const t of initialTargets) m.set(targetKey(t.kpi_id, t.scope_level, t.scope_key), t);
    return m;
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function upsertLocal(t: KpiTarget) {
    setTargets((prev) => {
      const next = new Map(prev);
      next.set(targetKey(t.kpi_id, t.scope_level, t.scope_key), t);
      return next;
    });
  }
  function removeLocal(kpiId: string, scopeLevel: 'global' | 'hub', scopeKey: string | null) {
    setTargets((prev) => {
      const next = new Map(prev);
      next.delete(targetKey(kpiId, scopeLevel, scopeKey));
      return next;
    });
  }

  const targetsArr = Array.from(targets.values());

  function toggleExpanded(kpiId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(kpiId)) next.delete(kpiId);
      else next.add(kpiId);
      return next;
    });
  }

  const sorted = [...kpis].sort((a, b) => a.display_order - b.display_order);

  return (
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-1 flex justify-between">
        Metas / Targets<span className="text-[11.5px] text-[var(--muted)] font-normal">{kpis.length}</span>
      </h2>
      <div className="text-[11.5px] text-[var(--muted)] mb-3">
        Meta global por KPI, con overrides opcionales por hub. En blanco = sin meta (usa el comportamiento actual del reporte/dashboard).
      </div>

      <ul className="text-[12.5px]">
        {sorted.map((kpi) => {
          const dir = effectiveDirection(kpi.id, kpi.direction);
          const cmp = defaultComparator(kpi.id, kpi.direction);
          const globalTarget = targets.get(targetKey(kpi.id, 'global', null));
          const isExpanded = expanded.has(kpi.id);
          const blankHint = OUTLIER_2X_KPI_IDS.has(kpi.id)
            ? 'en blanco: 2× promedio del hub'
            : 'en blanco: sin meta fija';

          return (
            <li key={kpi.id} className={`py-2 border-b border-slate-100 ${kpi.parent_kpi_id ? 'pl-6' : ''}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span>{kpi.parent_kpi_id ? '↳ ' : ''}<b>{kpi.name_es}</b></span>
                  <span className="ml-2 text-[10.5px] uppercase text-[var(--muted)]">
                    {dir === 'higher_is_better' ? '≥' : '≤'} {kpi.unit}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <TargetInput
                    kpiId={kpi.id}
                    scopeLevel="global"
                    scopeKey={null}
                    unit={kpi.unit}
                    comparator={cmp}
                    value={globalTarget?.target_value ?? null}
                    placeholder="—"
                    onSaved={(t) => (t ? upsertLocal(t) : removeLocal(kpi.id, 'global', null))}
                  />
                  <button
                    type="button"
                    onClick={() => toggleExpanded(kpi.id)}
                    className="text-[11px] text-[var(--muted)] hover:text-slate-700 px-1"
                  >
                    {isExpanded ? '▾ hubs' : '▸ hubs'}
                  </button>
                </div>
              </div>
              <div className="text-[10.5px] text-[var(--muted)] mt-0.5">{blankHint}</div>

              {isExpanded && (
                <div className="mt-2 ml-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {hubs.map((hub) => {
                    const hubTarget = targets.get(targetKey(kpi.id, 'hub', hub.id));
                    const effective = resolveTarget(kpi.id, hub.id, targetsArr);
                    const placeholder = effective ? `${effective.target_value}${unitSuffix(kpi.unit)} (global)` : blankHint;
                    return (
                      <div key={hub.id} className="flex items-center justify-between gap-2 bg-slate-50 rounded px-2 py-1">
                        <span className="text-[11.5px] truncate">{hub.display_name}</span>
                        <TargetInput
                          kpiId={kpi.id}
                          scopeLevel="hub"
                          scopeKey={hub.id}
                          unit={kpi.unit}
                          comparator={cmp}
                          value={hubTarget?.target_value ?? null}
                          placeholder={placeholder}
                          onSaved={(t) => (t ? upsertLocal(t) : removeLocal(kpi.id, 'hub', hub.id))}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TargetInput({
  kpiId,
  scopeLevel,
  scopeKey,
  unit,
  comparator,
  value,
  placeholder,
  onSaved,
}: {
  kpiId: string;
  scopeLevel: 'global' | 'hub';
  scopeKey: string | null;
  unit: string;
  comparator: 'gte' | 'lte';
  value: number | null;
  placeholder: string;
  onSaved: (t: KpiTarget | null) => void;
}) {
  const [text, setText] = useState(value !== null ? String(value) : '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function commit() {
    const trimmed = text.trim();

    if (trimmed === '') {
      if (value === null) return; // nothing to clear
      setStatus('saving');
      try {
        const res = await fetch('/api/kpi-targets', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kpi_id: kpiId, scope_level: scopeLevel, scope_key: scopeKey }),
        });
        if (!res.ok) throw new Error(await res.text());
        onSaved(null);
        setStatus('saved');
      } catch {
        setStatus('error');
        setText(value !== null ? String(value) : ''); // revert
      }
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
      const res = await fetch('/api/kpi-targets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kpi_id: kpiId,
          scope_level: scopeLevel,
          scope_key: scopeKey,
          target_value: num,
          comparator,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { target } = await res.json();
      onSaved(target);
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
