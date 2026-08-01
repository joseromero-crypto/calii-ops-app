'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  appId: string;
  weekStart: string;        // ISO date (Friday)
  city?: string;
  hubId?: string;
  label: string;            // 'Monterrey' | 'MH Contry' | 'Todas las ciudades'
  alreadyUploaded?: boolean;
}

export function UploadDropzone({ appId, weekStart, city, hubId, label, alreadyUploaded }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Set only when the last failure was an identity_* mismatch (city/roster
  // check) — those are the only errors the user can force through. Header/
  // type errors never set this, so no override button appears for them.
  const [pendingOverride, setPendingOverride] = useState<File | null>(null);
  const router = useRouter();

  async function send(file: File, forceIdentity = false) {
    setBusy(true); setError(null); setWarning(null); setPendingOverride(null);
    const fd = new FormData();
    fd.set('app_id', appId);
    fd.set('week_start', weekStart);
    if (city)   fd.set('city', city);
    if (hubId)  fd.set('hub_id', hubId);
    if (forceIdentity) fd.set('force_identity', 'true');
    fd.set('file', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        const msg = json?.report?.errors?.[0]?.message ?? json?.message ?? json?.error ?? 'Falló el upload';
        setError(msg);
        if (json?.overridable) setPendingOverride(file);
      } else {
        if (json.status === 'pending') {
          setWarning(`Subido con ${json.report.warnings.length} warnings — revisar`);
        }
        router.refresh();
      }
    } catch (e: any) {
      setError(e.message ?? 'Error de red');
    } finally {
      setBusy(false);
    }
  }

  function cancelOverride() {
    setError(null);
    setPendingOverride(null);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void send(file);
  }
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void send(file);
  }

  const tone = alreadyUploaded ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white';

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={`block border rounded-md p-2 text-[11.5px] transition-colors hover:border-black ${tone} ${busy ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <label className="flex items-center justify-between cursor-pointer">
        <span className="font-semibold">{label}</span>
        <span className="text-[10px] text-[var(--muted)]">
          {busy ? 'Subiendo…' : alreadyUploaded ? '✓ subido' : 'click o drop CSV'}
        </span>
        <input type="file" accept=".csv,text/csv" onChange={onChange} className="hidden" />
      </label>
      {error && <div className="mt-1 text-red-600 text-[10.5px]">{error}</div>}
      {pendingOverride && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); void send(pendingOverride, true); }}
            className="flex-1 text-center text-[10.5px] font-semibold text-amber-800 bg-amber-50 border border-amber-300 rounded px-2 py-1 hover:bg-amber-100"
          >
            ⚠️ Sé lo que hago, subir de todas formas
          </button>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); cancelOverride(); }}
            className="text-center text-[10.5px] font-semibold text-slate-600 bg-white border border-[var(--line)] rounded px-2 py-1 hover:border-slate-400"
          >
            No, cancelar
          </button>
        </div>
      )}
      {warning && <div className="mt-1 text-amber-700 text-[10.5px]">{warning}</div>}
    </div>
  );
}
