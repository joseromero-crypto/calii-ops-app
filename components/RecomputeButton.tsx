'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RecomputeButton({ weekStart, label = 'Recomputar snapshots' }: { weekStart: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function go() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/recompute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week_start: weekStart }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(`Error: ${json.message ?? json.error}`);
      } else {
        setMsg(
          `OK · ${json.snapshots_written} snapshots · ${json.peers_written} peer rows · ${json.kpis_processed} KPIs` +
          (json.warnings?.length ? ` (${json.warnings.length} warnings)` : '')
        );
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
        {busy ? 'Recomputando…' : label}
      </button>
      {msg && <span className="text-[11.5px] text-[var(--muted)]">{msg}</span>}
    </div>
  );
}
