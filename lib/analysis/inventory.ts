/**
 * BUILD.md Phase 2 — mnaBreakdown / stockCover. `mna` is scope='per_hub'
 * (one file per hub per week), so uploads filter directly on hub_id — no
 * per-row hub resolution needed, unlike the per_city/total files.
 *
 * Unit hazard (DATA_DICTIONARY.md `mna`): never sum Recibido/Inventario/
 * MNA(kg/pz)/Consumo-día across SKUs without splitting by `Kg/Pz` unit.
 * Money is safe — Source price is per the row's own unit, so
 * Recibido × Source price is pesos on every row regardless of unit. This
 * module only ever sums money, never raw Recibido/Inventario quantities.
 */
import type { SB } from './shared';
import { validatedUploads, fetchRowsForUploads, toNum } from './shared';
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed } from './types';

export interface MnaRow {
  producto: string;
  mna_dollars: number;
  recibido_value: number;
  tier: string | null;
}

/** Shared row-fetcher — one row per SKU per week — also used by evidence.ts. */
export async function fetchMnaRows(sb: SB, hub: string, weeksBack: number, maxTier?: number): Promise<{ rows: MnaRow[]; rowsScanned: number }> {
  const uploads = await validatedUploads(sb, 'mna', { hubId: hub, weeksBack });
  const rawRows = await fetchRowsForUploads(sb, uploads.map((u) => u.id));
  const out: MnaRow[] = [];
  for (const r of rawRows) {
    const d = r.data;
    const tier = d['Tiers'] != null ? String(d['Tiers']) : null;
    if (maxTier != null) {
      const tierNum = tier ? Number(tier.split('.')[0]) : NaN;
      if (!Number.isFinite(tierNum) || tierNum > maxTier) continue;
    }
    const producto = String(d['Producto'] ?? '').trim();
    const mna = toNum(d['MNA ($)']);
    const recibido = toNum(d['Recibido']);
    const price = toNum(d['Source price']);
    const recibidoValue = Number.isFinite(recibido) && Number.isFinite(price) ? recibido * price : 0;
    out.push({ producto, mna_dollars: Number.isFinite(mna) ? mna : 0, recibido_value: recibidoValue, tier });
  }
  return { rows: out, rowsScanned: rawRows.length };
}

export interface MnaSkuRow {
  producto: string;
  mna_dollars: number;
  recibido_value: number;
  mna_pct: number;
  tier: string | null;
}

export interface MnaBreakdownData {
  hub: string;
  weeks_back: number;
  total_mna_dollars: number;
  total_recibido_value: number;
  mna_pct: number;
  top_skus: MnaSkuRow[];
  pareto_share_top10: number;
}

/**
 * SKU-level merma, aggregated in pesos (the only unit-safe axis). `tier`
 * (Tiers, 100% filled, CONFIRMED velocity rank) optionally restricts to
 * tier <= N. `category` (fyv/carnes/abarrotes via lib/sku-classifier.ts) is
 * NOT supported here — DATA_DICTIONARY.md flags that classifier 🔶
 * UNRESOLVED (~85% of the catalog falls through to a ~79%-accurate keyword
 * guess), so filtering silently by it would produce a confidently wrong
 * scope. Add it only once the classifier itself is fixed.
 */
export async function mnaBreakdown(sb: SB, hub: string, weeksBack = 8, maxTier?: number): Promise<AnalysisResult<MnaBreakdownData>> {
  const { rows, rowsScanned } = await fetchMnaRows(sb, hub, weeksBack, maxTier);

  const bySku = new Map<string, { mna: number; recibidoValue: number; tier: string | null }>();
  for (const r of rows) {
    const s = bySku.get(r.producto) ?? { mna: 0, recibidoValue: 0, tier: r.tier };
    s.mna += r.mna_dollars;
    s.recibidoValue += r.recibido_value;
    bySku.set(r.producto, s);
  }

  const skuRows: MnaSkuRow[] = [...bySku.entries()]
    .map(([producto, s]) => ({
      producto, mna_dollars: s.mna, recibido_value: s.recibidoValue,
      mna_pct: s.mna + s.recibidoValue > 0 ? s.mna / (s.mna + s.recibidoValue) : 0,
      tier: s.tier,
    }))
    .sort((a, b) => b.mna_dollars - a.mna_dollars);

  const totalMna = skuRows.reduce((s, r) => s + r.mna_dollars, 0);
  const totalRecibidoValue = skuRows.reduce((s, r) => s + r.recibido_value, 0);
  const top10Sum = skuRows.slice(0, 10).reduce((s, r) => s + r.mna_dollars, 0);

  const provenance: Provenance = {
    tool: 'mnaBreakdown',
    args: { hub, weeksBack, maxTier },
    source: [{ file: 'mna', columns: ['MNA ($)', 'Recibido', 'Source price', 'Tiers'] }],
    rows_in: rowsScanned,
    rows_out: rows.length,
    filters: [`hub_id = ${hub}`, `last ${weeksBack} weeks`, maxTier != null ? `Tiers <= ${maxTier}` : 'all tiers'],
  };

  const claims: Claim[] = skuRows.slice(0, 5).map((r, i) => ({
    id: `c${i + 1}`,
    text: `${r.producto}: $${r.mna_dollars.toFixed(0)} MNA at ${hub} over ${weeksBack} weeks (${(r.mna_pct * 100).toFixed(1)}% of its received value)`,
    evidence: { kind: 'rows' as const, refetch: { tool: 'mnaBreakdown', args: { hub, weeksBack, maxTier }, predicate: { producto: r.producto } }, highlight: ['MNA ($)'] },
  }));

  return {
    data: {
      hub, weeks_back: weeksBack, total_mna_dollars: totalMna, total_recibido_value: totalRecibidoValue,
      mna_pct: totalMna + totalRecibidoValue > 0 ? totalMna / (totalMna + totalRecibidoValue) : 0,
      top_skus: skuRows.slice(0, 20),
      pareto_share_top10: totalMna > 0 ? top10Sum / totalMna : 0,
    },
    confidence: {
      coverage: confirmed(`${rows.length} SKU-rows at ${hub} over ${weeksBack} weeks`),
      meaning: confirmed('MNA ($) × Recibido × Source price aggregation in pesos is unit-safe (DATA_DICTIONARY.md `mna`, CONFIRMED — the unit hazard only bites when summing raw Recibido/Inventario across SKUs, which this function never does)'),
      statistical: rows.length >= 100 ? confirmed(`n=${rows.length} SKU-rows`) : assumed(`n=${rows.length} SKU-rows — thin sample`),
      causal: assumed('this decomposes WHERE merma concentrates (Pareto), not WHY — DATA_DICTIONARY.md `mna` is 95% zeros network-wide, so any non-zero SKU needs a peer comparison (discriminate()) before treating it as hub-specific'),
    },
    caveats: [
      '`category` (fyv/carnes/abarrotes) filtering is not supported — lib/sku-classifier.ts is 🔶 UNRESOLVED ' +
      '(~85% of the catalog falls through to a ~79%-accurate keyword guess, DATA_DICTIONARY.md `mna`).',
    ],
    provenance,
    claims,
  };
}

export interface StockCoverRow {
  producto: string;
  inventario: number;
  consumo_dia: number;
  dias_cobertura: number;
  unit: string;
}

export interface StockCoverData {
  hub: string;
  week_start: string | null;
  skus: StockCoverRow[];
}

/** Shared row-fetcher — the latest week's per-SKU cover for a hub — also used by evidence.ts. */
export async function fetchStockCoverRows(sb: SB, hub: string, sku?: string): Promise<{ rows: StockCoverRow[]; weekStart: string | null; rowsScanned: number }> {
  const uploads = await validatedUploads(sb, 'mna', { hubId: hub, weeksBack: 1 });
  const latest = uploads[0];
  if (!latest) return { rows: [], weekStart: null, rowsScanned: 0 };
  const rawRows = await fetchRowsForUploads(sb, [latest.id]);

  const rows: StockCoverRow[] = [];
  for (const r of rawRows) {
    const d = r.data;
    const producto = String(d['Producto'] ?? '').trim();
    if (sku && producto !== sku) continue;
    const inventario = toNum(d['Inventario']);
    const consumo = toNum(d['Consumo / día']);
    if (!Number.isFinite(inventario) || !Number.isFinite(consumo) || consumo === 0) continue;
    rows.push({ producto, inventario, consumo_dia: consumo, dias_cobertura: inventario / consumo, unit: String(d['Kg/Pz'] ?? '').trim() });
  }
  rows.sort((a, b) => a.dias_cobertura - b.dias_cobertura);
  return { rows, weekStart: latest.week_start, rowsScanned: rawRows.length };
}

/** Inventario ÷ Consumo/día — DATA_DICTIONARY.md ✅✅ derivation proven at row level (100.00% match, n=42,758). Computed directly, not read from the stored `Días de inventario` string column. */
export async function stockCover(sb: SB, hub: string, sku?: string): Promise<AnalysisResult<StockCoverData>> {
  const { rows, weekStart, rowsScanned } = await fetchStockCoverRows(sb, hub, sku);
  if (!weekStart) return emptyStockCover(hub);

  const provenance: Provenance = {
    tool: 'stockCover',
    args: { hub, sku },
    source: [{ file: 'mna', columns: ['Inventario', 'Consumo / día'] }],
    rows_in: rowsScanned,
    rows_out: rows.length,
    filters: [`hub_id = ${hub}`, `week_start = ${weekStart}`, sku ? `Producto = ${sku}` : 'all SKUs', 'Consumo / día != 0'],
  };

  const lowest = rows[0];
  const claims: Claim[] = lowest ? [{
    id: 'c1',
    text: `${lowest.producto} at ${hub}: ${lowest.dias_cobertura.toFixed(1)} days of cover (${lowest.inventario} ${lowest.unit} ÷ ${lowest.consumo_dia}/day)`,
    evidence: { kind: 'rows', refetch: { tool: 'stockCover', args: { hub, sku }, predicate: { producto: lowest.producto } }, highlight: ['Inventario', 'Consumo / día'] },
  }] : [];

  return {
    data: { hub, week_start: weekStart, skus: sku ? rows : rows.slice(0, 20) },
    confidence: {
      coverage: confirmed(`${rows.length} SKUs with non-zero Consumo/día at ${hub}, week ${weekStart}`),
      meaning: confirmed('Días de inventario = Inventario / (Consumo / día) — DATA_DICTIONARY.md ✅✅ 100.00% match, n=42,758'),
      statistical: confirmed('single-week point-in-time snapshot, not a trend'),
      causal: confirmed('a direct ratio, not an inference — no causal claim to weaken'),
    },
    caveats: ['SKUs with Consumo / día = 0 are excluded (division undefined), not shown as infinite cover.'],
    provenance,
    claims,
  };
}

function emptyStockCover(hub: string): AnalysisResult<StockCoverData> {
  return {
    data: { hub, week_start: null, skus: [] },
    confidence: {
      coverage: assumed('no validated mna upload found for this hub'),
      meaning: confirmed('Días de inventario = Inventario / (Consumo / día) — DATA_DICTIONARY.md ✅✅'),
      statistical: assumed('no data'),
      causal: confirmed('a direct ratio, not an inference'),
    },
    caveats: [],
    provenance: { tool: 'stockCover', args: { hub }, source: [{ file: 'mna', columns: [] }], rows_in: 0, rows_out: 0, filters: [`hub_id = ${hub}`] },
    claims: [],
  };
}
