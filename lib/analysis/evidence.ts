/**
 * BUILD.md Phase 2 — resolveEvidence(). ARCHITECTURE.md §4's "Evidence — the
 * click path": resolves a claim's `evidence.refetch` back into the exact
 * rows behind it. In Phase 4 this is called by the UI on click; here it is
 * a plain function so Phase 2's own tests can assert `rows_out` actually
 * matches what the claim said (ASSISTANT_DESIGN.md §4b, property 1: never
 * narrated by a model, generated in code in the same pass as the number —
 * and re-runnable means re-runnable, not merely plausible).
 *
 * Dispatches on `refetch.tool`, reusing each module's own row-fetcher
 * rather than re-deriving filtering logic here.
 */
import type { SB } from './shared';
import type { EvidenceRefetch } from './types';
import { fetchFaltantesEvents } from './faltantes';
import { fetchOrderDeliveries } from './delivery';
import { fetchAttendanceRows, fetchAuxLoadRows, type Role } from './workforce';
import { fetchMnaRows, fetchStockCoverRows } from './inventory';

export interface EvidenceResult {
  rows: unknown[];
  rows_out: number;
}

export async function resolveEvidence(sb: SB, refetch: EvidenceRefetch): Promise<EvidenceResult> {
  const { tool, args, predicate = {} } = refetch;

  switch (tool) {
    case 'faltantesBreakdown':
    case 'faltantesProductLift':
    case 'faltantesByPerson': {
      const weeksBack = Number(args.weeksBack ?? 12);
      const hub = args.hub as string | undefined;
      let rows = await fetchFaltantesEvents(sb, weeksBack);
      if (hub) rows = rows.filter((e) => e.hub === hub);
      if (predicate.invEquals !== undefined) rows = rows.filter((e) => e.inv === predicate.invEquals);
      if (predicate.invGreaterThan !== undefined) rows = rows.filter((e) => e.inv > (predicate.invGreaterThan as number));
      if (predicate.invLessThan !== undefined) rows = rows.filter((e) => e.inv < (predicate.invLessThan as number));
      if (predicate.producto !== undefined) rows = rows.filter((e) => e.producto === predicate.producto);
      if (predicate.armador !== undefined) rows = rows.filter((e) => e.armador === predicate.armador || e.armador.includes(String(predicate.armador).toLowerCase()));
      return { rows, rows_out: rows.length };
    }

    case 'deliveryLateness': {
      const weeksBack = Number(args.weeksBack ?? 12);
      const hub = args.hub as string | undefined;
      const { rows: all } = await fetchOrderDeliveries(sb, hub, weeksBack);
      let rows = all;
      if (predicate.minutesLateGreaterThan !== undefined) rows = rows.filter((r) => r.minutes_late !== null && r.minutes_late > (predicate.minutesLateGreaterThan as number));
      if (predicate.windowLabel !== undefined) rows = rows.filter((r) => r.window_label === predicate.windowLabel);
      return { rows, rows_out: rows.length };
    }

    case 'attendanceByHub': {
      const weeksBack = Number(args.weeksBack ?? 12);
      const roles: Role[] = predicate.role ? [predicate.role as Role] : ['armador', 'repartidor'];
      let rows: Awaited<ReturnType<typeof fetchAttendanceRows>> = [];
      for (const role of roles) rows.push(...await fetchAttendanceRows(sb, role, weeksBack));
      if (predicate.hub !== undefined) rows = rows.filter((r) => r.hub === predicate.hub);
      return { rows, rows_out: rows.length };
    }

    case 'auxAssemblyLoad': {
      const weeksBack = Number(args.weeksBack ?? 12);
      let rows = await fetchAuxLoadRows(sb, weeksBack);
      if (predicate.hub !== undefined) rows = rows.filter((r) => r.hub === predicate.hub);
      if (predicate.isRoleAccount !== undefined) rows = rows.filter((r) => r.is_role_account === predicate.isRoleAccount);
      return { rows, rows_out: rows.length };
    }

    case 'mnaBreakdown': {
      const weeksBack = Number(args.weeksBack ?? 8);
      const hub = args.hub as string;
      const maxTier = args.maxTier as number | undefined;
      const { rows: all } = await fetchMnaRows(sb, hub, weeksBack, maxTier);
      let rows = all;
      if (predicate.producto !== undefined) rows = rows.filter((r) => r.producto === predicate.producto);
      return { rows, rows_out: rows.length };
    }

    case 'stockCover': {
      const hub = args.hub as string;
      const sku = args.sku as string | undefined;
      const { rows: all } = await fetchStockCoverRows(sb, hub, sku);
      let rows = all;
      if (predicate.producto !== undefined) rows = rows.filter((r) => r.producto === predicate.producto);
      return { rows, rows_out: rows.length };
    }

    case 'kpiTrend':
    case 'kpiByHub':
    case 'peerRanking': {
      // These read already-materialised aggregates (kpi_snapshots /
      // peer_comparisons) — there is no deeper raw-row layer beneath them,
      // so "evidence" is re-running the same bounded query.
      const { kpiTrend, kpiByHub, peerRanking } = await import('./kpis');
      if (tool === 'kpiTrend') {
        const r = await kpiTrend(sb, args.kpiId as string, args.scopeLevel as any, args.scopeKey as string | null, args.weeksBack as number);
        return { rows: r.data.points as any, rows_out: r.data.points.length };
      }
      if (tool === 'kpiByHub') {
        const r = await kpiByHub(sb, args.kpiId as string, args.weekStart as string);
        return { rows: r.data.hubs as any, rows_out: r.data.hubs.length };
      }
      const r = await peerRanking(sb, args.kpiId as string, args.weekStart as string, args.scopeType as any, args.scopeKey as string | undefined);
      return { rows: r.data.entities as any, rows_out: r.data.entities.length };
    }

    case 'discriminate': {
      // discriminate() is pure/sync — no DB layer beneath it. Its own input
      // IS the evidence; reconstruct the {hub, metric, candidate} table
      // directly from the embedded args rather than issuing a query.
      const metricValues = (args.metricValues ?? {}) as Record<string, number>;
      const candidateValues = (args.candidateValues ?? {}) as Record<string, number>;
      const metricName = String(args.metricName ?? 'metric');
      const candidateName = String(args.candidateName ?? 'candidate');
      const rows = Object.keys(metricValues).map((hub) => ({
        hub, [metricName]: metricValues[hub], [candidateName]: candidateValues[hub],
      }));
      return { rows, rows_out: rows.length };
    }

    default:
      throw new Error(`resolveEvidence: unknown tool "${tool}"`);
  }
}
