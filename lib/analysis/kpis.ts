/**
 * BUILD.md Phase 2 — kpiTrend / kpiByHub / peerRanking.
 * Aggregate reads over kpi_snapshots (36k rows) and peer_comparisons (195k,
 * always filtered by kpi/week) — both are pre-computed, so these are small,
 * fast, filtered-in-the-query reads. No JS-side full scan.
 */
import type { SB } from './shared';
import { ACTIVE_HUBS, comparabilityCaveats } from './shared';
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed } from './types';

export interface KpiTrendPoint {
  week_start: string;
  value: number | null;
  prev_week_value: number | null;
  rolling_mean_4w: number | null;
}

export interface KpiTrendData {
  kpi_id: string;
  scope_level: string;
  scope_key: string | null;
  points: KpiTrendPoint[];
}

/** The hub (or any scope) against its own history — ASSISTANT_DESIGN.md's primary signal. */
export async function kpiTrend(
  sb: SB,
  kpiId: string,
  scopeLevel: 'global' | 'city' | 'hub' | 'operator' | 'driver' | 'sku',
  scopeKey: string | null,
  weeksBack = 12
): Promise<AnalysisResult<KpiTrendData>> {
  let q = sb.from('kpi_snapshots').select('week_start, value, prev_week_value, rolling_mean_4w')
    .eq('kpi_id', kpiId).eq('scope_level', scopeLevel);
  q = scopeKey === null ? q.is('scope_key', null) : q.eq('scope_key', scopeKey);
  const { data, error } = await q.order('week_start', { ascending: false }).limit(weeksBack);
  if (error) throw error;
  const rows = (data ?? []).reverse();

  const withValue = rows.filter((r) => r.value !== null).length;
  const provenance: Provenance = {
    tool: 'kpiTrend',
    args: { kpiId, scopeLevel, scopeKey, weeksBack },
    source: [{ file: 'kpi_snapshots', columns: ['value', 'prev_week_value', 'rolling_mean_4w'] }],
    rows_in: rows.length,
    rows_out: rows.length,
    filters: [`kpi_id = ${kpiId}`, `scope_level = ${scopeLevel}`, `scope_key = ${scopeKey ?? 'null'}`],
  };
  const claims: Claim[] = rows.length ? [{
    id: 'c1',
    text: `${kpiId} trend for ${scopeLevel}${scopeKey ? `:${scopeKey}` : ''} over ${rows.length} weeks`,
    evidence: {
      kind: 'chart',
      refetch: { tool: 'kpiTrend', args: { kpiId, scopeLevel, scopeKey, weeksBack } },
      highlight: ['value'],
    },
  }] : [];

  return {
    data: { kpi_id: kpiId, scope_level: scopeLevel, scope_key: scopeKey, points: rows },
    confidence: {
      coverage: withValue === rows.length
        ? confirmed(`${withValue}/${rows.length} requested weeks have a value`)
        : assumed(`only ${withValue}/${rows.length} requested weeks have a value — gaps in the trend`),
      meaning: confirmed('kpi_snapshots is a materialised, shipped value — not an open column'),
      statistical: rows.length >= 4
        ? confirmed(`n=${rows.length} weeks`)
        : assumed(`only n=${rows.length} weeks — a trend needs more history to read confidently`),
      causal: confirmed('descriptive trend only — no cause attributed by this function'),
    },
    caveats: [],
    provenance,
    claims,
  };
}

export interface KpiByHubRow {
  hub_id: string;
  value: number | null;
  prev_week_value: number | null;
  rolling_mean_4w: number | null;
}

export interface KpiByHubData {
  kpi_id: string;
  week_start: string;
  hubs: KpiByHubRow[];
}

/** Cross-hub, for one week — WITH the comparability warnings attached automatically. */
export async function kpiByHub(sb: SB, kpiId: string, weekStart: string): Promise<AnalysisResult<KpiByHubData>> {
  const { data: kpiRow } = await sb.from('kpis').select('category, owner_role_id').eq('id', kpiId).maybeSingle();

  const { data, error } = await sb.from('kpi_snapshots')
    .select('scope_key, value, prev_week_value, rolling_mean_4w')
    .eq('kpi_id', kpiId).eq('scope_level', 'hub').eq('week_start', weekStart);
  if (error) throw error;
  const rows = (data ?? [])
    .filter((r) => r.scope_key && (ACTIVE_HUBS as readonly string[]).includes(r.scope_key))
    .map((r) => ({ hub_id: r.scope_key as string, value: r.value, prev_week_value: r.prev_week_value, rolling_mean_4w: r.rolling_mean_4w }))
    .sort((a, b) => a.hub_id.localeCompare(b.hub_id));

  const hubsPresent = rows.map((r) => r.hub_id);
  const isFyv = kpiId.includes('fyv') || kpiRow?.owner_role_id === 'aux_calidad';
  const isInventory = kpiRow?.category === 'inventario';
  const caveats = [
    ...(isFyv ? comparabilityCaveats(hubsPresent, 'fyv') : []),
    ...(isInventory ? comparabilityCaveats(hubsPresent, 'inventory') : []),
  ];

  const provenance: Provenance = {
    tool: 'kpiByHub',
    args: { kpiId, weekStart },
    source: [{ file: 'kpi_snapshots', columns: ['value'] }],
    rows_in: (data ?? []).length,
    rows_out: rows.length,
    filters: [`kpi_id = ${kpiId}`, `scope_level = hub`, `week_start = ${weekStart}`],
  };
  const claims: Claim[] = rows.length ? [{
    id: 'c1',
    text: `${kpiId} across ${rows.length} hubs for week ${weekStart}`,
    evidence: {
      kind: 'rows',
      refetch: { tool: 'kpiByHub', args: { kpiId, weekStart } },
      highlight: ['value'],
    },
  }] : [];

  return {
    data: { kpi_id: kpiId, week_start: weekStart, hubs: rows },
    confidence: {
      coverage: rows.length === ACTIVE_HUBS.length
        ? confirmed(`all ${ACTIVE_HUBS.length} hubs present`)
        : assumed(`only ${rows.length}/${ACTIVE_HUBS.length} hubs have a snapshot this week`),
      meaning: confirmed('kpi_snapshots is a materialised, shipped value'),
      statistical: assumed('7 hubs = 7 data points; cross-hub spread is a lead, not a distribution'),
      causal: confirmed('descriptive comparison only — no cause attributed by this function'),
    },
    caveats,
    provenance,
    claims,
  };
}

export interface PeerRankingRow {
  entity_key: string;
  value: number | null;
  peer_mean: number | null;
  z_score: number | null;
  rank: number | null;
  rank_total: number | null;
}

export interface PeerRankingData {
  kpi_id: string;
  week_start: string;
  scope_type: string;
  entities: PeerRankingRow[];
}

export async function peerRanking(
  sb: SB,
  kpiId: string,
  weekStart: string,
  scopeType: 'within_hub' | 'within_city' | 'within_subdivision' | 'global',
  scopeKey?: string
): Promise<AnalysisResult<PeerRankingData>> {
  let q = sb.from('peer_comparisons')
    .select('entity_key, value, peer_mean, z_score, rank, rank_total')
    .eq('kpi_id', kpiId).eq('week_start', weekStart).eq('scope_type', scopeType);
  q = scopeKey ? q.eq('scope_key', scopeKey) : q.is('scope_key', null);
  const { data, error } = await q.order('rank', { ascending: true }).limit(500);
  if (error) throw error;
  const rows = (data ?? []) as PeerRankingRow[];

  const provenance: Provenance = {
    tool: 'peerRanking',
    args: { kpiId, weekStart, scopeType, scopeKey },
    source: [{ file: 'peer_comparisons', columns: ['value', 'z_score', 'rank'] }],
    rows_in: rows.length,
    rows_out: rows.length,
    filters: [`kpi_id = ${kpiId}`, `week_start = ${weekStart}`, `scope_type = ${scopeType}`, `scope_key = ${scopeKey ?? 'null'}`],
  };
  const claims: Claim[] = rows.length ? [{
    id: 'c1',
    text: `${kpiId} peer ranking, ${rows.length} entities, week ${weekStart}`,
    evidence: {
      kind: 'rows',
      refetch: { tool: 'peerRanking', args: { kpiId, weekStart, scopeType, scopeKey } },
      highlight: ['value', 'z_score'],
    },
  }] : [];

  return {
    data: { kpi_id: kpiId, week_start: weekStart, scope_type: scopeType, entities: rows },
    confidence: {
      coverage: rows.length > 0 ? confirmed(`${rows.length} entities ranked`) : assumed('no entities found for this slice'),
      meaning: confirmed('peer_comparisons is pre-computed from the same source as kpi_snapshots'),
      statistical: rows.length >= 5
        ? confirmed(`n=${rows.length} peers`)
        : assumed(`n=${rows.length} peers — small peer group, ranking is noisy`),
      causal: confirmed('ranking only — no cause attributed by this function'),
    },
    caveats: [],
    provenance,
    claims,
  };
}
