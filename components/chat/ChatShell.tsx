'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startTurn } from '@/lib/chat/client';
import { listConversations, loadConversation, setConversationArchived } from '@/lib/chat/load';
import type { ConversationRow, MessageWithChildren, ClaimRow, ToolCallRow } from '@/lib/chat/types';
import { ThreadsSidebar } from './ThreadsSidebar';
import { MessageBubble, MessageContent } from './MessageBubble';
import { ToolCallChip, type ToolCallView } from './ToolCallChip';
import { ExhibitionPane } from './ExhibitionPane';

/**
 * Poll cadence while a turn runs in the background function. 1.5 s keeps the
 * tool chips feeling live without hammering Supabase — a deep turn can run for
 * minutes, and each tick is one indexed read of this conversation.
 */
const POLL_MS = 1500;

type LiveSegment = { type: 'text'; text: string } | { type: 'tool'; call: ToolCallView };

export function ChatShell() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageWithChildren[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [turnError, setTurnError] = useState<{ message: string; retryable?: boolean; assistantMessageId?: string } | null>(null);
  const [lastArchived, setLastArchived] = useState<ConversationRow | null>(null);

  const [activeClaim, setActiveClaim] = useState<ClaimRow | null>(null);
  const [activeClaimToolCall, setActiveClaimToolCall] = useState<ToolCallRow | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // openConversation is defined above pollTurn (it is a dependency of nothing
  // else and pollTurn needs refreshConversations), so it reaches it through a
  // ref rather than reordering the whole component.
  const pollTurnRef = useRef<((conversationId: string, assistantMessageId: string) => void) | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
  }, []);

  // Never leave a poll running behind an unmounted component.
  useEffect(() => stopPolling, [stopPolling]);

  const refreshConversations = useCallback(async () => {
    setConversationsLoading(true);
    try { setConversations(await listConversations()); } catch { /* leave stale list rather than blank on a transient error */ }
    setConversationsLoading(false);
  }, []);

  useEffect(() => { refreshConversations(); }, [refreshConversations]);

  const openConversation = useCallback(async (id: string) => {
    stopPolling();
    setActiveId(id);
    setActiveClaim(null); setActiveClaimToolCall(null);
    setTurnError(null);
    setSending(false);
    setMessagesLoading(true);
    try {
      const rows = await loadConversation(id);
      setMessages(rows);
      // The turn outlives the tab that started it — if one is still working,
      // rejoin it instead of showing a half-finished conversation as finished.
      const running = rows.find((m) => m.role === 'assistant' && m.status === 'running');
      if (running) { setSending(true); pollTurnRef.current?.(id, running.id); }
    } finally { setMessagesLoading(false); }
  }, [stopPolling]);

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setActiveClaim(null); setActiveClaimToolCall(null);
    setTurnError(null);
    // The button used to look dead here: a finished (or failed) turn lived in
    // pendingUserMessage/liveSegments/liveText, and clearing only `messages`
    // left it on screen. Those three are gone now — the DB is the only source
    // of what is rendered — so clearing `messages` really does clear the view.
    setSending(false);
    stopPolling();
  }, [stopPolling]);

  /** Soft-archive; the row goes away but nothing is destroyed, so this is undoable. */
  const archiveConversation = useCallback(async (id: string) => {
    const row = conversations.find((c) => c.id === id) ?? null;
    setConversations((cs) => cs.filter((c) => c.id !== id));   // optimistic
    if (activeIdRef.current === id) startNew();
    try {
      await setConversationArchived(id, true);
      setLastArchived(row);
    } catch {
      refreshConversations();  // put it back — the archive didn't stick
    }
  }, [conversations, startNew, refreshConversations]);

  const undoArchive = useCallback(async () => {
    const row = lastArchived;
    if (!row) return;
    setLastArchived(null);
    try { await setConversationArchived(row.id, false); } finally { refreshConversations(); }
  }, [lastArchived, refreshConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  /**
   * Poll the DB until the turn leaves 'running'.
   *
   * The turn runs in a background function now (HANDOFF §27), so the database
   * — not this component — is the source of truth for what has happened. That
   * also means a turn survives this tab: `openConversation` restarts the poll
   * on any conversation it finds mid-flight, so closing the laptop during a
   * long investigation no longer loses it.
   */
  const pollTurn = useCallback((conversationId: string, assistantMessageId: string) => {
    stopPolling();
    const tick = async () => {
      let rows: MessageWithChildren[];
      try {
        rows = await loadConversation(conversationId);
      } catch {
        // Transient read failure — the turn is still running server-side, so
        // keep waiting rather than reporting a failure that didn't happen.
        pollRef.current = setTimeout(tick, POLL_MS);
        return;
      }
      setMessages(rows);

      const turn = rows.find((m) => m.id === assistantMessageId);
      if (!turn || turn.status === 'running') {
        pollRef.current = setTimeout(tick, POLL_MS);
        return;
      }

      pollRef.current = null;
      setSending(false);
      if (turn.status === 'error') {
        setTurnError({
          message: turn.error_text ?? 'La investigación se detuvo por un error.',
          retryable: true,
          assistantMessageId,
        });
      }
      refreshConversations();
    };
    tick();
  }, [refreshConversations, stopPolling]);
  pollTurnRef.current = pollTurn;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setTurnError(null);
    try {
      const started = await startTurn({ conversationId: activeId ?? undefined, userMessage: text });
      if (!activeIdRef.current) { setActiveId(started.conversation_id); refreshConversations(); }
      pollTurn(started.conversation_id, started.assistant_message_id);
    } catch (e) {
      setSending(false);
      setTurnError({ message: e instanceof Error ? e.message : String(e) });
    }
  }, [input, sending, activeId, pollTurn, refreshConversations]);

  /** Resume a turn that died — no tool is re-run, they are replayed from the DB. */
  const retry = useCallback(async () => {
    const id = turnError?.assistantMessageId;
    if (!id) return;
    setTurnError(null);
    setSending(true);
    try {
      const started = await startTurn({ assistantMessageId: id });
      pollTurn(started.conversation_id, started.assistant_message_id);
    } catch (e) {
      setSending(false);
      setTurnError({ message: e instanceof Error ? e.message : String(e), retryable: true, assistantMessageId: id });
    }
  }, [turnError, pollTurn]);

  const openClaim = useCallback((claim: ClaimRow, toolCalls: ToolCallRow[]) => {
    setActiveClaim(claim);
    setActiveClaimToolCall(toolCalls.find((tc) => tc.id === claim.tool_call_id) ?? null);
  }, []);

  return (
    <div className="h-[calc(100vh-32px)] lg:h-[calc(100vh-56px)] -mt-1 grid grid-cols-1 lg:grid-cols-[220px_1fr_360px] gap-4 min-h-0">
      <div className="hidden lg:block min-h-0">
        <ThreadsSidebar conversations={conversations} activeId={activeId} onSelect={openConversation} onNew={startNew} onArchive={archiveConversation}
          lastArchived={lastArchived} onUndoArchive={undoArchive} loading={conversationsLoading} />
      </div>

      <div className="bg-white border border-[var(--line)] rounded-xl flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-[var(--line)] flex items-center justify-between">
          <div>
            <h1 className="text-[15px] font-bold">Investigar</h1>
            <div className="text-[11.5px] text-[var(--muted)]">Pregunta por qué, no qué — cruza los archivos que necesite.</div>
          </div>
          <button onClick={startNew} className="lg:hidden text-[12px] font-medium text-teal-700">+ Nueva</button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
          {messagesLoading && <div className="text-[12.5px] text-[var(--muted)]">Cargando conversación…</div>}

          {!messagesLoading && messages.length === 0 && !sending && (
            <div className="h-full flex items-center justify-center text-center px-8">
              <div className="text-[13px] text-[var(--muted)] max-w-[320px]">
                Pregunta algo como <span className="italic">&ldquo;¿Por qué Contry tiene más faltantes que los demás hubs?&rdquo;</span> — la respuesta puede tardar, revisa varios archivos si hace falta.
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageBubble key={m.id} role={m.role}>
              {m.role === 'user' ? (
                m.content
              ) : (
                <div className="space-y-2">
                  {m.tool_calls.map((tc) => (
                    <ToolCallChip
                      key={tc.id}
                      call={{ key: tc.id, tool_name: tc.tool_name, args: tc.args, status: tc.error ? 'error' : 'done', result: tc.error ?? tc.result, duration_ms: tc.duration_ms }}
                    />
                  ))}
                  {m.content && (
                    <MessageContent
                      text={m.content}
                      claims={m.claims}
                      activeClaimId={activeClaim?.id}
                      onClaimClick={(c) => openClaim(c, m.tool_calls)}
                    />
                  )}
                  {m.content && m.cost_usd != null && (
                    <div className="text-[10.5px] text-[var(--muted-2)] pt-1 border-t border-[var(--line-2)] mt-2">
                      ${m.cost_usd.toFixed(m.cost_usd < 0.01 ? 4 : 2)} · {formatTokens(m.input_tokens)} in / {formatTokens(m.output_tokens)} out
                    </div>
                  )}
                </div>
              )}
            </MessageBubble>
          ))}

          {sending && !messages.some((m) => m.role === 'assistant' && m.status === 'running') && (
            <MessageBubble role="assistant"><ThinkingDots /></MessageBubble>
          )}

          {turnError && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3.5 py-2.5 text-[12.5px] flex items-center justify-between gap-3">
              <span>{turnError.message}</span>
              {turnError.retryable && (
                <button onClick={retry} className="font-medium underline flex-none">Reintentar</button>
              )}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-[var(--line)]">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Pregunta por qué…"
              rows={1}
              disabled={sending}
              className="flex-1 resize-none border border-[var(--line)] rounded-lg px-3 py-2 text-[13.5px] focus:outline-none focus:ring-2 focus:ring-teal-400/40 disabled:bg-[var(--line-2)] max-h-32"
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="bg-[var(--ink)] text-white rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-40 hover:bg-black transition-colors flex-none"
            >
              {sending ? '…' : 'Enviar'}
            </button>
          </div>
        </div>
      </div>

      <div className="hidden lg:block min-h-0">
        <ExhibitionPane claim={activeClaim} toolCall={activeClaimToolCall} />
      </div>
    </div>
  );
}

function formatTokens(n: number | null): string {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ThinkingDots() {
  return (
    <div className="flex gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--muted-2)] animate-bounce" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}
