'use client';

import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { resolveClaimEvidence } from '@/lib/chat/client';
import type { ClaimRow, ToolCallRow } from '@/lib/chat/types';

interface Provenance {
  tool: string;
  args: Record<string, unknown>;
  source: { file: string; columns: string[] }[];
  rows_in: number;
  rows_out: number;
  filters: string[];
}

function downloadCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** rows shaped like kpiTrend's { week_start, value, ... } render as a line chart; anything else falls back to a table. */
function looksLikeTrend(rows: Record<string, unknown>[]): boolean {
  return rows.length > 1 && 'week_start' in rows[0] && 'value' in rows[0];
}

export function ExhibitionPane({ claim, toolCall }: { claim: ClaimRow | null; toolCall: ToolCallRow | null | undefined }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [rowsOut, setRowsOut] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!claim) { setRows(null); setError(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    resolveClaimEvidence(claim.id).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setError(res.message ?? 'No se pudo resolver la evidencia.'); setRows(null); }
      else { setRows((res.rows as Record<string, unknown>[]) ?? []); setRowsOut(res.rows_out ?? null); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [claim?.id]);

  if (!claim) {
    return (
      <div className="bg-white border border-[var(--line)] rounded-xl h-full flex items-center justify-center p-6 text-center">
        <div className="text-[12.5px] text-[var(--muted)] max-w-[220px]">
          Haz clic en un número citado <span className="inline-block bg-teal-400/15 text-teal-700 text-[9.5px] font-semibold rounded px-1 mx-0.5">c1</span> en la respuesta para ver la evidencia aquí.
        </div>
      </div>
    );
  }

  const provenance = toolCall?.provenance as Provenance | null | undefined;
  const highlight = new Set(claim.evidence.highlight ?? []);
  const isChart = claim.evidence.kind === 'chart' && rows && looksLikeTrend(rows);

  return (
    <div className="bg-white border border-[var(--line)] rounded-xl h-full flex flex-col min-h-0">
      <div className="p-3.5 border-b border-[var(--line)]">
        <div className="text-[12.5px] font-medium text-[var(--ink)] leading-snug">{claim.text}</div>
        {provenance && (
          <div className="mt-2 text-[10.5px] text-[var(--muted)] space-y-0.5">
            <div><span className="font-medium">Fuente:</span> {provenance.source.map((s) => s.file).join(', ')}</div>
            {provenance.source.some((s) => s.columns.length) && (
              <div><span className="font-medium">Columnas:</span> {[...new Set(provenance.source.flatMap((s) => s.columns))].join(', ')}</div>
            )}
            {provenance.filters.length > 0 && <div><span className="font-medium">Filtros:</span> {provenance.filters.join(' · ')}</div>}
            <div><span className="font-medium">Filas:</span> {provenance.rows_in} escaneadas → {provenance.rows_out} en el resultado</div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3.5 min-h-0">
        {loading && <div className="text-[12px] text-[var(--muted)]">Cargando evidencia…</div>}
        {error && <div className="text-[12px] text-red-600">{error}</div>}
        {!loading && !error && rows && rows.length === 0 && (
          <div className="text-[12px] text-[var(--muted)]">Sin filas para esta evidencia.</div>
        )}

        {!loading && !error && rows && rows.length > 0 && isChart && (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows as any}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="week_start" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDataOverflow />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="value" stroke="var(--teal-strong)" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {!loading && !error && rows && rows.length > 0 && !isChart && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr>
                  {Object.keys(rows[0]).map((col) => (
                    <th
                      key={col}
                      className={`text-left px-2 py-1.5 border-b border-[var(--line)] font-semibold whitespace-nowrap ${highlight.has(col) ? 'bg-teal-400/10 text-teal-700' : 'text-[var(--muted)]'}`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((row, i) => (
                  <tr key={i} className="odd:bg-[var(--line-2)]/40">
                    {Object.keys(rows[0]).map((col) => (
                      <td key={col} className={`px-2 py-1 border-b border-[var(--line-2)] whitespace-nowrap ${highlight.has(col) ? 'bg-teal-400/5 font-medium' : ''}`}>
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 200 && (
              <div className="text-[11px] text-[var(--muted)] mt-2">Mostrando 200 de {rowsOut ?? rows.length} filas — descarga el CSV para verlas todas.</div>
            )}
          </div>
        )}
      </div>

      {rows && rows.length > 0 && (
        <div className="p-2.5 border-t border-[var(--line)]">
          <button
            onClick={() => downloadCsv(rows, `evidencia-${claim.claim_ref}.csv`)}
            className="text-[11.5px] font-medium text-teal-700 hover:text-teal-800 flex items-center gap-1"
          >
            ↓ Descargar CSV
          </button>
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
