'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GenerateInsightsButton({
  weekStart,
  mode = 'weekly_priorities',
  focusAreas,
  view,
  viewKey,
  label,
  size = 'md',
}: {
  weekStart: string;
  mode?: 'weekly_priorities' | 'focus_plan';
  focusAreas?: string[];
  view?: 'global' | 'per_hub' | 'per_category';
  viewKey?: string | null;
  label?: string;
  size?: 'sm' | 'md';
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
          ...(view ? { view } : {}),
          ...(viewKey ? { view_key: viewKey } : {}),
        }),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) {
        const errMsg = json?.message || json?.error || (text && text.length < 200 ? text : null) || `HTTP ${res.status}`;
        setMsg(`Error: ${errMsg}`);
      } else if (json) {
        const cost = json.cost_usd ? `$${json.cost_usd.toFixed(3)}` : '—';
        const warningPreview = json.warnings?.length
          ? ` · ${json.warnings.slice(0, 1).join('').slice(0, 80)}${json.warnings.length > 1 ? ` +${json.warnings.length - 1} más` : ''}`
          : '';
        setMsg(`OK · ${json.inserted} insights · v${json.prompt_version} · ${cost}${warningPreview}`);
        router.refresh();
      }
    } catch (e: any) {
      setMsg(`Error: ${e?.message ?? 'fetch falló'}`);
    } finally {
      setBusy(false);
    }
  }

  const sizeClasses = size === 'sm'
    ? 'px-2 py-1 text-[11px]'
    : 'px-3 py-1.5 text-[12.5px]';

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      <button
        onClick={go}
        disabled={busy}
        className={`bg-black text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50 ${sizeClasses}`}
      >
        {busy ? 'Generando…' : (label ?? '✨ Generar insights')}
      </button>
      {msg && <span className="text-[11px] text-[var(--muted)] max-w-[480px]">{msg}</span>}
    </div>
  );
}
