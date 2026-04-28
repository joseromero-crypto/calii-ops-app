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

export const MODELS = {
  haiku: process.env.ANTHROPIC_MODEL_HAIKU ?? 'claude-haiku-4-5-20251001',
  sonnet: process.env.ANTHROPIC_MODEL_SONNET ?? 'claude-sonnet-4-6',
} as const;

/** Pricing snapshot (USD per million tokens) — adjust if/when rates change. */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-4-6':         { input: 3, output: 15 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES_PER_MTOK[model] ?? { input: 3, output: 15 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
