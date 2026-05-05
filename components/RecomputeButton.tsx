'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  weekStart: string;
  label?: string;
  /** When provided, shows a "Recomputar todo" button that processes every week sequentially. */
  allWeeks?: string[];
}

export function RecomputeButton({ weekStart, label = 'Recomputar snapshots', allWeeks }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  // The API streams keepalive '\n' chars before the final JSON payload.
  // Using res.text() + trim() avoids "Unexpected end of JSON input" from res.json().
  async function callRecompute(week: string): Promise<{ ok: boolean; snapshots: number; kpis: number; warnings: number }> {
    const res = await fetch('/api/recompute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week_start: week }),
    });
    const text = await res.text();
    const json = JSON.parse(text.trim());
    if (!res.ok || !json.ok) throw new Error(json.message ?? json.error ?? 'compute_failed');
    return {
      ok: true,
      snapshots: json.snapshots_written ?? 0,
      kpis: json.kpis_processed ?? 0,
      warnings: json.warnings?.length ?? 0,
    };
  }

  // Single week
  async function go() {
    setBusy(true); setMsg(null);
    try {
      const r = await callRecompute(weekStart);
      setMsg(`OK · ${r.snapshots} snapshots · ${r.kpis} KPIs` + (r.warnings ? ` · ${r.warnings} warnings` : ''));
      router.refresh();
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // All weeks — oldest first so history is built up correctly
  async function goAll() {
    if (!allWeeks || allWeeks.length === 0) return;
    setBusy(true); setMsg(null);
    const sorted = [...allWeeks].sort(); // ascending = oldest first
    let totalSnaps = 0;
    try {
      for (let i = 0; i < sorted.length; i++) {
        setMsg(`Semana ${i + 1} / ${sorted.length}: ${sorted[i]}…`);
        const r = await callRecompute(sorted[i]);
        totalSnaps += r.snapshots;
      }
      setMsg(`Listo · ${sorted.length} semanas · ${totalSnaps} snapshots totales`);
      router.refresh();
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      <button
        onClick={go}
        disabled={busy}
        className="bg-black text-white rounded-lg px-3 py-1.5 text-[12.5px] font-medium hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? 'Recomputando…' : label}
      </button>
      {allWeeks && allWeeks.length > 1 && (
        <button
          onClick={goAll}
          disabled={busy}
          className="bg-slate-700 text-white rounded-lg px-3 py-1.5 text-[12.5px] font-medium hover:bg-slate-600 disabled:opacity-50"
        >
          {busy ? 'Recomputando…' : `Recomputar todo (${allWeeks.length} sem)`}
        </button>
      )}
      {msg && <span className="text-[11.5px] text-[var(--muted)]">{msg}</span>}
    </div>
  );
}
