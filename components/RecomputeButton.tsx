'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { kickBackground } from '@/lib/kick-background';

interface Props {
  weekStart: string;
  label?: string;
  /** When provided, shows a "Recomputar todo" button that processes every week sequentially. */
  allWeeks?: string[];
}

interface RunResult {
  snapshots: number;
  peers: number;
  kpis: number;
  warnings: number;
}

/** Poll cadence. A recompute is tens of seconds, not milliseconds — 2 s keeps
 *  the UI honest without hammering PostgREST for the whole run. */
const POLL_MS = 2000;

/** Hard stop on the client side, comfortably past the background function's
 *  own 15-minute ceiling. */
const POLL_TIMEOUT_MS = 16 * 60 * 1000;

/** How long a run may sit on phase null before we call the start failed.
 *  The background function's first write is `phase: 'tenure'`, and it claims
 *  the run before doing any work, so this only has to cover a cold start.
 *  Session 18: without this, a kick that never reached the function showed as
 *  "trabajando… 310s" and kept going to 16 minutes. */
const START_GRACE_MS = 45_000;

const PHASE_LABEL: Record<string, string> = {
  tenure: 'actualizando antigüedades',
  compute: 'calculando KPIs',
  done: 'guardando',
};

/** Retire a run that never started, so the week isn't blocked for 16 minutes. */
async function abandonRun(runId: string, reason: string) {
  try {
    await fetch('/api/recompute/abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId, reason }),
    });
  } catch { /* best effort — the stale-run window still covers us */ }
}

/**
 * Session 17 (HANDOFF §28): this component used to POST and wait for the
 * response body. That could not work — the recompute outlived Netlify's 26 s
 * ceiling and got killed mid-stream, and the old "if the stream closed early,
 * trust res.ok" fallback turned that silent kill into a cheerful
 * "OK · 0 snapshots". A failed run and an empty week looked identical.
 *
 * Now the POST only creates the run row; this component invokes the background
 * function itself and then polls `recompute_runs` until the row leaves
 * 'running'. The invocation moved here in session 18 because a function
 * invoking another function over HTTP silently does nothing on this site — see
 * lib/kick-background.ts for the measurements.
 */
export function RecomputeButton({ weekStart, label = 'Recomputar snapshots', allWeeks }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const cancelled = useRef(false);

  useEffect(() => () => { cancelled.current = true; }, []);

  /** Start a run and resolve only when it reaches a terminal state. */
  async function runWeek(week: string, prefix = ''): Promise<RunResult> {
    const res = await fetch('/api/recompute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week_start: week }),
    });

    let json: {
      ok?: boolean; run_id?: string; run_token?: string;
      already_running?: boolean; error?: string; message?: string;
    } = {};
    try { json = await res.json(); } catch { /* fall through to the check below */ }

    if (!res.ok || !json.run_id) {
      throw new Error(json.message ?? json.error ?? `no se pudo iniciar (HTTP ${res.status})`);
    }

    const runId = json.run_id;

    // A run handed back as already_running was started by someone else (or by
    // another tab) and has already consumed its token — just poll it.
    if (json.run_token) {
      setMsg(`${prefix}iniciando…`);
      try {
        await kickBackground('recompute-background', { run_id: runId, run_token: json.run_token });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await abandonRun(runId, message);
        throw new Error(message);
      }
    }

    const sb = createClient();
    const startedAt = Date.now();

    for (;;) {
      if (cancelled.current) throw new Error('cancelado');
      await new Promise((r) => setTimeout(r, POLL_MS));

      // Explicit column list — run_token must never come back out of the DB.
      const { data, error } = await sb
        .from('recompute_runs')
        .select('status, phase, error_text, snapshots_written, peers_written, kpis_processed, warnings')
        .eq('id', runId)
        .maybeSingle();

      if (error) throw new Error(`no se pudo leer el estado: ${error.message}`);
      if (!data) throw new Error('el run desapareció');

      if (data.status === 'running') {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);

        // Still no phase means the function never claimed the run. That is a
        // failed start, not slow work, and it says so instead of spinning.
        if (!data.phase && Date.now() - startedAt > START_GRACE_MS) {
          await abandonRun(runId, 'El proceso en segundo plano no arrancó (sin phase).');
          throw new Error(
            `el proceso en segundo plano no arrancó (${elapsed}s sin señal). ` +
            'Revisa los logs de la función recompute-background en Netlify.'
          );
        }

        const phase = PHASE_LABEL[data.phase ?? ''] ?? 'arrancando';
        setMsg(`${prefix}${phase}… ${elapsed}s`);
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          throw new Error('sin respuesta después de 16 min');
        }
        continue;
      }

      if (data.status === 'error') {
        throw new Error(data.error_text ?? 'compute_failed');
      }

      return {
        snapshots: data.snapshots_written ?? 0,
        peers: data.peers_written ?? 0,
        kpis: data.kpis_processed ?? 0,
        warnings: Array.isArray(data.warnings) ? data.warnings.length : 0,
      };
    }
  }

  // Single week
  async function go() {
    setBusy(true); setMsg(null); setFailed(false);
    try {
      const r = await runWeek(weekStart);
      // A genuine zero is now worth flagging: every file for the week is
      // either missing or stuck in `pending`, which is a real problem and not
      // something to report as "OK".
      if (r.snapshots === 0) {
        setFailed(true);
        setMsg('0 snapshots — no hay uploads validados para esta semana. Revisa los archivos pendientes.');
      } else {
        setMsg(`OK · ${r.snapshots} snapshots · ${r.kpis} KPIs` + (r.warnings ? ` · ${r.warnings} warnings` : ''));
      }
      router.refresh();
    } catch (e: unknown) {
      setFailed(true);
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // All weeks — oldest first so history is built up correctly (prev_week_value
  // and the 4w rolling stats of week N read the snapshots of weeks N−1…N−4).
  async function goAll() {
    if (!allWeeks || allWeeks.length === 0) return;
    setBusy(true); setMsg(null); setFailed(false);
    const sorted = [...allWeeks].sort(); // ascending = oldest first
    let totalSnaps = 0;
    const failures: string[] = [];

    for (let i = 0; i < sorted.length; i++) {
      try {
        const r = await runWeek(sorted[i], `Semana ${i + 1}/${sorted.length} · ${sorted[i]} · `);
        totalSnaps += r.snapshots;
        if (r.snapshots === 0) failures.push(sorted[i]);
      } catch {
        failures.push(sorted[i]);
      }
    }

    setFailed(failures.length > 0);
    const failNote = failures.length ? ` · ${failures.length} sem sin datos: ${failures.join(', ')}` : '';
    setMsg(`Listo · ${sorted.length} semanas · ${totalSnaps} snapshots totales${failNote}`);
    router.refresh();
    setBusy(false);
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
      {msg && (
        <span className={`text-[11.5px] ${failed ? 'text-red-600 font-medium' : 'text-[var(--muted)]'}`}>
          {msg}
        </span>
      )}
    </div>
  );
}
