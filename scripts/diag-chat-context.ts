/**
 * Read-only: how big does a chat turn's replayed context get, hop by hop?
 * (session 16, 2026-09-11 — HANDOFF §27)
 *
 *   npx tsx scripts/diag-chat-context.ts            # heaviest recent turn
 *   npx tsx scripts/diag-chat-context.ts <msg_uuid> # a specific assistant message
 *
 * Why: /api/chat is killed at Netlify's hard 26s function ceiling. Every hop
 * replays the ENTIRE turn (reconstructMessages), so input grows with each tool
 * call and later hops get slower until one crosses 26s. This prints where the
 * bytes are and what three trimming strategies would do to them, so the
 * trimming policy is chosen from numbers rather than guessed.
 *
 * Token estimates are bytes/4 — rough, but the RATIO between strategies is
 * what the decision needs, and that ratio is unaffected by the constant.
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const B_PER_TOK = 4;
const tok = (b: number) => Math.round(b / B_PER_TOK);
const kb = (b: number) => `${(b / 1024).toFixed(0)} KB`;

/** What the trimmed history would cost if only the last N results stay verbatim. */
const SUMMARY_BYTES = 220; // "tool X returned N rows about Y" placeholder

async function main() {
  let messageId = process.argv[2];

  if (!messageId) {
    const { data: recent } = await sb.from('tool_calls')
      .select('message_id, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    const counts = new Map<string, number>();
    for (const r of recent ?? []) counts.set(r.message_id, (counts.get(r.message_id) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) { console.log('No tool_calls found.'); return; }
    messageId = top[0];
    console.log(`Heaviest recent turn: assistant_message_id=${messageId} (${top[1]} tool calls)\n`);
  }

  const { data: msg } = await sb.from('messages')
    .select('id, conversation_id, role, content, input_tokens, output_tokens, cost_usd, created_at')
    .eq('id', messageId).single();
  if (!msg) { console.log('message not found'); return; }

  // Everything reconstructMessages() replays that ISN'T this turn's tool calls.
  const { data: priorMsgs } = await sb.from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', msg.conversation_id)
    .order('created_at', { ascending: true });
  const priorBytes = (priorMsgs ?? [])
    .filter((m) => m.created_at < msg.created_at && m.content)
    .reduce((a, m) => a + Buffer.byteLength(JSON.stringify(m.content)), 0);

  const { data: calls } = await sb.from('tool_calls')
    .select('tool_name, args, result, error, duration_ms, created_at')
    .eq('message_id', messageId)
    .order('created_at', { ascending: true });

  if (!calls?.length) { console.log('no tool calls on this message'); return; }

  console.log(`conversation=${msg.conversation_id}`);
  console.log(`persisted usage for this turn: input=${msg.input_tokens} output=${msg.output_tokens} cost=$${Number(msg.cost_usd ?? 0).toFixed(3)}`);
  console.log(`prior conversation messages replayed every hop: ${kb(priorBytes)} (~${tok(priorBytes)} tok)\n`);

  const sizes = calls.map((c) => ({
    tool: c.tool_name,
    args: Buffer.byteLength(JSON.stringify(c.args ?? {})),
    result: Buffer.byteLength(JSON.stringify(c.error ? { error: c.error } : c.result ?? null)),
    ms: c.duration_ms ?? 0,
  }));

  console.log('PER TOOL CALL');
  console.log('hop  tool                      result      ~tok   tool ms');
  sizes.forEach((s, i) => {
    console.log(
      `${String(i + 1).padStart(3)}  ${s.tool.padEnd(24)} ${kb(s.result).padStart(8)} ${String(tok(s.result)).padStart(7)} ${String(s.ms).padStart(9)}`
    );
  });

  const totalResult = sizes.reduce((a, s) => a + s.result, 0);
  const totalArgs = sizes.reduce((a, s) => a + s.args, 0);
  console.log(`\ntotal tool results: ${kb(totalResult)} (~${tok(totalResult)} tok) across ${sizes.length} calls`);

  // Biggest offenders, aggregated by tool.
  const byTool = new Map<string, { n: number; bytes: number }>();
  for (const s of sizes) {
    const e = byTool.get(s.tool) ?? { n: 0, bytes: 0 };
    e.n++; e.bytes += s.result; byTool.set(s.tool, e);
  }
  console.log('\nBY TOOL (heaviest first)');
  [...byTool.entries()].sort((a, b) => b[1].bytes - a[1].bytes).forEach(([t, e]) =>
    console.log(`  ${t.padEnd(24)} ${String(e.n).padStart(2)}x  ${kb(e.bytes).padStart(8)}  ~${tok(e.bytes)} tok`)
  );

  // ── What each hop actually sent, and what it would send when trimmed ──────
  const strategies: { label: string; keepLast: number | null; cap: number | null }[] = [
    { label: 'today (no trim)',        keepLast: null, cap: null },
    { label: 'keep last 4 verbatim',   keepLast: 4,    cap: null },
    { label: 'keep last 6 verbatim',   keepLast: 6,    cap: null },
    { label: 'cap each result @ 8 KB', keepLast: null, cap: 8 * 1024 },
  ];

  const inputAtHop = (hop: number, keepLast: number | null, cap: number | null) => {
    // hop is 1-indexed: the request that follows the hop-th tool call
    let bytes = priorBytes + totalArgs;
    for (let i = 0; i < hop; i++) {
      const isRecent = keepLast === null || i >= hop - keepLast;
      let r = sizes[i].result;
      if (!isRecent) r = SUMMARY_BYTES;
      else if (cap !== null) r = Math.min(r, cap);
      bytes += r;
    }
    return bytes;
  };

  console.log('\nREPLAYED INPUT PER HOP (~tokens, tool results + history; excludes system prompt & tool schemas)');
  const header = ['hop', ...strategies.map((s) => s.label)];
  console.log(header[0].padStart(3) + strategies.map((s) => s.label.padStart(24)).join(''));
  for (let h = 1; h <= sizes.length; h++) {
    const row = strategies.map((s) => String(tok(inputAtHop(h, s.keepLast, s.cap))).padStart(24));
    console.log(String(h).padStart(3) + row.join(''));
  }

  const last = sizes.length;
  console.log('\nAT THE FINAL HOP (the one that got killed at 26s):');
  for (const s of strategies) {
    const t = tok(inputAtHop(last, s.keepLast, s.cap));
    const base = tok(inputAtHop(last, null, null));
    console.log(`  ${s.label.padEnd(24)} ~${String(t).padStart(7)} tok   ${s.keepLast === null && s.cap === null ? '' : `(${(base / Math.max(t, 1)).toFixed(1)}x less)`}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
