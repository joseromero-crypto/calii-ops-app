/**
 * Client side of a chat turn — since session 16 (HANDOFF §27) that is just
 * "start it, then watch the database".
 *
 * The agent loop used to run here: one fetch to /api/chat per hop, tools
 * executed from the browser, SSE parsed for progress. That died on Netlify's
 * hard 26 s function ceiling — a long hop was cut mid-stream and the whole
 * investigation was lost. The loop now runs in
 * netlify/functions/chat-background.mts with a 15-minute budget, persisting
 * every hop as it goes, so the browser's job is to kick it off and poll
 * `messages`/`tool_calls` (already readable under RLS — see load.ts).
 *
 * A real gain from the move: the turn is no longer tied to this tab. Close the
 * laptop mid-investigation and it keeps running; reopen the conversation and
 * ChatShell picks the poll back up.
 *
 * Note the old SSE plumbing was never actually progressive — `runTurn` did
 * `await resp.text()` and only then parsed the events, so a hop's text landed
 * in one lump regardless. Polling loses nothing.
 */

export interface StartedTurn {
  conversation_id: string;
  assistant_message_id: string;
}

/**
 * Begin a turn. Pass `userMessage` for a new one, or `assistantMessageId` to
 * resume one that died — resuming replays the tool calls already persisted for
 * that turn and re-runs none of them.
 */
export async function startTurn(opts: {
  conversationId?: string;
  userMessage?: string;
  assistantMessageId?: string;
}): Promise<StartedTurn> {
  const body = opts.userMessage
    ? { conversation_id: opts.conversationId, user_message: opts.userMessage }
    : { assistant_message_id: opts.assistantMessageId };

  const resp = await fetch('/api/chat/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json?.message ?? json?.error ?? `/api/chat/start returned ${resp.status}`);
  }
  return { conversation_id: json.conversation_id, assistant_message_id: json.assistant_message_id };
}

/** Resolve a persisted claim's evidence via /api/evidence. */
export async function resolveClaimEvidence(claimId: string): Promise<{ ok: boolean; rows?: unknown[]; rows_out?: number; message?: string }> {
  const resp = await fetch('/api/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_id: claimId }) });
  const json = await resp.json();
  return { ok: !!json.ok, rows: json.rows, rows_out: json.rows_out, message: json.message ?? json.error };
}
