/**
 * BUILD.md Phase 2 GATE — "Call these directly from a script and show José
 * the output. If the answers are not useful when called directly, no chat
 * UI will save them."
 *
 * Reconstructs the Contry faltantes investigation (ASSISTANT_DESIGN.md §2's
 * worked example B, already validated once via scripts/investigate-hub.ts)
 * but this time composed ENTIRELY from lib/analysis/* — proving the Phase 2
 * functions, called the way Phase 3's chat loop will call them, produce the
 * same quality of answer. Also exercises modules investigate-hub.ts never
 * touched: deliveryLateness (Phase 1's order_deliveries) and kpiByHub.
 *
 * Run from the project root:
 *   npx tsx scripts/demo-analysis.ts                 # defaults to mh_contry
 *   npx tsx scripts/demo-analysis.ts mh_cumbres 12
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { listWeeks } from '../lib/analysis/registry';
import { kpiByHub } from '../lib/analysis/kpis';
import { faltantesBreakdown, faltantesProductLift, faltantesByPerson } from '../lib/analysis/faltantes';
import { deliveryLateness } from '../lib/analysis/delivery';
import { attendanceByHub, auxAssemblyLoad } from '../lib/analysis/workforce';
import { mnaBreakdown } from '../lib/analysis/inventory';
import { discriminate, type DiscriminateCandidateInput } from '../lib/analysis/discriminate';
import { ACTIVE_HUBS } from '../lib/analysis/shared';
import type { AnalysisResult } from '../lib/analysis/types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }) as any;

const TARGET_HUB = process.argv[2] ?? 'mh_contry';
const WEEKS_BACK = Number(process.argv[3] ?? 12);

const L: string[] = [];
const say = (s = '') => { L.push(s); console.log(s); };

function confidenceLine(r: AnalysisResult<unknown>): string {
  const c = r.confidence;
  return `coverage=${c.coverage.rating} meaning=${c.meaning.rating} statistical=${c.statistical.rating} causal=${c.causal.rating}`;
}

async function main() {
  say('='.repeat(78));
  say(`PHASE 2 DEMO — ${TARGET_HUB}, last ${WEEKS_BACK} weeks`);
  say('Every number below came from lib/analysis/*, called exactly as Phase 3\'s');
  say('chat loop will call it — no ad-hoc script logic, no AI.');
  say('='.repeat(78));

  // ── Gather per-hub data (proves cross-module composition) ────────────────
  say('\nGathering per-hub faltantes rate + candidate factors across all 7 hubs...');
  const faltantesByHub = new Map<string, AnalysisResult<Awaited<ReturnType<typeof faltantesBreakdown>>['data']>>();
  for (const hub of ACTIVE_HUBS) faltantesByHub.set(hub, await faltantesBreakdown(sb, hub, WEEKS_BACK));

  const auxLoad = await auxAssemblyLoad(sb, WEEKS_BACK);
  const attendance = await attendanceByHub(sb, WEEKS_BACK);

  const weeks = await listWeeks(sb, { appId: 'desempeno_operadores' });
  const latestWeek = weeks[weeks.length - 1];
  const tasaArmado = await kpiByHub(sb, 'tasa_armado', latestWeek);

  const rate1k: Record<string, number> = {};
  for (const hub of ACTIVE_HUBS) {
    const events = faltantesByHub.get(hub)!.data.total_events;
    const assembled = auxLoad.data.hubs.find((h) => h.hub === hub)?.assembled_total ?? 0;
    rate1k[hub] = assembled > 0 ? (events / assembled) * 1000 : NaN;
  }

  // ── 1. faltantesBreakdown ────────────────────────────────────────────────
  say('\n' + '─'.repeat(78));
  say('1 · faltantesBreakdown(hub, weeks)');
  say('─'.repeat(78));
  const fb = faltantesByHub.get(TARGET_HUB)!;
  say(`  ${fb.data.total_events} events · inv=0: ${fb.data.inv_zero} · inv>0: ${fb.data.inv_positive} · inv<0: ${fb.data.inv_negative}`);
  say(`  top notes: ${fb.data.top_notes.slice(0, 3).map((n) => `"${n.note}" (${n.count})`).join(', ')}`);
  say(`  confidence: ${confidenceLine(fb)}`);
  say(`  caveats: ${fb.caveats.length ? fb.caveats.join(' | ') : '(none)'}`);
  say(`  claims: ${fb.claims.map((c) => c.text).join(' | ')}`);

  // ── 2. faltantesProductLift ──────────────────────────────────────────────
  say('\n' + '─'.repeat(78));
  say('2 · faltantesProductLift(hub, weeks)');
  say('─'.repeat(78));
  const fpl = await faltantesProductLift(sb, TARGET_HUB, WEEKS_BACK);
  say(`  ${fpl.data.discriminating.length} products discriminate (≥5 here, ≥2× peer share)`);
  for (const p of fpl.data.discriminating.slice(0, 5)) say(`    ${p.producto}: ${p.here} here vs ${p.peers} peers, lift ${Number.isFinite(p.lift) ? p.lift.toFixed(1) + '×' : '∞'}`);
  say(`  confidence: ${confidenceLine(fpl)}`);

  // ── 3. faltantesByPerson ─────────────────────────────────────────────────
  say('\n' + '─'.repeat(78));
  say('3 · faltantesByPerson(hub, weeks)');
  say('─'.repeat(78));
  const fbp = await faltantesByPerson(sb, TARGET_HUB, WEEKS_BACK);
  say(`  top3_share_of_total: ${fbp.data.top3_share_of_total !== null ? (fbp.data.top3_share_of_total * 100).toFixed(0) + '%' : '—'}, hub_median_rate: ${fbp.data.hub_median_rate !== null ? (fbp.data.hub_median_rate * 100).toFixed(1) + '%' : '—'}`);
  say(`  confidence: ${confidenceLine(fbp)}`);
  say(`  caveats: ${fbp.caveats.join(' | ')}`);

  // ── 4. deliveryLateness — Phase 1's order_deliveries, unavailable before ──
  say('\n' + '─'.repeat(78));
  say('4 · deliveryLateness(hub, weeks) — built on Phase 1\'s order_deliveries');
  say('─'.repeat(78));
  const dl = await deliveryLateness(sb, TARGET_HUB, WEEKS_BACK);
  say(`  ${dl.data.total_orders} orders · >10min (system "late"): ${dl.data.late_gt10} (${(dl.data.pct_late_gt10 * 100).toFixed(1)}%)`);
  say(`  protocol targets: >30min: ${(dl.data.pct_late_gt30 * 100).toFixed(1)}% (target ≤5%) · >60min: ${(dl.data.pct_late_gt60 * 100).toFixed(1)}% (target ≤1%)`);
  if (dl.data.by_window.length) {
    const worst = dl.data.by_window[0];
    say(`  worst window: "${worst.window_label}" at ${(worst.pct_late_gt30 * 100).toFixed(1)}% >30min-late (n=${worst.total})`);
  }
  say(`  confidence: ${confidenceLine(dl)}`);

  // ── 5. mnaBreakdown ───────────────────────────────────────────────────────
  say('\n' + '─'.repeat(78));
  say('5 · mnaBreakdown(hub, weeks)');
  say('─'.repeat(78));
  const mna = await mnaBreakdown(sb, TARGET_HUB, Math.min(WEEKS_BACK, 8));
  say(`  total MNA: $${mna.data.total_mna_dollars.toFixed(0)} (${(mna.data.mna_pct * 100).toFixed(2)}% of received value) · top-10 SKUs = ${(mna.data.pareto_share_top10 * 100).toFixed(1)}% of total MNA`);
  for (const s of mna.data.top_skus.slice(0, 3)) say(`    ${s.producto}: $${s.mna_dollars.toFixed(0)}`);
  say(`  confidence: ${confidenceLine(mna)}`);

  // ── 6. discriminate — the whole point ────────────────────────────────────
  say('\n' + '─'.repeat(78));
  say('6 · discriminate() — candidates built from kpis.ts + workforce.ts, network-wide');
  say('─'.repeat(78));
  const candidates: DiscriminateCandidateInput[] = [
    {
      name: 'role_account_share_of_assembly',
      values: Object.fromEntries(auxLoad.data.hubs.map((h) => [h.hub, h.role_account_share])),
    },
    {
      name: 'unjustified_absences_armador',
      values: Object.fromEntries(
        attendance.data.hubs.filter((h) => h.role === 'armador').map((h) => [h.hub, h.absences_unjustified])
      ),
    },
    {
      name: 'tasa_armado',
      values: Object.fromEntries(tasaArmado.data.hubs.filter((h) => h.value !== null).map((h) => [h.hub_id, h.value as number])),
    },
    {
      name: 'idle_days_sum',
      values: Object.fromEntries(auxLoad.data.hubs.map((h) => [h.hub, h.idle_days_sum])),
      openMeaning: true,
    },
  ];
  const disc = discriminate('faltantes_rate_per_1k', rate1k, TARGET_HUB, candidates);
  say(`  ${TARGET_HUB}: ${disc.data.target_metric_value.toFixed(1)}/1k vs peer mean ${disc.data.peer_metric_mean.toFixed(1)}/1k (gap ${disc.data.metric_gap >= 0 ? '+' : ''}${disc.data.metric_gap.toFixed(1)})`);
  for (const c of disc.data.candidates) {
    say(`    ${c.name.padEnd(32)} target=${c.target_value.toFixed(2).padStart(8)} peer=${c.peer_mean.toFixed(2).padStart(8)} ρ=${c.rank_correlation.toFixed(2).padStart(5)}  ${c.verdict}${c.open_meaning ? '  [OPEN column]' : ''}`);
  }
  say(`  confidence: ${confidenceLine(disc)}`);
  say(`  caveats: ${disc.caveats.join(' | ')}`);
  say(`  claims: ${disc.claims.map((c) => c.text).join('\n           ')}`);

  // ── 7. SYNTHESIS — same discipline as investigate-hub.ts §8 ─────────────
  say('\n' + '='.repeat(78));
  say('7 · SYNTHESIS');
  say('='.repeat(78));
  const finding: string[] = [];
  finding.push(`${TARGET_HUB}'s faltante rate is ${disc.data.metric_gap.toFixed(1)}/1k above the peer mean (${disc.data.target_metric_value.toFixed(1)} vs ${disc.data.peer_metric_mean.toFixed(1)}).`);
  finding.push(`${fb.data.inv_zero} of ${fb.data.total_events} faltantes had genuine stock unavailability (Inventario disponible = 0); the rest were believed in stock.`);
  if (fpl.data.discriminating.length) finding.push(`${fpl.data.discriminating.length} products are specifically over-represented here, not just large everywhere.`);
  const topFactor = disc.data.candidates.filter((c) => c.verdict === 'DISCRIMINATES').sort((a, b) => Math.abs(b.rank_correlation) - Math.abs(a.rank_correlation))[0];
  if (topFactor) finding.push(`Cross-hub, "${topFactor.name}" discriminates (ρ=${topFactor.rank_correlation.toFixed(2)}, n=7 — a lead, not proof)${topFactor.open_meaning ? ', though it touches an OPEN column' : ''}.`);
  else finding.push('No candidate factor tested here discriminates for this hub — the gap remains unexplained by what was checked.');
  say('  FINDING');
  for (const p of finding) say(`    · ${p}`);
  say('\n  This finding, its evidence, and its confidence were ALL produced by lib/analysis/*');
  say('  in code — nothing above was narrated or summarised by a model.');

  writeFileSync('demo-analysis.txt', L.join('\n'));
  say('\n✅ Wrote demo-analysis.txt to the project root.');
}

main().catch((e) => { console.error(e); process.exit(1); });
