/**
 * BUILD.md Phase 2 — faltantesBreakdown / faltantesProductLift / faltantesByPerson.
 * Ported from scripts/investigate-hub.ts §2–4/§6, the reference implementation
 * (BUILD.md's own instruction: "Phase 2 is largely lifting this into lib/").
 */
import type { SB } from './shared';
import { validatedUploads, fetchRowsForUploads, resolveHubId, normPerson, toNum, pctStr, ROLE_ACCOUNT_PATTERN } from './shared';
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed, corrected } from './types';

export interface FaltanteEvent {
  hub: string;
  week: string;
  producto: string;
  armador: string;
  inv: number;
  nota: string;
}

/**
 * Shared row-fetcher — also used by evidence.ts to resolve a claim's
 * `evidence.refetch` back to the exact rows behind it. `faltantes_armador`
 * is scope='total' (one network-wide file/week, `Hub` column per row), so
 * this is always a network-wide fetch; callers filter by hub afterward.
 */
export async function fetchFaltantesEvents(sb: SB, weeksBack: number): Promise<FaltanteEvent[]> {
  const uploads = await validatedUploads(sb, 'faltantes_armador', { weeksBack });
  const weekById = new Map(uploads.map((u) => [u.id, u.week_start]));
  const rows = await fetchRowsForUploads(sb, uploads.map((u) => u.id));
  const events: FaltanteEvent[] = [];
  for (const r of rows) {
    const d = r.data;
    const hub = resolveHubId(String(d['Hub'] ?? '').trim());
    if (!hub) continue;
    events.push({
      hub,
      week: weekById.get(r.upload_id) ?? '',
      producto: String(d['Producto'] ?? '').trim(),
      armador: normPerson(d['Armador']),
      inv: toNum(d['Inventario disponible']),
      nota: String(d['Notas armador'] ?? '').trim(),
    });
  }
  return events;
}

export interface NoteCount { note: string; count: number; }

export interface FaltantesBreakdownData {
  hub: string | 'network';
  weeks_back: number;
  total_events: number;
  inv_zero: number;
  inv_positive: number;
  inv_negative: number;
  inv_null: number;
  top_notes: NoteCount[];
}

/** Inventory split (=0 / >0 / <0 / null) + note clusters. `hub` omitted → network-wide. */
export async function faltantesBreakdown(sb: SB, hub: string | undefined, weeksBack = 12): Promise<AnalysisResult<FaltantesBreakdownData>> {
  const all = await fetchFaltantesEvents(sb, weeksBack);
  const events = hub ? all.filter((e) => e.hub === hub) : all;
  const total = events.length;
  const zero = events.filter((e) => e.inv === 0).length;
  const pos = events.filter((e) => e.inv > 0).length;
  const neg = events.filter((e) => e.inv < 0).length;
  const nul = events.filter((e) => !Number.isFinite(e.inv)).length;

  const noteCounts = new Map<string, number>();
  for (const e of events) {
    const k = e.nota.toLowerCase().trim();
    if (k) noteCounts.set(k, (noteCounts.get(k) ?? 0) + 1);
  }
  const topNotes = [...noteCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([note, count]) => ({ note, count }));

  const provenance: Provenance = {
    tool: 'faltantesBreakdown',
    args: { hub, weeksBack },
    source: [{ file: 'faltantes_armador', columns: ['Inventario disponible', 'Notas armador'] }],
    rows_in: all.length,
    rows_out: total,
    filters: [hub ? `Hub = ${hub}` : 'all hubs', `last ${weeksBack} weeks`],
  };

  const claims: Claim[] = [];
  if (total > 0) {
    claims.push({
      id: 'c1',
      text: `${zero} of ${total} faltantes had Inventario disponible = 0`,
      evidence: {
        kind: 'rows',
        refetch: { tool: 'faltantesBreakdown', args: { hub, weeksBack }, predicate: { invEquals: 0 } },
        highlight: ['Inventario disponible'],
      },
    });
    if (pos > 0) {
      claims.push({
        id: 'c2',
        text: `${pos} of ${total} faltantes had stock believed present (Inventario disponible > 0)`,
        evidence: {
          kind: 'rows',
          refetch: { tool: 'faltantesBreakdown', args: { hub, weeksBack }, predicate: { invGreaterThan: 0 } },
          highlight: ['Inventario disponible'],
        },
      });
    }
  }

  return {
    data: { hub: hub ?? 'network', weeks_back: weeksBack, total_events: total, inv_zero: zero, inv_positive: pos, inv_negative: neg, inv_null: nul, top_notes: topNotes },
    confidence: {
      coverage: total === 0 ? assumed('no events in this window') : (nul / total < 0.05
        ? confirmed(`Inventario disponible missing on ${nul}/${total} (${pctStr(nul, total)})`)
        : assumed(`Inventario disponible missing on ${nul}/${total} (${pctStr(nul, total)}) — meaningful gap`)),
      meaning: confirmed('Inventario disponible = system stock at the moment of the report (DATA_DICTIONARY.md, CONFIRMED)'),
      statistical: total >= 30 ? confirmed(`n=${total} events over ${weeksBack} weeks`) : assumed(`n=${total} events — thin sample`),
      causal: assumed(
        'inv=0 is a genuine stockout, not the armador (CONFIRMED). inv>0 is ambiguous between a real pick ' +
        'failure and authorization non-compliance (OPS_CONTEXT.md §4.3, the armador never having consulted ' +
        'the aux de turno) — this split alone cannot separate those two.'
      ),
    },
    caveats: neg > 0
      ? [`${neg} events have Inventario disponible < 0 — meaning unknown (DATA_DICTIONARY.md ❓ OPEN, ` +
         `network-wide historically ~46 events, min −8).`]
      : [],
    provenance,
    claims,
  };
}

export interface ProductLiftRow {
  producto: string;
  here: number;
  peers: number;
  share_here: number;
  share_peers: number;
  lift: number;
}

export interface ProductLiftData {
  hub: string;
  weeks_back: number;
  total_here: number;
  discriminating: ProductLiftRow[];
  top_by_volume: ProductLiftRow[];
}

/** ⭐ Products over-represented at `hub` vs its peers — never "biggest everywhere". */
export async function faltantesProductLift(sb: SB, hub: string, weeksBack = 12): Promise<AnalysisResult<ProductLiftData>> {
  const all = await fetchFaltantesEvents(sb, weeksBack);
  const here = all.filter((e) => e.hub === hub);
  const peers = all.filter((e) => e.hub !== hub);
  const peerTotal = peers.length;

  const prodHere = new Map<string, number>();
  for (const e of here) prodHere.set(e.producto, (prodHere.get(e.producto) ?? 0) + 1);

  const rows: ProductLiftRow[] = [...prodHere.entries()].map(([producto, n]) => {
    const peerN = peers.filter((e) => e.producto === producto).length;
    const shareHere = n / (here.length || 1);
    const sharePeers = peerN / (peerTotal || 1);
    return { producto, here: n, peers: peerN, share_here: shareHere, share_peers: sharePeers, lift: sharePeers > 0 ? shareHere / sharePeers : Infinity };
  }).sort((a, b) => b.here - a.here);

  // Same threshold as investigate-hub.ts: ≥5 events here AND ≥2× peer share.
  const discriminating = rows.filter((r) => r.here >= 5 && r.lift >= 2).sort((a, b) => (Number.isFinite(b.lift) ? b.lift : 1e9) - (Number.isFinite(a.lift) ? a.lift : 1e9));

  const provenance: Provenance = {
    tool: 'faltantesProductLift',
    args: { hub, weeksBack },
    source: [{ file: 'faltantes_armador', columns: ['Producto', 'Hub'] }],
    rows_in: all.length,
    rows_out: here.length,
    filters: [`Hub = ${hub}`, `last ${weeksBack} weeks`],
  };

  const claims: Claim[] = discriminating.slice(0, 5).map((r, i) => ({
    id: `c${i + 1}`,
    text: `"${r.producto}" is ${Number.isFinite(r.lift) ? `${r.lift.toFixed(1)}×` : 'far above'} the peer share at ${hub} (${r.here} here vs ${r.peers} across all peers)`,
    evidence: {
      kind: 'rows' as const,
      refetch: { tool: 'faltantesProductLift', args: { hub, weeksBack }, predicate: { producto: r.producto } },
      highlight: ['Producto'],
    },
  }));

  return {
    data: { hub, weeks_back: weeksBack, total_here: here.length, discriminating, top_by_volume: rows.slice(0, 15) },
    confidence: {
      coverage: confirmed(`${here.length} events at ${hub} over ${weeksBack} weeks`),
      meaning: confirmed('Producto is a plain dimension column, 100% filled'),
      statistical: here.length >= 30
        ? confirmed(`n=${here.length} events at ${hub}`)
        : assumed(`n=${here.length} events at ${hub} — thin sample, per-product counts are small`),
      causal: assumed('over-representation identifies WHAT is specific to this hub, not WHY — stocking, exhibition capacity, or a genuine supply issue could each produce it (ASSISTANT_DESIGN.md §2)'),
    },
    caveats: [],
    provenance,
    claims,
  };
}

export interface PersonRate {
  armador: string;
  is_role_account: boolean;
  declared_fa: number;
  assembled: number;
  rate: number;
}

export interface FaltantesByPersonData {
  hub: string;
  weeks_back: number;
  people: PersonRate[];
  top3_share_of_total: number | null;
  hub_median_rate: number | null;
}

/** Per-armador declared faltante rates at one hub — role accounts flagged. */
export async function faltantesByPerson(sb: SB, hub: string, weeksBack = 12): Promise<AnalysisResult<FaltantesByPersonData>> {
  const uploads = await validatedUploads(sb, 'desempeno_operadores', { weeksBack });
  const weekById = new Map(uploads.map((u) => [u.id, u.week_start]));
  const rows = await fetchRowsForUploads(sb, uploads.map((u) => u.id));

  const perPerson = new Map<string, { raw: string; assembled: number; declaredFA: number; isRole: boolean }>();
  let rowsAtHub = 0;
  for (const r of rows) {
    const d = r.data;
    const hubId = resolveHubId(String(d['geofence'] ?? '').trim());
    if (hubId !== hub) continue;
    rowsAtHub++;
    const raw = String(d['assembler'] ?? '');
    const person = normPerson(raw);
    if (!person) continue;
    const isRole = ROLE_ACCOUNT_PATTERN.test(raw);
    const asm = toNum(d['num_assembled']);
    const fa = toNum(d['num_orders_with_faltante_armador']);
    const p = perPerson.get(person) ?? { raw, assembled: 0, declaredFA: 0, isRole };
    if (Number.isFinite(asm)) p.assembled += asm;
    if (Number.isFinite(fa)) p.declaredFA += fa;
    perPerson.set(person, p);
  }

  const people: PersonRate[] = [...perPerson.entries()]
    .filter(([, p]) => p.assembled >= 50)
    .map(([, p]) => ({ armador: p.raw, is_role_account: p.isRole, declared_fa: p.declaredFA, assembled: p.assembled, rate: p.declaredFA / (p.assembled || 1) }))
    .sort((a, b) => b.rate - a.rate);

  const totalFA = people.reduce((s, p) => s + p.declared_fa, 0);
  const top3FA = people.slice(0, 3).reduce((s, p) => s + p.declared_fa, 0);
  const top3Share = totalFA > 0 && people.length >= 3 ? top3FA / totalFA : null;
  const median = people.length ? people[Math.floor(people.length / 2)].rate : null;

  const provenance: Provenance = {
    tool: 'faltantesByPerson',
    args: { hub, weeksBack },
    source: [{ file: 'desempeno_operadores', columns: ['num_orders_with_faltante_armador', 'num_assembled', 'assembler'] }],
    rows_in: rowsAtHub,
    rows_out: people.length,
    filters: [`geofence resolves to ${hub}`, `last ${weeksBack} weeks`, 'assembled >= 50'],
  };

  const claims: Claim[] = people.slice(0, 5).map((p, i) => ({
    id: `c${i + 1}`,
    text: `${p.armador}: ${p.declared_fa} declared faltantes / ${p.assembled} assembled = ${pctStr(p.declared_fa, p.assembled)}${p.is_role_account ? ' (role account)' : ''}`,
    evidence: {
      kind: 'rows' as const,
      refetch: { tool: 'faltantesByPerson', args: { hub, weeksBack }, predicate: { armador: p.armador } },
      highlight: ['num_orders_with_faltante_armador', 'num_assembled'],
    },
  }));

  return {
    data: { hub, weeks_back: weeksBack, people, top3_share_of_total: top3Share, hub_median_rate: median },
    confidence: {
      coverage: confirmed(`${people.length} people with >=50 orders assembled at ${hub} over ${weeksBack} weeks`),
      meaning: confirmed('num_orders_with_faltante_armador / num_assembled — DATA_DICTIONARY.md CONFIRMED, orders grain'),
      statistical: people.length >= 5 ? confirmed(`n=${people.length} people`) : assumed(`n=${people.length} people — small workforce sample`),
      causal: corrected(
        'a personal habit (authorization non-compliance) is only weakly separable from genuine pick-failure ' +
        'clustering (OPS_CONTEXT.md §4.3b) — this ranks by suspicion, it does not prove avoidability.'
      ),
    },
    caveats: [
      'Role accounts (auxiliares assembling under the Mon/Tue/Sun rota or off-rota flex, OPS_CONTEXT.md §2) ' +
      'are included and flagged, not excluded — their rate reflects flex-assembly conditions, not a normal armador shift.',
    ],
    provenance,
    claims,
  };
}
