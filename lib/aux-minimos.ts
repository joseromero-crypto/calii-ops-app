/**
 * Mínimo semanal de pedidos armados por puesto de auxiliar (+ coordinador).
 *
 * Editable from /config (tables aux_minimos + aux_hub_settings, migration
 * 20261027000001). Resolution per hub × puesto: hub row → global row → the
 * code defaults below, which are ONLY a fallback for an empty/unreachable
 * table — the migration seeds the same numbers so the DB is the live source.
 *
 * Defaults = José's "Armado auxiliares" sheet (2026-10-27). Weekly totals —
 * Domingo / Lunes rota windows roll up into one number per position. A
 * Sunday + Monday aux de inventarios is covered by the weekly 9 as-is
 * (sheet footnote: "con que arme los 9 pedidos del domingo es suficiente").
 *
 * Purpose: a weekly nudge to coordinators that EVERY auxiliar is assembling.
 * Shown in the "Generar reporte" Slack text (components/GenerarReporte.tsx →
 * app/api/generar-reporte/route.ts).
 *
 * Counts come from the pedidos_armados peer rows (desempeno_operadores
 * num_assembled per assembler account) — the same source the report already
 * uses for "[N pedidos]" context. Never re-read upload_rows for this.
 */

export type AuxPosition =
  | 'lider_dia'
  | 'lider_tarde'
  | 'calidad'
  | 'recibo'
  | 'inventarios'
  | 'coordinador';

export const AUX_POSITION_LABEL: Record<AuxPosition, string> = {
  lider_dia:   'Líder turno día',
  lider_tarde: 'Líder turno tarde',
  calidad:     'Aux. calidad',
  recibo:      'Aux. recibo',
  inventarios: 'Aux. inventarios',
  coordinador: 'Coordinador',
};

/** Display order in the report. */
export const AUX_POSITION_ORDER: AuxPosition[] = [
  'lider_dia', 'lider_tarde', 'inventarios', 'calidad', 'recibo', 'coordinador',
];

// ─── Config (DB rows) ────────────────────────────────────────────────────────

export interface AuxMinimoDbRow {
  position: AuxPosition;
  scope_level: 'global' | 'hub';
  scope_key: string | null;
  minimo: number;
}

export interface AuxHubSettingDbRow {
  hub_id: string;
  tiene_recibo: boolean;
}

export interface AuxConfig {
  minimos: AuxMinimoDbRow[];
  hubSettings: AuxHubSettingDbRow[];
}

export const EMPTY_AUX_CONFIG: AuxConfig = { minimos: [], hubSettings: [] };


// ─── Code fallbacks ──────────────────────────────────────────────────────────

/** Weekly minimum, every hub unless overridden below. */
export const DEFAULT_MINIMO: Record<AuxPosition, number> = {
  lider_dia:   5,
  lider_tarde: 5,
  calidad:     9,
  recibo:      9,
  inventarios: 9,
  coordinador: 5,
};

/** Per-hub overrides. Contry's aux de inventarios assembles 6–10am Monday (4h, 18 pedidos). */
const HUB_MINIMO_OVERRIDE: Partial<Record<string, Partial<Record<AuxPosition, number>>>> = {
  mh_contry: { inventarios: 18 },
};

/**
 * Hubs that staff a separate aux de recibo (5-aux hubs). Everywhere else the
 * receiving/FyV auxiliar IS the aux de calidad — OPS_CONTEXT.md §2.
 */
const DEFAULT_HUBS_WITH_RECIBO = new Set(['mh_zapopan', 'mh_condesa']);

// ─── Resolution ──────────────────────────────────────────────────────────────

export function tieneRecibo(hubId: string, config: AuxConfig): boolean {
  const row = config.hubSettings.find((h) => h.hub_id === hubId);
  return row ? row.tiene_recibo : DEFAULT_HUBS_WITH_RECIBO.has(hubId);
}

export function expectedPositions(hubId: string, config: AuxConfig): AuxPosition[] {
  const recibo = tieneRecibo(hubId, config);
  return AUX_POSITION_ORDER.filter((p) => p !== 'recibo' || recibo);
}

/** Global minimum: DB global row → code default. */
export function globalMinimo(position: AuxPosition, config: AuxConfig): number {
  const g = config.minimos.find((r) => r.position === position && r.scope_level === 'global');
  return g ? Number(g.minimo) : DEFAULT_MINIMO[position];
}

/**
 * Hub × puesto: DB hub row → DB global row → code hub override → code default.
 * The code hub override only applies when the table has NO rows at all (DB
 * unreachable / migration not run) — once a global row exists, a blank hub
 * cell in /config means "use the global", exactly as it reads on screen.
 */
export function auxMinimo(hubId: string, position: AuxPosition, config: AuxConfig): number {
  const h = config.minimos.find((r) => r.position === position && r.scope_level === 'hub' && r.scope_key === hubId);
  if (h) return Number(h.minimo);
  if (config.minimos.length === 0) {
    return HUB_MINIMO_OVERRIDE[hubId]?.[position] ?? DEFAULT_MINIMO[position];
  }
  return globalMinimo(position, config);
}

// ─── Account name → position ─────────────────────────────────────────────────
//
// Hubs name these accounts themselves, so match on the ROLE words only — the
// hub comes from the geofence column, never from the name. Observed:
//   "Auxiliar Turno Matutino Avícola (\"ATM\")", "Auxiliar Inventarios Gpe
//   (\"Aux. inv. Gpe\")", "Auxiliar Recepción Zapopan (\"Angel\")",
//   "Coordinador MH SN (\"Coord MH\")"
// plus the variants José listed: aux turno / lider dia / vespertino /
// aux turno tarde / aux de recepción y calidad.
//
// Gate first, so a regular armador whose surname happens to end in "dia"
// (Lidia, Candia…) or contains "Calidad" can never be classified.

const ROLE_GATE = /auxiliar|\baux\b|l[ií]der|coordinad|\bturno\b|matutin|vespertin/i;

/** Order matters: "turno tarde" before generic "turno", "recepción y calidad" → calidad. */
const POSITION_RULES: [RegExp, AuxPosition][] = [
  [/coordinad|\bcoord\b/i,                       'coordinador'],
  [/vespertin|\btarde\b/i,                       'lider_tarde'],
  [/matutin|\bd[ií]a\b/i,                        'lider_dia'],
  [/calidad/i,                                   'calidad'],
  [/recib|recepci/i,                             'recibo'],
  [/inventari|\binv\b/i,                         'inventarios'],
  [/\bturno\b|l[ií]der/i,                        'lider_dia'], // "Aux turno", "Líder" with no shift → día
];

export function classifyAuxAccount(name: string): AuxPosition | null {
  const n = name.normalize('NFC');
  if (!ROLE_GATE.test(n)) return null;
  for (const [re, pos] of POSITION_RULES) if (re.test(n)) return pos;
  return null;
}

// ─── Weekly check ────────────────────────────────────────────────────────────

export interface AuxMinimoRow {
  position: AuxPosition;
  label: string;
  minimo: number;
  /** Sum across every account mapped to this position (duplicate logins add up). */
  armados: number;
  /** Accounts that fed this position this week; empty = no row in desempeño operadores. */
  accounts: string[];
  cumple: boolean;
}

/**
 * @param assembledByAccount  entity_key → pedidos_armados for ONE hub, ONE week
 *                            (within_hub peer rows).
 */
export function checkAuxMinimos(
  hubId: string,
  assembledByAccount: Map<string, number | null>,
  config: AuxConfig,
): AuxMinimoRow[] {
  const recibo = tieneRecibo(hubId, config);
  const byPos = new Map<AuxPosition, { armados: number; accounts: string[] }>();
  for (const [account, value] of assembledByAccount) {
    let pos = classifyAuxAccount(account);
    if (!pos) continue;
    // 4-aux hubs: the receiving auxiliar IS the aux de calidad, whatever the
    // account is called ("Auxiliar Recibo Contry" — OPS_CONTEXT.md §2).
    if (pos === 'recibo' && !recibo) pos = 'calidad';
    const e = byPos.get(pos) ?? { armados: 0, accounts: [] };
    e.armados += typeof value === 'number' && Number.isFinite(value) ? value : 0;
    e.accounts.push(account);
    byPos.set(pos, e);
  }
  return expectedPositions(hubId, config).map((position) => {
    const e = byPos.get(position) ?? { armados: 0, accounts: [] };
    const minimo = auxMinimo(hubId, position, config);
    return {
      position,
      label: AUX_POSITION_LABEL[position],
      minimo,
      armados: e.armados,
      accounts: e.accounts,
      cumple: e.armados >= minimo,
    };
  });
}
