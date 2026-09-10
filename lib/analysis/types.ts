/**
 * BUILD.md Phase 2 — the shared return shape every analysis function in this
 * directory obeys. Matches ARCHITECTURE.md §4 exactly:
 *
 *   { data, confidence, caveats, provenance, claims }
 *
 * `confidence` follows ASSISTANT_DESIGN.md §3's four-axis rule (never
 * averaged — the output names the weakest axis) using the same status
 * vocabulary DATA_DICTIONARY.md already trained everyone on:
 * CONFIRMED / CORRECTED / ASSUMED / OPEN.
 *
 * `provenance` + `claims` are ASSISTANT_DESIGN.md §4b's layer 2 — generated
 * in code, in the same pass as the number, never narrated by a model
 * afterwards. `claims[].evidence.refetch` is resolved by `resolveEvidence()`
 * in `./evidence.ts`, which every module's row-fetcher registers into.
 */

export type ConfidenceRating = 'CONFIRMED' | 'CORRECTED' | 'ASSUMED' | 'OPEN';

export interface ConfidenceAxis {
  rating: ConfidenceRating;
  note: string;
}

/** ASSISTANT_DESIGN.md §3 — four independent axes, never averaged. */
export interface Confidence {
  coverage: ConfidenceAxis;
  meaning: ConfidenceAxis;
  statistical: ConfidenceAxis;
  causal: ConfidenceAxis;
}

export interface ProvenanceSource {
  file: string;
  columns: string[];
}

export interface Provenance {
  tool: string;
  args: Record<string, unknown>;
  source: ProvenanceSource[];
  rows_in: number;
  rows_out: number;
  filters: string[];
}

/**
 * What a claim's evidence re-fetches. `tool` names the analysis function
 * whose row-fetcher produced the underlying rows; `args` are that fetcher's
 * own arguments; `predicate` narrows to exactly the rows behind this claim
 * (each fetcher documents which predicate keys it understands — see
 * `evidence.ts`). Resolved by `resolveEvidence()`, never re-derives numbers.
 */
export interface EvidenceRefetch {
  tool: string;
  args: Record<string, unknown>;
  predicate?: Record<string, unknown>;
}

export interface ClaimEvidence {
  kind: 'rows' | 'chart';
  refetch: EvidenceRefetch;
  /** Column(s) that drove the classification — highlighted in the UI table. */
  highlight: string[];
}

export interface Claim {
  id: string;
  text: string;
  evidence: ClaimEvidence;
}

export interface AnalysisResult<T> {
  data: T;
  confidence: Confidence;
  /** Layer 2 (ASSISTANT_DESIGN.md §4b) — attached here, not fetched by the model. */
  caveats: string[];
  provenance: Provenance;
  claims: Claim[];
}

// ── Shared confidence-axis constructors ────────────────────────────────────
// Small helpers so every module states its axes the same way rather than
// hand-rolling the object shape each time.

export const confirmed = (note: string): ConfidenceAxis => ({ rating: 'CONFIRMED', note });
export const corrected = (note: string): ConfidenceAxis => ({ rating: 'CORRECTED', note });
export const assumed = (note: string): ConfidenceAxis => ({ rating: 'ASSUMED', note });
export const open = (note: string): ConfidenceAxis => ({ rating: 'OPEN', note });

/**
 * `num_idle_days` is DATA_DICTIONARY.md's canonical ❓ OPEN column — any
 * function that touches it must return `meaning: OPEN` (BUILD.md Phase 2
 * test list). Centralised so every module cites it identically.
 */
export const NUM_IDLE_DAYS_OPEN_NOTE =
  'num_idle_days is ❓ OPEN in DATA_DICTIONARY.md — no derivation cleared 98% ' +
  '(scripts/reverse-engineer.ts), meaning is genuinely unknown.';
