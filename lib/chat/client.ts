/**
 * BUILD.md Phase 4 — the client-side agent loop. ARCHITECTURE.md §2: "The
 * client holds the conversation and drives the loop." Extracted from React
 * so the loop itself has no UI dependency — a component just supplies
 * callbacks and renders what it's told.
 */

export interface SSEEvent<T = any> { event: string; data: T; }

async function parseSSE(text: string): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for (const block of text.split('\n\n')) {
    const evMatch = block.match(/^event: (.+)$/m);
    const dataMatch = block.match(/^data: (.+)$/m);
    if (evMatch && dataMatch) {
      try { events.push({ event: evMatch[1], data: JSON.parse(dataMatch[1]) }); } catch { /* skip malformed */ }
    }
  }
  return events;
}

export interface ChatDoneData {
  stop_reason: string;
  conversation_id: string;
  assistant_message_id: string;
  tool_uses?: { tool_use_id: string; tool_name: string; args: Record<string, unknown> }[];
  text?: string;
}

export interface RunTurnCallbacks {
  /** conversation_id becomes known as soon as the first hop responds (new conversations don't have one yet). */
  onConversationId?: (id: string) => void;
  onAssistantMessageId?: (id: string) => void;
  onTextDelta?: (delta: string) => void;
  /**
   * Fires once per hop, right after its text finishes streaming — whether or
   * not that hop went on to request tools. A hop that calls tools can still
   * produce real interstitial text first (observed in testing: "I'll start
   * by getting the lay of the land, then decompose.") — without this, that
   * text only ever reaches onTextDelta and is lost the moment the caller
   * clears its live buffer to start the next hop's streaming.
   * `isFinal` is true only for the hop that ends the turn (no more tools).
   */
  onHopComplete?: (text: string, isFinal: boolean) => void;
  onToolStart?: (toolUseId: string, toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolUseId: string, ok: boolean, result: unknown) => void;
  onDone?: (final: { stop_reason: string; text: string }) => void;
  onError?: (message: string, retryable?: boolean, assistantMessageId?: string) => void;
}

const MAX_HOPS = 20;

/** Runs one full turn — possibly many hops — to completion. Never throws; reports via callbacks. */
export async function runTurn(
  opts: { conversationId?: string; userMessage?: string; assistantMessageId?: string; toolResults?: { tool_use_id: string; content: unknown; is_error?: boolean; duration_ms?: number }[] },
  cb: RunTurnCallbacks
): Promise<void> {
  async function callChat(body: Record<string, unknown>): Promise<{ ok: boolean; events?: SSEEvent[]; status: number; raw?: string }> {
    const resp = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, status: resp.status, raw: text };
    return { ok: true, status: resp.status, events: await parseSSE(text) };
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; message?: string; duration_ms: number }> {
    const start = Date.now();
    try {
      const resp = await fetch(`/api/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const json = await resp.json();
      return { ok: !!json.ok, result: json.result, message: json.message ?? json.error, duration_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e), duration_ms: Date.now() - start };
    }
  }

  let body: Record<string, unknown> = opts.userMessage
    ? { conversation_id: opts.conversationId, user_message: opts.userMessage }
    : { assistant_message_id: opts.assistantMessageId, tool_results: opts.toolResults };

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const resp = await callChat(body);
    if (!resp.ok) {
      cb.onError?.(`/api/chat returned ${resp.status}: ${resp.raw?.slice(0, 300) ?? ''}`);
      return;
    }
    const events = resp.events ?? [];
    let hopText = '';
    for (const e of events) {
      if (e.event === 'text_delta') { hopText += e.data.text; cb.onTextDelta?.(e.data.text); }
    }
    const errorEvent = events.find((e) => e.event === 'error');
    if (errorEvent) {
      cb.onError?.(errorEvent.data.message, errorEvent.data.retryable, errorEvent.data.assistant_message_id);
      return;
    }
    const doneEvent = events.find((e) => e.event === 'done');
    if (!doneEvent) {
      cb.onError?.('No done event in response — the stream ended unexpectedly.');
      return;
    }
    const data: ChatDoneData = doneEvent.data;
    cb.onConversationId?.(data.conversation_id);
    cb.onAssistantMessageId?.(data.assistant_message_id);

    const isFinal = data.stop_reason !== 'tool_use';
    cb.onHopComplete?.(isFinal ? (data.text ?? hopText) : hopText, isFinal);

    if (isFinal) {
      cb.onDone?.({ stop_reason: data.stop_reason, text: data.text ?? hopText });
      return;
    }

    const toolResults: { tool_use_id: string; content: unknown; is_error?: boolean; duration_ms?: number }[] = [];
    for (const tu of data.tool_uses ?? []) {
      cb.onToolStart?.(tu.tool_use_id, tu.tool_name, tu.args);
      const toolResp = await callTool(tu.tool_name, tu.args);
      cb.onToolResult?.(tu.tool_use_id, toolResp.ok, toolResp.ok ? toolResp.result : toolResp.message);
      toolResults.push({
        tool_use_id: tu.tool_use_id,
        content: toolResp.ok ? toolResp.result : { error: toolResp.message },
        is_error: !toolResp.ok,
        duration_ms: toolResp.duration_ms,
      });
    }
    body = { assistant_message_id: data.assistant_message_id, tool_results: toolResults };
  }
  cb.onError?.(`Turn exceeded ${MAX_HOPS} hops without finishing — stopped to avoid a runaway loop.`);
}

/** Resolve a persisted claim's evidence via /api/evidence. */
export async function resolveClaimEvidence(claimId: string): Promise<{ ok: boolean; rows?: unknown[]; rows_out?: number; message?: string }> {
  const resp = await fetch('/api/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_id: claimId }) });
  const json = await resp.json();
  return { ok: !!json.ok, rows: json.rows, rows_out: json.rows_out, message: json.message ?? json.error };
}
