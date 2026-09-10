/**
 * BUILD.md Phase 3 — the tool catalogue exposed to the chat agent loop.
 * `app/api/tools/[name]/route.ts` is a thin wrapper over this; kept in
 * lib/ (not the route file) so scripts/tests can dispatch the same way
 * without going through HTTP.
 *
 * Every entry: a zod schema for the args Claude sends, and a handler that
 * calls the matching lib/analysis/* function. `lookupColumn`/`lookupContext`
 * live here too — ASSISTANT_DESIGN.md §4b layer 3, a fallback tool, not a
 * prompt dump (see lib/prompts/lookup.ts).
 */
import { z } from 'zod';
import type { SB } from './shared';
import { listHubs, listKpis, listWeeks } from './registry';
import { kpiTrend, kpiByHub, peerRanking } from './kpis';
import { faltantesBreakdown, faltantesProductLift, faltantesByPerson } from './faltantes';
import { deliveryLateness } from './delivery';
import { attendanceByHub, auxAssemblyLoad } from './workforce';
import { mnaBreakdown, stockCover } from './inventory';
import { discriminate } from './discriminate';
import { lookupColumn, lookupContext } from '../prompts/lookup';

const scopeLevelEnum = z.enum(['global', 'city', 'hub', 'operator', 'driver', 'sku']);
const peerScopeEnum = z.enum(['within_hub', 'within_city', 'within_subdivision', 'global']);

const discriminateCandidateSchema = z.object({
  name: z.string(),
  values: z.record(z.string(), z.number()),
  openMeaning: z.boolean().optional(),
});

export interface ToolDefinition {
  description: string;
  schema: z.ZodTypeAny;
  handler: (sb: SB, args: any) => Promise<unknown>;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  listHubs: {
    description: 'List the 7 active hubs.',
    schema: z.object({}),
    handler: async (sb) => listHubs(sb),
  },
  listKpis: {
    description: 'List KPIs in the registry.',
    schema: z.object({ activeOnly: z.boolean().optional() }),
    handler: async (sb, a) => listKpis(sb, a),
  },
  listWeeks: {
    description: 'List week_start values with at least one validated upload, ascending. Pass appId to scope to one app.',
    schema: z.object({ appId: z.string().optional() }),
    handler: async (sb, a) => listWeeks(sb, a),
  },
  kpiTrend: {
    description: 'A KPI\'s trend for one scope (e.g. one hub) over its own recent history — the primary WoW signal.',
    schema: z.object({ kpiId: z.string(), scopeLevel: scopeLevelEnum, scopeKey: z.string().nullable(), weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => kpiTrend(sb, a.kpiId, a.scopeLevel, a.scopeKey, a.weeksBack),
  },
  kpiByHub: {
    description: 'A KPI across all 7 hubs for one week — comparability caveats attached automatically where relevant.',
    schema: z.object({ kpiId: z.string(), weekStart: z.string() }),
    handler: async (sb, a) => kpiByHub(sb, a.kpiId, a.weekStart),
  },
  peerRanking: {
    description: 'Entity-level (armador/driver/etc.) peer ranking for a KPI, one week.',
    schema: z.object({ kpiId: z.string(), weekStart: z.string(), scopeType: peerScopeEnum, scopeKey: z.string().optional() }),
    handler: async (sb, a) => peerRanking(sb, a.kpiId, a.weekStart, a.scopeType, a.scopeKey),
  },
  faltantesBreakdown: {
    description: 'Faltantes armador inventory split (=0/>0/<0/null) + top note clusters, for one hub or network-wide.',
    schema: z.object({ hub: z.string().optional(), weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => faltantesBreakdown(sb, a.hub, a.weeksBack),
  },
  faltantesProductLift: {
    description: '⭐ Products over-represented at this hub vs its peers — never "biggest everywhere". Use before naming a product as a cause.',
    schema: z.object({ hub: z.string(), weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => faltantesProductLift(sb, a.hub, a.weeksBack),
  },
  faltantesByPerson: {
    description: 'Per-armador declared faltante rates at one hub, role accounts flagged — is the gap concentrated in a few people?',
    schema: z.object({ hub: z.string(), weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => faltantesByPerson(sb, a.hub, a.weeksBack),
  },
  deliveryLateness: {
    description: 'Delivery lateness for one hub or network-wide — both the protocol\'s >30/>60-min targets AND the source system\'s own >10-min "late" cutoff, plus by-window breakdown.',
    schema: z.object({ hub: z.string().optional(), weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => deliveryLateness(sb, a.hub, a.weeksBack),
  },
  attendanceByHub: {
    description: 'Unjustified vs justified absences/tardiness, per hub per role (armador/repartidor).',
    schema: z.object({ weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => attendanceByHub(sb, a.weeksBack),
  },
  auxAssemblyLoad: {
    description: 'Role-account (auxiliar) share of assembly per hub — a flex-intensity measure, NOT an emergency-only signal (it\'s a scheduled rota).',
    schema: z.object({ weeksBack: z.number().int().positive().max(52).optional() }),
    handler: async (sb, a) => auxAssemblyLoad(sb, a.weeksBack),
  },
  mnaBreakdown: {
    description: 'SKU-level merma at one hub, aggregated in pesos (unit-safe). Optional maxTier restricts to fast-moving SKUs.',
    schema: z.object({ hub: z.string(), weeksBack: z.number().int().positive().max(26).optional(), maxTier: z.number().optional() }),
    handler: async (sb, a) => mnaBreakdown(sb, a.hub, a.weeksBack, a.maxTier),
  },
  stockCover: {
    description: 'Days of stock cover per SKU at one hub, latest week. Pass sku to check one product.',
    schema: z.object({ hub: z.string(), sku: z.string().optional() }),
    handler: async (sb, a) => stockCover(sb, a.hub, a.sku),
  },
  discriminate: {
    description:
      '⭐ THE tool that stops this being a CSV sort. Give it a metric\'s per-hub values (gathered via other tools) and candidate ' +
      'factors\' per-hub values — it tells you which candidates actually track the target hub\'s gap vs peers (DISCRIMINATES) ' +
      'vs which are just large everywhere (rejected). Never name a cause without running this first.',
    schema: z.object({
      metricName: z.string(),
      metricValues: z.record(z.string(), z.number()),
      targetHub: z.string(),
      candidates: z.array(discriminateCandidateSchema),
    }),
    handler: async (_sb, a) => discriminate(a.metricName, a.metricValues, a.targetHub, a.candidates),
  },
  lookupColumn: {
    description: 'ASSISTANT_DESIGN.md §4b layer 3 (fallback only — most caveats already arrive attached to tool results). Look up a column\'s meaning and status from DATA_DICTIONARY.md.',
    schema: z.object({ file: z.string(), column: z.string() }),
    handler: async (_sb, a) => lookupColumn(a.file, a.column),
  },
  lookupContext: {
    description: 'ASSISTANT_DESIGN.md §4b layer 3 (fallback only). Look up an operating-context topic from OPS_CONTEXT.md (layout, roles, protocols).',
    schema: z.object({ topic: z.string() }),
    handler: async (_sb, a) => lookupContext(a.topic),
  },
};

export type ToolName = keyof typeof TOOL_REGISTRY;
