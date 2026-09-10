/**
 * BUILD.md Phase 2 — ⭐ discriminate(). Ports investigate-hub.ts §5.
 * This is what stops the assistant from being a CSV sort
 * (ASSISTANT_DESIGN.md §7.4 / §2): a candidate factor is only worth
 * reporting if it explains why THIS hub differs — large-everywhere is not
 * evidence, however big the number looks.
 *
 * ⭐ DESIGN NOTE — pure and synchronous, no `sb`, no I/O.
 * ARCHITECTURE.md sketches `discriminate(metric, hub, weeks, candidates[])`;
 * "candidates" in investigate-hub.ts §5 are closures over already-fetched
 * per-hub facts, not raw column specs. Rather than have this module know how
 * to fetch every possible factor from every file (duplicating kpis.ts /
 * faltantes.ts / workforce.ts / inventory.ts), it takes PRE-COMPUTED
 * per-hub values for the metric and each candidate — gathered by the caller
 * using the other Phase 2 tools. That keeps this file a small, fully
 * testable statistical core (see scripts/test-analysis.ts), reusable for
 * ANY metric/candidate pair, not hardcoded to faltantes.
 */
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed, open } from './types';

export type Verdict = 'DISCRIMINATES' | 'CORRELATES_NOT_OUTLIER' | 'OUTLIER_NO_RELATIONSHIP' | 'NEITHER';

export interface DiscriminateCandidateInput {
  name: string;
  /** hub_id -> value. Must cover the same hub set as `metricValues` (missing/non-finite hubs are dropped from the correlation). */
  values: Record<string, number>;
  /** True if this candidate is built from a ❓ OPEN column (e.g. num_idle_days) — propagates to the result's meaning axis. */
  openMeaning?: boolean;
}

export interface DiscriminateCandidateResult {
  name: string;
  target_value: number;
  peer_mean: number;
  rank_correlation: number;
  verdict: Verdict;
  n_hubs: number;
  open_meaning: boolean;
}

export interface DiscriminateResultData {
  metric_name: string;
  target_hub: string;
  target_metric_value: number;
  peer_metric_mean: number;
  metric_gap: number;
  candidates: DiscriminateCandidateResult[];
}

/** Spearman rank correlation — small n, so ranks not raw values. Local copy (no `sb` import here — this file has zero DB dependency by design). */
function spearman(pairs: [number, number][]): number {
  const n = pairs.length;
  if (n < 4) return NaN;
  const rank = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const d2 = ra.reduce((s, v, i) => s + (v - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export function discriminate(
  metricName: string,
  metricValues: Record<string, number>,
  targetHub: string,
  candidates: DiscriminateCandidateInput[]
): AnalysisResult<DiscriminateResultData> {
  const hubs = Object.keys(metricValues).filter((h) => Number.isFinite(metricValues[h]));
  const peers = hubs.filter((h) => h !== targetHub);
  const targetMetric = metricValues[targetHub];
  const peerMetricMean = peers.reduce((s, h) => s + metricValues[h], 0) / (peers.length || 1);

  const results: DiscriminateCandidateResult[] = candidates.map((c) => {
    const tv = c.values[targetHub];
    const peerVals = peers.map((h) => c.values[h]).filter(Number.isFinite);
    const pm = peerVals.reduce((a, b) => a + b, 0) / (peerVals.length || 1);
    const pairs: [number, number][] = hubs
      .filter((h) => Number.isFinite(c.values[h]))
      .map((h) => [c.values[h], metricValues[h]] as [number, number]);
    const rho = spearman(pairs);
    const strong = Math.abs(rho) >= 0.6;
    const outlier = Number.isFinite(tv) && Number.isFinite(pm) && Math.abs(tv - pm) > Math.abs(pm) * 0.2;
    const verdict: Verdict = strong && outlier ? 'DISCRIMINATES'
      : strong ? 'CORRELATES_NOT_OUTLIER'
      : outlier ? 'OUTLIER_NO_RELATIONSHIP'
      : 'NEITHER';
    return { name: c.name, target_value: tv, peer_mean: pm, rank_correlation: rho, verdict, n_hubs: pairs.length, open_meaning: !!c.openMeaning };
  });

  const discriminating = results.filter((r) => r.verdict === 'DISCRIMINATES');

  const provenance: Provenance = {
    tool: 'discriminate',
    args: { metricName, targetHub, candidateNames: candidates.map((c) => c.name) },
    source: candidates.map((c) => ({ file: '(caller-supplied — see the tool that produced each candidate\'s values)', columns: [c.name] })),
    rows_in: hubs.length,
    rows_out: hubs.length,
    filters: [`${hubs.length} hubs with a finite ${metricName} value`],
  };

  const claims: Claim[] = discriminating.map((r, i) => ({
    id: `c${i + 1}`,
    text: `"${r.name}" discriminates for ${targetHub} (${r.target_value.toFixed(2)} vs peer mean ${r.peer_mean.toFixed(2)}, ` +
          `rank correlation ${r.rank_correlation.toFixed(2)} with ${metricName} — n=${r.n_hubs} hubs, a lead not proof)`,
    evidence: {
      kind: 'rows',
      // Self-contained: discriminate() has no DB dependency, so its own
      // input IS the evidence — embed it rather than pointing at a query.
      refetch: { tool: 'discriminate', args: { metricValues, candidateValues: candidates.find((c) => c.name === r.name)?.values ?? {}, metricName, candidateName: r.name } },
      highlight: [r.name, metricName],
    },
  }));

  const anyOpenMeaning = candidates.some((c) => c.openMeaning);

  return {
    data: {
      metric_name: metricName, target_hub: targetHub, target_metric_value: targetMetric,
      peer_metric_mean: peerMetricMean, metric_gap: targetMetric - peerMetricMean, candidates: results,
    },
    confidence: {
      coverage: hubs.length === 7
        ? confirmed('all 7 hubs have a value')
        : assumed(`only ${hubs.length}/7 hubs have a value for ${metricName}`),
      meaning: anyOpenMeaning
        ? open(`one or more candidates is built from a ❓ OPEN column: ${candidates.filter((c) => c.openMeaning).map((c) => c.name).join(', ')}`)
        : confirmed('candidate values are the caller\'s responsibility to source from CONFIRMED columns'),
      statistical: assumed('7 hubs = 7 data points. A rank correlation on n=7 is a LEAD, never proof (BUILD.md Phase 2 requirement).'),
      causal: assumed('discrimination narrows the field to what tracks the gap — it does not trace a mechanism or prove causation (ASSISTANT_DESIGN.md §3)'),
    },
    caveats: [
      '7 hubs = 7 data points. Never present a DISCRIMINATES verdict as proof — it is a lead worth investigating, nothing more.',
      ...(discriminating.length === 0 ? ['No candidate discriminated — the gap in this metric is unexplained by anything tested here.'] : []),
    ],
    provenance,
    claims,
  };
}
