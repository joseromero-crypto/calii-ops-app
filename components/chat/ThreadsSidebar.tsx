'use client';

import clsx from 'clsx';
import type { ConversationRow } from '@/lib/chat/types';

export function ThreadsSidebar({
  conversations, activeId, onSelect, onNew, loading,
}: {
  conversations: ConversationRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading: boolean;
}) {
  return (
    <div className="bg-white border border-[var(--line)] rounded-xl flex flex-col min-h-0">
      <div className="p-3 border-b border-[var(--line)]">
        <button
          onClick={onNew}
          className="w-full text-[13px] font-medium bg-[var(--ink)] text-white rounded-lg py-2 hover:bg-black transition-colors"
        >
          + Nueva investigación
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1.5 min-h-0">
        {loading && (
          <div className="px-3 py-2 text-[12px] text-[var(--muted)]">Cargando…</div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="px-3 py-3 text-[12px] text-[var(--muted)]">Sin conversaciones todavía.</div>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={clsx(
              'w-full text-left px-3 py-2.5 text-[12.5px] leading-snug border-l-2 transition-colors',
              c.id === activeId
                ? 'border-teal-400 bg-teal-400/5 text-[var(--ink)] font-medium'
                : 'border-transparent text-[var(--ink-2)] hover:bg-[var(--line-2)]'
            )}
          >
            <div className="line-clamp-2">{c.title || 'Nueva conversación'}</div>
            <div className="text-[10.5px] text-[var(--muted-2)] mt-0.5">
              {new Date(c.updated_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
