'use client';

import clsx from 'clsx';
import type { ConversationRow } from '@/lib/chat/types';

export function ThreadsSidebar({
  conversations, activeId, onSelect, onNew, onArchive, lastArchived, onUndoArchive, loading,
}: {
  conversations: ConversationRow[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Soft-archive — the conversation and all its evidence stay in the DB. */
  onArchive: (id: string) => void;
  lastArchived: ConversationRow | null;
  onUndoArchive: () => void;
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
          // A row is a div, not a button: the archive control is a button and
          // nesting one inside another is invalid HTML (and the inner click
          // never reliably wins).
          <div
            key={c.id}
            className={clsx(
              'group relative border-l-2 transition-colors',
              c.id === activeId
                ? 'border-teal-400 bg-teal-400/5'
                : 'border-transparent hover:bg-[var(--line-2)]'
            )}
          >
            <button
              onClick={() => onSelect(c.id)}
              className={clsx(
                'w-full text-left pl-3 pr-8 py-2.5 text-[12.5px] leading-snug',
                c.id === activeId ? 'text-[var(--ink)] font-medium' : 'text-[var(--ink-2)]'
              )}
            >
              <div className="line-clamp-2">{c.title || 'Nueva conversación'}</div>
              <div className="text-[10.5px] text-[var(--muted-2)] mt-0.5">
                {new Date(c.updated_at).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
            </button>
            <button
              type="button"
              aria-label={`Archivar ${c.title || 'conversación'}`}
              title="Archivar"
              onClick={() => onArchive(c.id)}
              className="absolute top-2 right-1.5 w-6 h-6 rounded-md flex items-center justify-center text-[13px] leading-none
                         text-[var(--muted-2)] opacity-0 group-hover:opacity-100 focus:opacity-100
                         hover:bg-[var(--line)] hover:text-[var(--ink)] transition-opacity"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {lastArchived && (
        <div className="px-3 py-2 border-t border-[var(--line)] text-[11.5px] text-[var(--muted)] flex items-center justify-between gap-2">
          <span className="truncate">Archivada</span>
          <button onClick={onUndoArchive} className="font-medium underline flex-none text-[var(--ink-2)] hover:text-[var(--ink)]">
            Deshacer
          </button>
        </div>
      )}
    </div>
  );
}
