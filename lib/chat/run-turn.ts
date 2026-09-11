/**
 * The agent loop, server-side (session 16, 2026-09-11 — HANDOFF §27).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The loop used to be driven by the browser (`lib/chat/client.ts`,
 * ARCHITECTURE.md §2: "the client holds the conversation and drives the
 * loop"): one HTTP request per hop into `/api/chat`, tools executed by the
 * client via `/api/tools/<name>`. That shape is fine on Vercel and fatal on
 * Netlify, where every synchronous function is killed at a hard 26 s wall
 * clock — `export const maxDuration = 120` is a Vercel convention Netlify
 * ignores. A hop whose model call ran long (measured: 26961 ms, generating ten
 * tool_use blocks at once) was cut mid-stream, and since SSE flushes headers
 * immediately the client saw `200 OK` with a truncated body and no `done`
 * event. Deep investigations could not complete in production.
 *
 * So the loop moved here, and this module is called from
 * `netlify/functions/chat-background.mts` — a background function, 15 minutes
 * instead of 26 seconds. Two things fall out of that:
 *
 *  1. **Tools are called in-process.** `TOOL_REGISTRY` was always kept in
 *     `lib/` rather than the route "so scripts/tests can dispatch the same way
 *     without going through HTTP" — that pays off here. No per-tool round
 *     trip, so the loop is also faster than the version it replaces.
 *
 *  2. **History is held in memory, not rebuilt from the DB each hop.** The old
 *     route re-derived the whole turn on every hop via `reconstructMessages`,
 *     which collapsed each hop's assistant turn to its tool_use blocks and
 *     dropped the model's own interstitial text — the model could not see what
 *     it had said one hop earlier. Running in one process, the real content
 *     blocks just stay in an array. `loadPriorMessages` below is only for the
 *     *start* of a turn (earlier conversation, or resuming a crashed turn).
 *
 * ── Runtime constraints ─────────────────────────────────────────────────────
 * Must not import anything Next-only: this is bundled into a plain Netlify
 * function where `next/headers` does not exist. The `SB` client is passed in
 * (same convention as `lib/tenure.ts`), never constructed here.
 *
 * Progress is persisted as it happens — tool_calls rows appear the moment
 * Claude asks for them, results the moment they return — because the browser's
 * only view of a running turn is polling these tables.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { anthropic, MODELS, estimateCost } from '../anthropic';
import { CHAT_SYSTEM_PROMPT } from '../prompts/chat-system-prompt';
import { TOOL_REGISTRY } from '../analysis/tool-registry';
import type { SB } from '../analysis/shared';

/**
 * Hop cap. Higher than the client loop's 20 because a hop is no longer an HTTP
 * round trip — the only thing a hop costs now is a model call, and the real
 * budget (15 min) is enforced by the platform, not by this number. This is a
 * runaway guard, not a performance knob.
 */
const MAX_HOPS = 40;

const ANTHROPIC_TOOLS: Anthropic.Tool[] = Object.entries(TOOL_REGISTRY).map(([name, def]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { $schema, ...schema } = zodToJsonSchema(def.schema as any) as any;
  return { name, description: def.description, input_schema: schema };
});

/**
 * History at the START of a turn: every completed message of the conversation,
 * plus — when resuming a turn that died partway — that turn's already-executed
 * tool calls, so the model picks up where it stopped instead of re-running
 * work that is already paid for and persisted.
 */
async function loadPriorMessages(
  sb: SB,
  conversationId: string,
  assistantMessageId: string,
): Promise<Anthropic.MessageParam[]> {
  const { data: rows, error } = await sb.from('messages')
    .select('id, role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const out: Anthropic.MessageParam[] = [];
  for (const m of rows ?? []) {
    if (m.id === assistantMessageId) continue;   // the turn being run right now
    if (!m.content) continue;                    // abandoned turn — the API rejects empty content
    out.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }

  // Resuming: replay whatever this turn already got through.
  const { data: toolCalls, error: tcErr } = await sb.from('tool_calls')
    .select('tool_use_id, tool_name, args, result, error')
    .eq('message_id', assistantMessageId)
    .order('created_at', { ascending: true });
  if (tcErr) throw tcErr;

  // Only calls that actually have a result can be replayed: the API requires
  // every tool_use in an assistant turn to be answered in the next user turn,
  // so a call left resultless by the crash must be dropped from BOTH sides
  // rather than replayed unanswered.
  const answered = (toolCalls ?? []).filter((tc) => tc.result !== null || tc.error !== null);
  if (answered.length) {
    out.push({
      role: 'assistant',
      content: answered.map((tc) => ({
        type: 'tool_use' as const, id: tc.tool_use_id, name: tc.tool_name, input: tc.args as Record<string, unknown>,
      })),
    });
    out.push({
      role: 'user',
      content: answered.map((tc) => ({
        type: 'tool_result' as const,
        tool_use_id: tc.tool_use_id,
        content: JSON.stringify(tc.error ? { error: tc.error } : tc.result),
        is_error: !!tc.error,
      })),
    });
  }
  return out;
}

/** Accumulate usage across hops rather than overwriting it. */
async function addUsage(sb: SB, messageId: string, inTok: number, outTok: number, cost: number) {
  const { data: prior } = await sb.from('messages')
    .select('input_tokens, output_tokens, cost_usd').eq('id', messageId).single();
  await sb.from('messages').update({
    input_tokens: (prior?.input_tokens ?? 0) + inTok,
    output_tokens: (prior?.output_tokens ?? 0) + outTok,
    cost_usd: Number(prior?.cost_usd ?? 0) + cost,
  }).eq('id', messageId);
}

async function fail(sb: SB, messageId: string, message: string) {
  await sb.from('messages').update({ status: 'error', error_text: message }).eq('id', messageId);
}

/**
 * Runs one full turn to completion, persisting as it goes. Never throws —
 * every exit writes a terminal `status` so the polling client stops waiting.
 */
export async function runTurnServer(sb: SB, assistantMessageId: string): Promise<void> {
  const { data: msgRow, error: msgErr } = await sb.from('messages')
    .select('id, conversation_id').eq('id', assistantMessageId).maybeSingle();
  if (msgErr || !msgRow) {
    // Nothing to update — the row this turn belongs to does not exist.
    return;
  }
  const conversationId = msgRow.conversation_id as string;

  try {
    const history = await loadPriorMessages(sb, conversationId, assistantMessageId);
    // Claim ids are unique per MESSAGE, not per tool call: every lib/analysis
    // function numbers its own claims from 'c1', so a turn with several tool
    // calls would otherwise cite several different 'c1's and the [c1] links in
    // the model's prose could not resolve to one row.
    const { count: existingClaims } = await sb.from('claims')
      .select('*', { count: 'exact', head: true }).eq('message_id', assistantMessageId);
    let claimCounter = existingClaims ?? 0;
    const textSoFar: string[] = [];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // .stream() rather than .create(): the SDK requires streaming for
      // long-running requests, and a deep hop is exactly that. Nothing is
      // streamed onward — the browser polls the DB.
      const anthropicStream = anthropic().messages.stream({
        model: MODELS.opus,
        max_tokens: 16_000,
        system: [{ type: 'text', text: CHAT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: history,
        tools: ANTHROPIC_TOOLS,
      });
      const final = await anthropicStream.finalMessage();

      const textBlocks = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
      const toolUseBlocks = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const hopText = textBlocks.map((b) => b.text).join('');

      await addUsage(sb, assistantMessageId, final.usage.input_tokens, final.usage.output_tokens,
        estimateCost(MODELS.opus, final.usage.input_tokens, final.usage.output_tokens, {
          cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
        }));

      // Opus's adaptive extended thinking can trigger on its own and eat the
      // whole max_tokens budget mid-thought, leaving neither text nor tool
      // calls (GATE test, 2026-09-10 — real tokens spent, nothing usable).
      // Must not be persisted as a valid finish.
      if (final.stop_reason === 'max_tokens' && !toolUseBlocks.length && !hopText) {
        await fail(sb, assistantMessageId,
          'El modelo agotó max_tokens antes de producir texto o llamadas a herramientas (probablemente a mitad de razonamiento). Reintenta — no se perdió ningún resultado.');
        return;
      }

      if (hopText) textSoFar.push(hopText);

      // ── Terminal hop ──────────────────────────────────────────────────────
      if (!toolUseBlocks.length) {
        await sb.from('messages').update({
          content: textSoFar.join('\n\n'),
          status: 'done',
          run_token: null,
        }).eq('id', assistantMessageId);
        return;
      }

      // ── Tool hop ──────────────────────────────────────────────────────────
      // Persisted before execution so the polling UI shows the chips
      // immediately, and so a crash mid-tool leaves a record of what was asked.
      const { error: insErr } = await sb.from('tool_calls').insert(
        toolUseBlocks.map((b) => ({
          message_id: assistantMessageId, tool_use_id: b.id, tool_name: b.name,
          args: b.input as Record<string, unknown>,
        }))
      );
      if (insErr) throw insErr;

      // Interstitial prose is saved as it happens too — the old client loop
      // showed it live and then dropped it, so reopening a conversation lost
      // every word the model wrote before its final hop.
      if (textSoFar.length) {
        await sb.from('messages').update({ content: textSoFar.join('\n\n') }).eq('id', assistantMessageId);
      }

      history.push({ role: 'assistant', content: final.content });

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const b of toolUseBlocks) {
        const started = Date.now();
        let ok = true;
        let payload: unknown;

        const tool = TOOL_REGISTRY[b.name];
        if (!tool) {
          ok = false;
          payload = { error: `unknown_tool: ${b.name}` };
        } else {
          const parsed = tool.schema.safeParse(b.input);
          if (!parsed.success) {
            ok = false;
            payload = { error: 'bad_args', issues: parsed.error.issues };
          } else {
            try {
              payload = await tool.handler(sb, parsed.data);
            } catch (e: unknown) {
              ok = false;
              payload = { error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
        const durationMs = Date.now() - started;

        // Renumber this result's claims before it is shown to the model, or
        // the citations it writes will not match the persisted claim_ref.
        if (ok && payload && typeof payload === 'object'
            && Array.isArray((payload as { claims?: unknown[] }).claims)
            && (payload as { claims: unknown[] }).claims.length) {
          const p = payload as { claims: { id: string }[] };
          payload = { ...p, claims: p.claims.map((c) => ({ ...c, id: `c${++claimCounter}` })) };
        }

        const { data: updated, error: updErr } = await sb.from('tool_calls').update({
          result: ok ? (payload as Record<string, unknown>) : null,
          error: ok ? null : JSON.stringify(payload),
          duration_ms: durationMs,
          provenance: ok && payload && typeof payload === 'object' && 'provenance' in payload
            ? (payload as { provenance: unknown }).provenance : null,
        }).eq('message_id', assistantMessageId).eq('tool_use_id', b.id)
          .select('id, result').maybeSingle();
        if (updErr) throw updErr;

        const claims = ok && updated?.result && typeof updated.result === 'object'
          && Array.isArray((updated.result as { claims?: unknown[] }).claims)
          ? (updated.result as { claims: { id: string; text: string; evidence: unknown }[] }).claims : [];
        if (claims.length && updated) {
          await sb.from('claims').upsert(
            claims.map((c) => ({
              message_id: assistantMessageId, tool_call_id: updated.id,
              claim_ref: c.id, text: c.text, evidence: c.evidence,
            })),
            { onConflict: 'tool_call_id,claim_ref' }
          );
        }

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: b.id,
          content: JSON.stringify(payload),
          is_error: !ok,
        });
      }

      history.push({ role: 'user', content: toolResultBlocks });
    }

    await fail(sb, assistantMessageId,
      `El turno superó ${MAX_HOPS} pasos sin terminar — detenido para evitar un bucle. Los resultados obtenidos siguen guardados.`);
  } catch (e: unknown) {
    await fail(sb, assistantMessageId, e instanceof Error ? e.message : String(e));
  }
}
