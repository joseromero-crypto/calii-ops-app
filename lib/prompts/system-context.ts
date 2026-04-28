/**
 * Builds the operating-context system prompt by reading the latest editable
 * sections from `context_sections` + active behavior rules + scope rules +
 * headline examples from the registry. Bumps prompt_version on save (handled
 * elsewhere); here we just assemble the prompt string.
 */

import { createAdminSupabase } from '../supabase-server';

export interface AssembledPrompt {
  prompt: string;
  promptVersion: number;
}

export async function assembleSystemPrompt(): Promise<AssembledPrompt> {
  const sb = createAdminSupabase();

  const [
    { data: ctx },
    { data: rules },
    { data: scopes },
    { data: examples },
    { data: latestVersion },
  ] = await Promise.all([
    sb.from('context_sections').select('title_es, body_md, display_order').order('display_order'),
    sb.from('behavior_rules').select('rule_text, rationale').eq('active', true).order('display_order'),
    sb.from('scope_rules').select('trigger_text, target_team_id, flag_label_es, example_good, example_bad').eq('active', true),
    sb.from('headline_examples').select('kind, text_es, reasoning').eq('active', true),
    sb.from('prompt_versions').select('id').order('id', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const promptVersion = latestVersion?.id ?? 1;

  const lines: string[] = [];
  lines.push('Eres un asistente experto en operaciones de Calii (entrega de supermercado a domicilio en México).');
  lines.push('Tu trabajo es analizar KPIs semanales y producir insights accionables para el equipo de Operaciones.');
  lines.push('');

  lines.push('# Contexto operativo');
  for (const c of ctx ?? []) {
    lines.push(`## ${c.title_es}`);
    lines.push(c.body_md);
    lines.push('');
  }

  lines.push('# Reglas de comportamiento');
  for (const [i, r] of (rules ?? []).entries()) {
    lines.push(`${i + 1}. ${r.rule_text}${r.rationale ? `  _(${r.rationale})_` : ''}`);
  }
  lines.push('');

  lines.push('# Reglas de scope cross-team — flagear, no recomendar');
  for (const s of scopes ?? []) {
    lines.push(`- **${s.flag_label_es}** para: ${s.trigger_text}`);
    if (s.example_good) lines.push(`  - ✅ "${s.example_good}"`);
    if (s.example_bad) lines.push(`  - ❌ "${s.example_bad}"`);
  }
  lines.push('');

  lines.push('# Ejemplos de headlines (few-shot)');
  for (const e of examples ?? []) {
    const tag = e.kind === 'good' ? '✅ GOOD' : '❌ BAD';
    lines.push(`${tag}: ${e.text_es}${e.reasoning ? `  _(${e.reasoning})_` : ''}`);
  }
  lines.push('');

  lines.push('# Output');
  lines.push('Responde SIEMPRE en JSON válido siguiendo el schema que se te indique. Sin texto extra antes o después.');

  return { prompt: lines.join('\n'), promptVersion };
}
