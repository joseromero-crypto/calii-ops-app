'use client';

/**
 * "Mínimo de armado por auxiliar" editor for /config.
 *
 * Grid: puesto × (Global + each hub). Pedidos armados por semana. Feeds the
 * "Armado auxiliares" block of the Generar reporte Slack text through
 * lib/aux-minimos.ts — the resolver used here for placeholders is the same
 * one the report uses, so what this grid shows is what the report applies.
 *
 * Blank hub cell = use the global. Blank global = code default (sheet values).
 * Writes go to /api/aux-minimos.
 */

import { useState } from 'react';
import {
  AUX_POSITION_ORDER, AUX_POSITION_LABEL, DEFAULT_MINIMO,
  globalMinimo, tieneRecibo,
  type AuxConfig, type AuxMinimoDbRow, type AuxHubSettingDbRow, type AuxPosition,
} from '@/lib/aux-minimos';

interface ConfigHub { id: string; display_name: string }

const rowKey = (position: string, scopeLevel: 'global' | 'hub', scopeKey: string | null) =>
  `${position}|${scopeLevel}|${scopeKey ?? ''}`;

export function AuxMinimosSection({
  hubs,
  initialMinimos,
  initialHubSettings,
}: {
  hubs: ConfigHub[];
  initialMinimos: AuxMinimoDbRow[];
  initialHubSettings: AuxHubSettingDbRow[];
}) {
  const [minimos, setMinimos] = useState<Map<string, AuxMinimoDbRow>>(
    () => new Map(initialMinimos.map((r) => [rowKey(r.position, r.scope_level, r.scope_key), r])),
  );
  const [hubSettings, setHubSettings] = useState<AuxHubSettingDbRow[]>(initialHubSettings);
  const [reciboStatus, setReciboStatus] = useState<Record<string, 'saving' | 'error' | undefined>>({});

  const config: AuxConfig = { minimos: [...minimos.values()], hubSettings };

  function onSaved(position: AuxPosition, scopeLevel: 'global' | 'hub', scopeKey: string | null, row: AuxMinimoDbRow | null) {
    setMinimos((prev) => {
      const next = new Map(prev);
      const k = rowKey(position, scopeLevel, scopeKey);
      if (row) next.set(k, row); else next.delete(k);
      return next;
    });
  }

  async function toggleRecibo(hubId: string, value: boolean) {
    setReciboStatus((s) => ({ ...s, [hubId]: 'saving' }));
    try {
      const res = await fetch('/api/aux-minimos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hub_id: hubId, tiene_recibo: value }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { setting } = await res.json();
      setHubSettings((prev) => [...prev.filter((h) => h.hub_id !== hubId), setting]);
      setReciboStatus((s) => ({ ...s, [hubId]: undefined }));
    } catch {
      setReciboStatus((s) => ({ ...s, [hubId]: 'error' }));
    }
  }

  return (
    <section className="bg-white border border-[var(--line)] rounded-xl p-5 mb-4 shadow-soft">
      <h2 className="text-[14px] font-semibold mb-1">Mínimo de armado por auxiliar</h2>
      <div className="text-[11.5px] text-[var(--muted)] mb-3">
        Pedidos armados por semana, por puesto. Hub en blanco = usa el global. Los puestos por debajo
        de su mínimo aparecen en &quot;Armado auxiliares&quot; del reporte semanal. Sin aux de recibo,
        una cuenta de recibo cuenta como aux de calidad.
      </div>

      <div className="overflow-x-auto">
        <table className="text-[12px] border-collapse">
          <thead>
            <tr className="text-[11px] text-[var(--muted)]">
              <th className="text-left font-medium pr-3 pb-1.5 sticky left-0 bg-white">Puesto</th>
              <th className="font-medium px-1 pb-1.5">Global</th>
              {hubs.map((h) => (
                <th key={h.id} className="font-medium px-1 pb-1.5 whitespace-nowrap">{h.display_name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AUX_POSITION_ORDER.map((position) => (
              <tr key={position} className="border-t border-slate-100">
                <td className="pr-3 py-1 whitespace-nowrap font-medium sticky left-0 bg-white">{AUX_POSITION_LABEL[position]}</td>
                <td className="px-1 py-1">
                  <MinimoInput
                    position={position}
                    scopeLevel="global"
                    scopeKey={null}
                    value={minimos.get(rowKey(position, 'global', null))?.minimo ?? null}
                    placeholder={`${DEFAULT_MINIMO[position]}`}
                    onSaved={(r) => onSaved(position, 'global', null, r)}
                  />
                </td>
                {hubs.map((h) => {
                  if (position === 'recibo' && !tieneRecibo(h.id, config)) {
                    return <td key={h.id} className="px-1 py-1 text-center text-[var(--muted)]">—</td>;
                  }
                  return (
                    <td key={h.id} className="px-1 py-1">
                      <MinimoInput
                        position={position}
                        scopeLevel="hub"
                        scopeKey={h.id}
                        value={minimos.get(rowKey(position, 'hub', h.id))?.minimo ?? null}
                        placeholder={`${globalMinimo(position, config)}`}
                        onSaved={(r) => onSaved(position, 'hub', h.id, r)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-slate-200">
              <td className="pr-3 py-1.5 whitespace-nowrap text-[11.5px] text-[var(--muted)] sticky left-0 bg-white">Tiene aux de recibo</td>
              <td />
              {hubs.map((h) => (
                <td key={h.id} className="px-1 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={tieneRecibo(h.id, config)}
                    disabled={reciboStatus[h.id] === 'saving'}
                    onChange={(e) => toggleRecibo(h.id, e.target.checked)}
                  />
                  {reciboStatus[h.id] === 'error' && <span className="ml-1 text-red-600 text-[10.5px]">!</span>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MinimoInput({
  position, scopeLevel, scopeKey, value, placeholder, onSaved,
}: {
  position: AuxPosition;
  scopeLevel: 'global' | 'hub';
  scopeKey: string | null;
  value: number | null;
  placeholder: string;
  onSaved: (row: AuxMinimoDbRow | null) => void;
}) {
  const [text, setText] = useState(value !== null ? String(value) : '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const revert = () => setText(value !== null ? String(value) : '');

  async function commit() {
    const trimmed = text.trim();
    const isClear = trimmed === '';
    if (isClear && value === null) return;
    const num = Number(trimmed);
    if (!isClear && (!Number.isFinite(num) || num < 0)) { setStatus('error'); revert(); return; }
    if (!isClear && num === Number(value)) return;

    setStatus('saving');
    try {
      const res = await fetch('/api/aux-minimos', {
        method: isClear ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isClear
            ? { position, scope_level: scopeLevel, scope_key: scopeKey }
            : { position, scope_level: scopeLevel, scope_key: scopeKey, minimo: num },
        ),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved(isClear ? null : (await res.json()).minimo);
      setStatus('saved');
    } catch {
      setStatus('error');
      revert();
    }
  }

  return (
    <div className="flex items-center gap-0.5">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setStatus('idle'); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="w-12 text-[12px] text-right border border-slate-200 rounded px-1.5 py-0.5 placeholder:text-slate-300 focus:outline-none focus:border-slate-400"
      />
      <span className="w-2.5 text-[10.5px]">
        {status === 'saving' && <span className="text-slate-400">…</span>}
        {status === 'saved' && <span className="text-emerald-600">✓</span>}
        {status === 'error' && <span className="text-red-600">!</span>}
      </span>
    </div>
  );
}
