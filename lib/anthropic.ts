import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Model ids verified against GET /v1/models on 2026-09-09 — do not trust an
 * alias without checking that endpoint, published model ids get retired.
 *
 * `opus` is the analysis-turn model for the future chat agent loop (BUILD.md
 * Phase 0.5.3 / Phase 3): the judgement steps (discarding non-discriminating
 * factors, emergent grouping, deciding whether a doubt is load-bearing) are
 * the product, so route those there — not to save cost on `sonnet`.
 * `sonnet` is for tool routing / lookups. `haiku` stays on the existing
 * report/insights callers below, untouched.
 */
export const MODELS = {
  haiku:  process.env.ANTHROPIC_MODEL_HAIKU  ?? 'claude-haiku-4-5-20251001',
  sonnet: process.env.ANTHROPIC_MODEL_SONNET ?? 'claude-sonnet-5',
  opus:   process.env.ANTHROPIC_MODEL_OPUS   ?? 'claude-opus-5',
} as const;

/**
 * Pricing snapshot (USD per million tokens) — adjust if/when rates change.
 *
 * NOTE: `estimateCost` is only ever called with token counts read back from
 * `resp.usage.*`, i.e. what the API actually reports — never a text-length
 * guess — so the "4.7+ tokenizer produces ~30% more tokens for the same
 * text" caveat doesn't bite here. It WOULD bite any future code that
 * estimates cost from raw text/character length before calling the API
 * (e.g. a context-budget check ahead of the Phase 3 chat loop) — don't reuse
 * an old tokens-per-character ratio for sonnet-5/opus-5 without rechecking it.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-5':           { input: 2, output: 10 },
  'claude-opus-5':             { input: 5, output: 25 },
};

/**
 * `cache` is optional and additive — existing 2-arg callers (classify-notes,
 * generate-insights, generar-reporte) are unaffected. Needed once a caller
 * uses prompt caching (BUILD.md Phase 3's /api/chat): the API's own
 * `usage.input_tokens` EXCLUDES cache reads/writes, so a plain
 * `inputTokens × price` silently undercounts total cost the moment caching
 * is active — cache writes are ~1.25× base input price (5-min ephemeral,
 * what `cache_control: {type:'ephemeral'}` defaults to), cache reads ~0.1×.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
): number {
  const p = PRICES_PER_MTOK[model] ?? { input: 3, output: 15 };
  const cacheWrite = (cache?.cacheCreationInputTokens ?? 0) * p.input * 1.25;
  const cacheRead = (cache?.cacheReadInputTokens ?? 0) * p.input * 0.1;
  return (inputTokens * p.input + outputTokens * p.output + cacheWrite + cacheRead) / 1_000_000;
}
