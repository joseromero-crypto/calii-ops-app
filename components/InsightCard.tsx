'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Insight {
  id: string;
  rank: number | null;
  view: string | null;
  view_key: string | null;
  kpi_id: string | null;
  scope_type: string | null;
  scope_key: string | null;
  headline_es: string;
  evidence_md: string | null;
  recommended_actions_md: string | null;
  flag_actions_md: string | null;
  linked_entities: Record<string, string[]> | null;
  why_now_es: string | null;
  source_files: { file: string; rows: string; notes?: string }[] | null;
  user_feedback: string | null;
  prompt_version: number;
  generated_at: string;
}

export function InsightCard({ insight, kpiName, ownerRole }: { insight: Insight; kpiName?: string; ownerRole?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState(insight.user_feedback);

  async function feedback(action: 'thumbs_up' | 'thumbs_down' | 'fuera_de_scope' | 'reformular') {
    setBusy(true);
    try {
      const res = await fetch('/api/insights/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ insight_id: insight.id, action }),
      });
      if (res.ok) {
        if (action === 'thumbs_up' || action === 'thumbs_down') setLocalFeedback(action);
        if (action === 'fuera_de_scope' || action === 'reformular') router.push('/config');
      }
    } finally {
      setBusy(false);
    }
  }

  const rankClass =
    insight.rank === 1 ? 'border-l-red-500' :
    insight.rank === 2 ? 'border-l-amber-500' :
    insight.rank === 3 ? 'border-l-teal-400' :
    'border-l-slate-300';

  return (
    <div className={`bg-white border border-[var(--line)] border-l-4 ${rankClass} rounded-xl p-5 shadow-soft`}>
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <span className={`inline-flex items-center text-[10.5px] font-bold uppercase tracking-wide px-2 py-1 rounded-full ${
          insight.rank === 1 ? 'bg-red-100 text-red-600' :
          insight.rank === 2 ? 'bg-amber-100 text-amber-700' :
          insight.rank === 3 ? 'bg-teal-100 text-teal-800' :
          'bg-slate-100 text-slate-500'
        }`}>● Top {insight.rank ?? '—'}</span>
        <span className="text-[11px] text-[var(--muted)]">
          {kpiName ?? insight.kpi_id ?? '—'}
        </span>
      </div>

      <h3 className="text-[15.5px] font-semibold leading-snug">{insight.headline_es}</h3>

      <div className="flex flex-wrap gap-1.5 mt-2 mb-3">
        {insight.kpi_id && <Tag tone="kpi">KPI · {kpiName ?? insight.kpi_id}</Tag>}
        {insight.scope_key && <Tag tone="scope">Scope · {insight.scope_key}</Tag>}
        {ownerRole && <Tag tone="owner">Owner · {ownerRole}</Tag>}
      </div>

      {insight.source_files && insight.source_files.length > 0 && (
        <div className="bg-slate-50 border border-dashed border-[var(--line)] rounded-md px-2.5 py-1.5 text-[11px] text-[var(--muted)] mb-3 flex items-center gap-2 flex-wrap">
          <span>📂 Fuente:</span>
          {insight.source_files.slice(0, 3).map((f, i) => (
            <span key={i}>
              <code className="bg-white px-1.5 py-0.5 rounded border border-[var(--line)] text-[10.5px] text-slate-700">{f.file}</code>
              <span className="ml-1 text-slate-500">{f.rows}</span>
              {f.notes && <span className="ml-1 italic text-slate-500">· {f.notes}</span>}
            </span>
          ))}
        </div>
      )}

      {insight.evidence_md && (
        <div className="bg-slate-50 border border-[var(--line)] rounded-md px-3 py-2.5 text-[12px] text-slate-700 mb-3">
          <span className="block text-[10.5px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">Evidencia</span>
          <Markdown text={insight.evidence_md} />
        </div>
      )}

      {insight.recommended_actions_md && (
        <div className="mb-3">
          <span className="block text-[10.5px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">Acciones recomendadas — Operaciones</span>
          <div className="text-[12.5px] text-slate-800 leading-relaxed pl-4 border-l-2 border-teal-400">
            <Markdown text={insight.recommended_actions_md} />
          </div>
        </div>
      )}

      {insight.flag_actions_md && (
        <div className="mb-3 border-t border-dashed border-[var(--line)] pt-3">
          <span className="block text-[10.5px] uppercase tracking-wide font-bold text-[var(--muted)] mb-1">Para flagear (no es Ops)</span>
          <div className="text-[12px] text-orange-900 leading-relaxed bg-orange-50 border border-orange-100 rounded-md px-3 py-2">
            <Markdown text={insight.flag_actions_md} />
          </div>
        </div>
      )}

      {insight.linked_entities && Object.keys(insight.linked_entities).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {Object.entries(insight.linked_entities).map(([type, ids]) =>
            ids.slice(0, 5).map((id) => (
              <span key={`${type}:${id}`} className="inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--line)] rounded-full text-[11px] bg-white text-slate-700">
                {iconForType(type)} {id}
              </span>
            ))
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-100">
        <div className="text-[11.5px] text-[var(--muted)] italic flex-1 min-w-0">
          {insight.why_now_es && <><b className="not-italic text-slate-700">¿Por qué ahora?</b> {insight.why_now_es}</>}
        </div>
        <div className="flex items-center gap-1">
          <button
            disabled={busy}
            onClick={() => feedback('thumbs_up')}
            className={`w-7 h-7 border rounded-md text-[12px] flex items-center justify-center ${localFeedback === 'thumbs_up' ? 'bg-teal-100 border-teal-400 text-teal-700' : 'border-[var(--line)] text-[var(--muted)] hover:border-slate-700'}`}
            title="Útil"
          >👍</button>
          <button
            disabled={busy}
            onClick={() => feedback('thumbs_down')}
            className={`w-7 h-7 border rounded-md text-[12px] flex items-center justify-center ${localFeedback === 'thumbs_down' ? 'bg-red-50 border-red-400 text-red-700' : 'border-[var(--line)] text-[var(--muted)] hover:border-slate-700'}`}
            title="No útil"
          >👎</button>
          <button
            disabled={busy}
            onClick={() => feedback('reformular')}
            className="text-[10.5px] px-2 py-1 border border-[var(--line)] rounded-md text-[var(--muted)] hover:border-teal-400 hover:text-teal-700"
            title="Regenerar este insight"
          >Reformular</button>
          <button
            disabled={busy}
            onClick={() => feedback('fuera_de_scope')}
            className="text-[10.5px] px-2 py-1 border border-[var(--line)] rounded-md text-[var(--muted)] hover:border-red-400 hover:text-red-600"
            title="Crear regla para excluir este tipo de insight"
          >Fuera de scope</button>
        </div>
      </div>
    </div>
  );
}

function Tag({ tone, children }: { tone: 'kpi' | 'scope' | 'owner'; children: React.ReactNode }) {
  const colors = {
    kpi: 'bg-cyan-50 text-cyan-900',
    scope: 'bg-violet-50 text-violet-900',
    owner: 'bg-orange-50 text-orange-900',
  };
  return (
    <span className={`text-[10.5px] px-2 py-0.5 rounded-md font-semibold ${colors[tone]}`}>
      {children}
    </span>
  );
}

function iconForType(t: string): string {
  switch (t) {
    case 'operators': return '👤';
    case 'drivers':   return '🚚';
    case 'skus':      return '📦';
    case 'hubs':      return '🏬';
    default:          return '·';
  }
}

function Markdown({ text }: { text: string }) {
  // Tiny renderer: bold (**...**), bullets (- ..., 1. ...), and line breaks.
  // For richer markdown later we'll swap in `react-markdown`.
  const lines = text.split('\n');
  const out: JSX.Element[] = [];
  let listBuf: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (!listBuf) return;
    const Tag = listBuf.ordered ? 'ol' : 'ul';
    out.push(
      <Tag key={`l-${out.length}`} className={listBuf.ordered ? 'list-decimal pl-5 space-y-0.5' : 'list-disc pl-5 space-y-0.5'}>
        {listBuf.items.map((it, i) => (
          <li key={i} dangerouslySetInnerHTML={{ __html: inline(it) }} />
        ))}
      </Tag>
    );
    listBuf = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    const olMatch = /^\d+\.\s+(.*)$/.exec(line);
    const ulMatch = /^[-*]\s+(.*)$/.exec(line);
    if (olMatch) {
      if (!listBuf || !listBuf.ordered) { flushList(); listBuf = { ordered: true, items: [] }; }
      listBuf.items.push(olMatch[1]);
    } else if (ulMatch) {
      if (!listBuf || listBuf.ordered) { flushList(); listBuf = { ordered: false, items: [] }; }
      listBuf.items.push(ulMatch[1]);
    } else {
      flushList();
      out.push(<p key={`p-${out.length}`} dangerouslySetInnerHTML={{ __html: inline(line) }} />);
    }
  }
  flushList();
  return <div className="space-y-1">{out}</div>;
}

function inline(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code class="bg-slate-100 px-1 rounded text-[11px]">$1</code>');
}
