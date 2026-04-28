'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GenerateInsightsButton({
  weekStart,
  mode = 'weekly_priorities',
  focusAreas,
  label,
}: {
  weekStart: string;
  mode?: 'weekly_priorities' | 'focus_plan';
  focusAreas?: string[];
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function go() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/insights/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          week_start: weekStart,
          mode,
          ...(focusAreas ? { focus_areas: focusAreas } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(`Error: ${json.message ?? json.error}`);
      } else {
        const cost = json.cost_usd ? `$${json.cost_usd.toFixed(3)}` : '—';
        setMsg(`OK · ${json.inserted} insights · v${json.prompt_version} · ${cost}` + (json.warnings?.length ? ` (${json.warnings.length} warnings)` : ''));
        router.refresh();
      }
    } catch (e: any) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={go}
        disabled={busy}
        className="bg-black text-white rounded-lg px-3 py-1.5 text-[12.5px] font-medium hover:bg-slate-800 disabled:opacity-50"
      >
        {busy
          ? (mode === 'focus_plan' ? 'Generando plan…' : 'Generando insights…')
          : (label ?? (mode === 'focus_plan' ? '✨ Generar plan' : '✨ Generar insights'))}
      </button>
      {msg && <span className="text-[11.5px] text-[var(--muted)] max-w-[420px]">{msg}</span>}
    </div>
  );
}
