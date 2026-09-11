/**
 * ⚠️ SUPERSEDED, session 16 (2026-09-11) — kept for reference, no longer called.
 *
 * This route cannot work reliably in production: Netlify kills any synchronous
 * function at a hard 26 s wall clock (`maxDuration` below is a Vercel
 * convention it ignores), and a deep hop's model call runs longer than that —
 * measured at 26961 ms, cut mid-SSE-stream, whole turn lost. See HANDOFF §27.
 *
 * The live path is now:
 *   app/api/chat/start/route.ts        → auth + create rows + kick off
 *   netlify/functions/chat-background  → the loop, 15 min budget
 *   lib/chat/run-turn.ts               → the loop itself
 *   lib/chat/client.ts + ChatShell     → start, then poll the DB
 *
 * Do not wire anything new to this file. Delete it once the background path
 * has a few weeks of real use behind it.
 *
 * ── original header ─────────────────────────────────────────────────────────
 * BUILD.md Phase 3 — /api/chat: ONE model turn per request. The CLIENT
 * drives the loop (ARCHITECTURE.md §2) — this route never calls itself or
 * loops internally. A "turn" here means: reconstruct history from the DB,
 * call Claude once, stream the response, persist what happened. If Claude
 * asks for tool(s), the client executes them via /api/tools/<name> and
 * calls this route again with the results to continue the SAME turn
 * (assistant_message_id carries that continuity — see the persistence
 * comment in the migration for why tool_use/tool_result hops aren't their
 * own message rows).
 *
 * Streams via SSE so a curl -N shows real token-by-token output, per
 * ARCHITECTURE.md §2's "stream the responses so José watches it work".
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createServerClient, createAdminSupabase } from '@/lib/supabase-server';
import { anthropic, MODELS, estimateCost } from '@/lib/anthropic';
import { CHAT_SYSTEM_PROMPT } from '@/lib/prompts/chat-system-prompt';
import { TOOL_REGISTRY } from '@/lib/analysis/tool-registry';
import type Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type SB = ReturnType<typeof createAdminSupabase>;

const Body = z.object({
  conversation_id: z.string().uuid().optional(),
  mode: z.enum(['analysis', 'routing']).optional(),
  user_message: z.string().min(1).optional(),
  assistant_message_id: z.string().uuid().optional(),
  tool_results: z.array(z.object({
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
    duration_ms: z.number().optional(),
  })).optional(),
}).refine(
  (b) => (!!b.user_message) !== (!!b.assistant_message_id && !!b.tool_results),
  { message: 'Provide exactly one of user_message (new turn) or assistant_message_id + tool_results (continue a turn)' }
);

const ANTHROPIC_TOOLS: Anthropic.Tool[] = Object.entries(TOOL_REGISTRY).map(([name, def]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { $schema, ...schema } = zodToJsonSchema(def.schema as any) as any;
  return { name, description: def.description, input_schema: schema };
});

async function getOrCreateConversation(sb: SB, conversationId: string | undefined, firstUserMessage: string | undefined): Promise<string> {
  if (conversationId) {
    await sb.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    return conversationId;
  }
  const { data, error } = await sb.from('conversations')
    .insert({ title: firstUserMessage ? firstUserMessage.slice(0, 80) : null })
    .select('id').single();
  if (error) throw error;
  return data.id;
}

/** Reconstructs the Anthropic-shaped message array from persisted state. */
async function reconstructMessages(sb: SB, conversationId: string, inProgressAssistantMessageId: string | undefined): Promise<Anthropic.MessageParam[]> {
  const { data: rows, error } = await sb.from('messages')
    .select('id, role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const out: Anthropic.MessageParam[] = [];
  for (const m of rows ?? []) {
    if (m.id === inProgressAssistantMessageId) continue; // handled specially below
    // A completed row with empty content means an earlier turn was
    // abandoned (e.g. the max_tokens-mid-thinking case below) without ever
    // finishing — the Anthropic API rejects empty content blocks, and an
    // empty assistant turn has nothing worth replaying anyway.
    if (!m.content) continue;
    out.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }

  if (inProgressAssistantMessageId) {
    const { data: toolCalls, error: tcErr } = await sb.from('tool_calls')
      .select('tool_use_id, tool_name, args, result, error')
      .eq('message_id', inProgressAssistantMessageId)
      .order('created_at', { ascending: true });
    if (tcErr) throw tcErr;

    const assistantContent: Anthropic.ContentBlockParam[] = (toolCalls ?? []).map((tc) => ({
      type: 'tool_use' as const, id: tc.tool_use_id, name: tc.tool_name, input: tc.args as Record<string, unknown>,
    }));
    if (assistantContent.length) out.push({ role: 'assistant', content: assistantContent });

    const withResults = (toolCalls ?? []).filter((tc) => tc.result !== null || tc.error !== null);
    if (withResults.length) {
      out.push({
        role: 'user',
        content: withResults.map((tc) => ({
          type: 'tool_result' as const,
          tool_use_id: tc.tool_use_id,
          content: JSON.stringify(tc.error ? { error: tc.error } : tc.result),
          is_error: !!tc.error,
        })),
      });
    }
  }
  return out;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ⚠️ TRIED AND REVERTED, 2026-09-10 — caching the growing tool-result
// history (not just the system prompt below). Mechanically it worked
// exactly as designed (verified via usage.cache_read_input_tokens actually
// growing hop over hop, e.g. 5486 → 5588 matching the prior hop's write of
// 102 tokens) — but the ECONOMICS don't favour it for a deep, many-hop
// investigation. Re-ran the same Contry investigation that cost $1.08
// uncached: with history caching it cost $1.25 — MORE, not less. Root
// cause: most tool results in a deep turn are large and get read back only
// once or twice before the turn ends, so the 1.25× cache-write premium on
// that (large, mostly-unreused) volume outweighs the 0.1× read discount on
// the smaller portion that genuinely gets reused. A SHORT 2-hop exchange
// looked great ($0.0625) but that was never isolated from the system-prompt
// caching below, which was already in place and is the dominant cost driver
// for a short exchange anyway. Reverted rather than ship a change that can
// make the app's actual primary use case (deep investigation,
// ASSISTANT_DESIGN.md §2) more expensive. If this gets revisited, the more
// promising levers are trimming/summarizing OLD tool results out of the
// resent history (shrinks the real token volume, helps cached or not) or
// routing mechanical hops to Sonnet — not caching alone.

export async function POST(req: Request) {
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request', issues: parsed.error.issues }, { status: 400 });
  }
  const { mode, user_message, assistant_message_id, tool_results } = parsed.data;
  const model = mode === 'routing' ? MODELS.sonnet : MODELS.opus; // default to opus when ambiguous — BUILD.md Phase 3

  const admin = createAdminSupabase();

  let conversationId: string;
  let assistantMessageId: string;

  if (user_message) {
    conversationId = await getOrCreateConversation(admin, parsed.data.conversation_id, user_message);
    await admin.from('messages').insert({ conversation_id: conversationId, role: 'user', content: user_message });
    const { data: newMsg, error } = await admin.from('messages')
      .insert({ conversation_id: conversationId, role: 'assistant', content: '' })
      .select('id').single();
    if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
    assistantMessageId = newMsg.id;
  } else {
    // Continuing an in-progress turn — derive conversation_id from the
    // existing assistant message row rather than trusting/requiring the
    // client to resend it. (Bug found in the GATE test: calling
    // getOrCreateConversation unconditionally here created a second,
    // orphaned conversation on every continuation hop, since
    // conversation_id/user_message are both absent on this branch.)
    assistantMessageId = assistant_message_id!;
    const { data: msgRow, error: msgErr } = await admin.from('messages').select('conversation_id').eq('id', assistantMessageId).maybeSingle();
    if (msgErr) return NextResponse.json({ error: 'db_error', message: msgErr.message }, { status: 500 });
    if (!msgRow) return NextResponse.json({ error: 'assistant_message_not_found', assistant_message_id: assistantMessageId }, { status: 404 });
    conversationId = msgRow.conversation_id;
    await admin.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
    // Persist tool results BEFORE calling the model again — "persist as you
    // go" (BUILD.md Phase 3): this survives even if the client never comes
    // back to finish the turn. Also extract claims from each result now.
    //
    // Renumber claim ids to be unique PER MESSAGE (not per tool call) before
    // either storing them or sending them back to the model. Every
    // lib/analysis/* function numbers its own claims starting at 'c1' —
    // fine in isolation, but a turn with 5+ tool calls means 5+ different
    // claims all named 'c1'. Phase 4's clickable-claim citations ([c1] in
    // the model's prose) would be ambiguous without this — the model
    // improvised tool-name hints in testing ("[c1, `kpiByHub` ...]") to
    // work around exactly this, which isn't reliably parseable for a click
    // target. Renumbering must happen before the tool_result is ever shown
    // to the model, or its citations won't match the persisted claim_ref.
    const { count: existingClaims } = await admin.from('claims').select('*', { count: 'exact', head: true }).eq('message_id', assistantMessageId);
    let claimCounter = existingClaims ?? 0;

    for (const tr of tool_results!) {
      const isError = !!tr.is_error;
      let content = tr.content;
      if (!isError && content && typeof content === 'object' && Array.isArray((content as any).claims) && (content as any).claims.length) {
        content = {
          ...(content as object),
          claims: (content as any).claims.map((c: any) => ({ ...c, id: `c${++claimCounter}` })),
        };
      }

      const { data: updated, error } = await admin.from('tool_calls')
        .update({
          result: isError ? null : (content as any),
          error: isError ? JSON.stringify(content) : null,
          duration_ms: tr.duration_ms ?? null,
          provenance: !isError && content && typeof content === 'object' && 'provenance' in (content as object)
            ? (content as any).provenance : null,
        })
        .eq('message_id', assistantMessageId).eq('tool_use_id', tr.tool_use_id)
        .select('id, result').maybeSingle();
      if (error) return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
      const claims = !isError && updated?.result && typeof updated.result === 'object' && Array.isArray((updated.result as any).claims)
        ? (updated.result as any).claims : [];
      if (claims.length && updated) {
        await admin.from('claims').upsert(
          claims.map((c: any) => ({
            message_id: assistantMessageId, tool_call_id: updated.id, claim_ref: c.id, text: c.text, evidence: c.evidence,
          })),
          { onConflict: 'tool_call_id,claim_ref' }
        );
      }
    }
  }

  const messages = await reconstructMessages(admin, conversationId, assistantMessageId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (s: string) => { try { controller.enqueue(encoder.encode(s)); } catch { /* closed */ } };
      const keepalive = setInterval(() => enqueue(':\n\n'), 10_000); // SSE comment as Netlify keepalive, same pattern as /api/recompute

      // Emitted BEFORE the model call so the client learns the ids even if this
      // hop never finishes (session 16 — HANDOFF §27). Netlify kills the
      // function at a hard 26 s wall clock regardless of `maxDuration`, which
      // truncates the SSE body mid-stream: status 200, no `done` event. Without
      // this, a first hop cut that way leaves the client with no
      // assistant_message_id, so a turn whose tool results are all safely
      // persisted still can't be resumed and the whole investigation is lost.
      enqueue(sseEvent('start', { conversation_id: conversationId, assistant_message_id: assistantMessageId }));

      try {
        const anthropicStream = anthropic().messages.stream({
          model,
          // 4096 was too small (GATE test, 2026-09-10): Opus's adaptive
          // extended thinking can trigger on its own for a judgment-heavy
          // hop, and thinking tokens count against max_tokens — a hop hit
          // the cap mid-thought with zero visible output, $0.46 spent on
          // nothing. 16000 leaves real room for both.
          max_tokens: 16_000,
          system: [{ type: 'text', text: CHAT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages,
          tools: ANTHROPIC_TOOLS,
        });

        anthropicStream.on('text', (delta) => enqueue(sseEvent('text_delta', { text: delta })));

        const final = await anthropicStream.finalMessage();
        clearInterval(keepalive);

        const textBlocks = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
        const toolUseBlocks = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const fullText = textBlocks.map((b) => b.text).join('');
        const cost = estimateCost(model, final.usage.input_tokens, final.usage.output_tokens, {
          cacheCreationInputTokens: final.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: final.usage.cache_read_input_tokens ?? 0,
        });

        // Opus has adaptive extended thinking that can trigger automatically
        // (GATE test, 2026-09-10): a hop hit max_tokens mid-thinking, zero
        // tool_use blocks AND zero text blocks — real tokens spent, no
        // usable output. Must not be silently persisted as a valid "done".
        if (final.stop_reason === 'max_tokens' && !toolUseBlocks.length && !fullText) {
          const { data: prior } = await admin.from('messages').select('input_tokens, output_tokens, cost_usd').eq('id', assistantMessageId).single();
          await admin.from('messages').update({
            input_tokens: (prior?.input_tokens ?? 0) + final.usage.input_tokens,
            output_tokens: (prior?.output_tokens ?? 0) + final.usage.output_tokens,
            cost_usd: Number(prior?.cost_usd ?? 0) + cost,
          }).eq('id', assistantMessageId);
          enqueue(sseEvent('error', {
            message: 'Model hit max_tokens before producing tool calls or visible text (likely mid extended-thinking). Retry this turn — assistant_message_id is unchanged, no tool_results needed.',
            assistant_message_id: assistantMessageId, conversation_id: conversationId, retryable: true,
          }));
          return; // finally{} below still runs and closes the controller exactly once
        }

        if (toolUseBlocks.length) {
          const { error: insErr } = await admin.from('tool_calls').insert(
            toolUseBlocks.map((b) => ({ message_id: assistantMessageId, tool_use_id: b.id, tool_name: b.name, args: b.input as Record<string, unknown> }))
          );
          if (insErr) throw insErr;
          // Accumulate token usage across hops of the same turn rather than overwrite.
          const { data: prior } = await admin.from('messages').select('input_tokens, output_tokens, cost_usd').eq('id', assistantMessageId).single();
          await admin.from('messages').update({
            input_tokens: (prior?.input_tokens ?? 0) + final.usage.input_tokens,
            output_tokens: (prior?.output_tokens ?? 0) + final.usage.output_tokens,
            cost_usd: Number(prior?.cost_usd ?? 0) + cost,
          }).eq('id', assistantMessageId);

          enqueue(sseEvent('done', {
            stop_reason: final.stop_reason, conversation_id: conversationId, assistant_message_id: assistantMessageId,
            tool_uses: toolUseBlocks.map((b) => ({ tool_use_id: b.id, tool_name: b.name, args: b.input })),
          }));
        } else {
          const { data: prior } = await admin.from('messages').select('input_tokens, output_tokens, cost_usd').eq('id', assistantMessageId).single();
          await admin.from('messages').update({
            content: fullText,
            input_tokens: (prior?.input_tokens ?? 0) + final.usage.input_tokens,
            output_tokens: (prior?.output_tokens ?? 0) + final.usage.output_tokens,
            cost_usd: Number(prior?.cost_usd ?? 0) + cost,
          }).eq('id', assistantMessageId);

          enqueue(sseEvent('done', {
            stop_reason: final.stop_reason, conversation_id: conversationId, assistant_message_id: assistantMessageId, text: fullText,
          }));
        }
      } catch (e: any) {
        clearInterval(keepalive);
        enqueue(sseEvent('error', { message: e?.message ?? String(e) }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
