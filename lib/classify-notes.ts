/**
 * Classify free-text incident notes into a fixed label set using Haiku.
 * Drives the derived KPI `entregas_erroneas` (count of rows labeled
 * `entrega_erronea`) and surfaces causes for "Faltantes armador" notes.
 *
 * Cheap: ~$0.001-0.005 per upload (a few hundred notes, ~50 tokens each).
 */

import { anthropic, MODELS, estimateCost } from './anthropic';
import { createAdminSupabase } from './supabase-server';

const LABEL_SET = [
  'entrega_erronea',
  'faltante',
  'mala_calidad',
  'asistencia',
  'dato_captura',
  'producto',
  'otro',
] as const;
type Label = typeof LABEL_SET[number];

export interface ClassifyResult {
  rows_classified: number;
  cost_usd: number;
}

const SYSTEM = `Eres un clasificador de notas de incidentes operacionales de Calii (delivery de supermercado).

Para cada nota recibida, asigna exactamente UN label primario del set:
- entrega_erronea: pedido entregado al cliente con productos cambiados, equivocados, o entregado a la persona equivocada.
- faltante: cliente reporta items faltantes (incompletos / parciales / completos).
- mala_calidad: producto en mal estado, dañado, vencido, mala calidad detectada por cliente.
- asistencia: ausencia, llegada tarde, abandono de turno del operador.
- dato_captura: error de scaneo, código equivocado, fecha de caducidad mal capturada, etc.
- producto: tema del producto en sí (no debería estar en catálogo, etiquetado mal, etc.)
- otro: cualquier otro caso.

Responde SIEMPRE con JSON válido. Cada item del array debe tener:
  { "row_index": N, "primary_label": "<one of the labels>", "confidence": 0.0-1.0 }

No incluyas explicaciones. Sin texto antes o después del JSON.`;

interface RowToClassify {
  row_index: number;
  notes: string;
}

export async function classifyIncidentNotes(uploadId: string): Promise<ClassifyResult> {
  const sb = createAdminSupabase();

  // Pull rows where Notas is non-empty AND row isn't already classified.
  const { data: rows } = await sb
    .from('upload_rows')
    .select('id, row_index, data, labels')
    .eq('upload_id', uploadId)
    .eq('is_excluded', false);

  if (!rows || rows.length === 0) return { rows_classified: 0, cost_usd: 0 };

  const toClassify: RowToClassify[] = [];
  const idsByIndex = new Map<number, number>();
  for (const r of rows) {
    const existing = (r.labels as any)?.primary_label;
    const note = String((r.data as any)['Notas'] ?? '').trim();
    if (existing || !note) continue;
    toClassify.push({ row_index: r.row_index as number, notes: note });
    idsByIndex.set(r.row_index as number, r.id as number);
  }

  if (toClassify.length === 0) return { rows_classified: 0, cost_usd: 0 };

  // Batch in groups of 50 rows per Haiku call to keep latency low.
  const BATCH = 50;
  let totalIn = 0, totalOut = 0;
  let totalClassified = 0;

  for (let i = 0; i < toClassify.length; i += BATCH) {
    const batch = toClassify.slice(i, i + BATCH);
    const userMsg = `Clasifica estas ${batch.length} notas:\n\n${batch.map(r => `[${r.row_index}] ${r.notes}`).join('\n')}`;

    const resp = await anthropic().messages.create({
      model: MODELS.haiku,
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;

    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text).join('');

    let parsed: { row_index: number; primary_label: Label; confidence: number }[];
    try {
      // Tolerate fenced JSON
      const cleaned = text.replace(/^```json\s*|```$/gm, '').trim();
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error('not an array');
    } catch (e: any) {
      console.error('classify_parse_error', e.message, text.slice(0, 200));
      continue;
    }

    // Update rows with labels
    for (const out of parsed) {
      const rowId = idsByIndex.get(out.row_index);
      if (!rowId) continue;
      if (!(LABEL_SET as readonly string[]).includes(out.primary_label)) continue;
      await sb.from('upload_rows').update({
        labels: {
          primary_label: out.primary_label,
          confidence: typeof out.confidence === 'number' ? out.confidence : 0.7,
          model: MODELS.haiku,
          classified_at: new Date().toISOString(),
        },
      }).eq('id', rowId);
      totalClassified += 1;
    }
  }

  return {
    rows_classified: totalClassified,
    cost_usd: estimateCost(MODELS.haiku, totalIn, totalOut),
  };
}

import type Anthropic from '@anthropic-ai/sdk';
