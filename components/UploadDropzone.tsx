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
  const router = useRouter();

  async function send(file: File) {
    setBusy(true); setError(null); setWarning(null);
    const fd = new FormData();
    fd.set('app_id', appId);
    fd.set('week_start', weekStart);
    if (city)   fd.set('city', city);
    if (hubId)  fd.set('hub_id', hubId);
    fd.set('file', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) {
        const msg = json?.report?.errors?.[0]?.message ?? json?.message ?? json?.error ?? 'Falló el upload';
        setError(msg);
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
    <label
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className={`block border rounded-md p-2 text-[11.5px] cursor-pointer transition-colors hover:border-black ${tone} ${busy ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{label}</span>
        <span className="text-[10px] text-[var(--muted)]">
          {busy ? 'Subiendo…' : alreadyUploaded ? '✓ subido' : 'click o drop CSV'}
        </span>
      </div>
      {error && <div className="mt-1 text-red-600 text-[10.5px]">{error}</div>}
      {warning && <div className="mt-1 text-amber-700 text-[10.5px]">{warning}</div>}
      <input type="file" accept=".csv,text/csv" onChange={onChange} className="hidden" />
    </label>
  );
}
