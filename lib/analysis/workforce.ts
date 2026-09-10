/**
 * BUILD.md Phase 2 — attendanceByHub / auxAssemblyLoad.
 * Ported from scripts/investigate-hub.ts's per-hub facts loop.
 */
import type { SB } from './shared';
import { validatedUploads, fetchRowsForUploads, resolveHubId, toNum, ROLE_ACCOUNT_PATTERN, ACTIVE_HUBS } from './shared';
import type { AnalysisResult, Provenance, Claim } from './types';
import { confirmed, assumed, open, NUM_IDLE_DAYS_OPEN_NOTE } from './types';

export type Role = 'armador' | 'repartidor';
interface RoleFileSpec { appId: string; hubField: string; }
const ROLE_FILES: Record<Role, RoleFileSpec> = {
  armador: { appId: 'desempeno_operadores', hubField: 'geofence' },
  repartidor: { appId: 'desempeno_repartidores', hubField: 'hub' },
};

export interface AttendanceRow {
  hub: string;
  role: Role;
  absences_unjustified: number;
  absences_justified_extra: number;
  tardy_unjustified: number;
}

/** Shared row-fetcher — one row per person-week — also used by evidence.ts. */
export async function fetchAttendanceRows(sb: SB, role: Role, weeksBack: number): Promise<AttendanceRow[]> {
  const spec = ROLE_FILES[role];
  const uploads = await validatedUploads(sb, spec.appId, { weeksBack });
  const rows = await fetchRowsForUploads(sb, uploads.map((u) => u.id));
  const out: AttendanceRow[] = [];
  for (const r of rows) {
    const d = r.data;
    const hub = resolveHubId(String(d[spec.hubField] ?? '').trim());
    if (!hub) continue;
    const ab = toNum(d['num_absences']);
    const abj = toNum(d['num_absences_including_justified']);
    const tardy = toNum(d['num_tardy']);
    out.push({
      hub, role,
      absences_unjustified: Number.isFinite(ab) ? ab : 0,
      absences_justified_extra: Number.isFinite(abj) && Number.isFinite(ab) ? Math.max(0, abj - ab) : 0,
      tardy_unjustified: Number.isFinite(tardy) ? tardy : 0,
    });
  }
  return out;
}

export interface HubAttendance {
  hub: string;
  role: Role;
  rows: number;
  absences_unjustified: number;
  absences_justified_extra: number;
  tardy_unjustified: number;
}

export interface AttendanceByHubData {
  weeks_back: number;
  hubs: HubAttendance[];
}

/** Unjustified vs justified absences/tardiness, per hub per role. num_absences is UNJUSTIFIED-only (DATA_DICTIONARY.md, CORRECTED). */
export async function attendanceByHub(sb: SB, weeksBack = 12): Promise<AnalysisResult<AttendanceByHubData>> {
  const allRows: AttendanceRow[] = [];
  for (const role of ['armador', 'repartidor'] as const) allRows.push(...await fetchAttendanceRows(sb, role, weeksBack));

  const byHubRole = new Map<string, HubAttendance>();
  for (const r of allRows) {
    const key = `${r.hub}|${r.role}`;
    const h = byHubRole.get(key) ?? { hub: r.hub, role: r.role, rows: 0, absences_unjustified: 0, absences_justified_extra: 0, tardy_unjustified: 0 };
    h.rows++;
    h.absences_unjustified += r.absences_unjustified;
    h.absences_justified_extra += r.absences_justified_extra;
    h.tardy_unjustified += r.tardy_unjustified;
    byHubRole.set(key, h);
  }
  const results = [...byHubRole.values()].sort((a, b) => a.hub.localeCompare(b.hub) || a.role.localeCompare(b.role));

  const provenance: Provenance = {
    tool: 'attendanceByHub',
    args: { weeksBack },
    source: [
      { file: 'desempeno_operadores', columns: ['num_absences', 'num_absences_including_justified', 'num_tardy'] },
      { file: 'desempeno_repartidores', columns: ['num_absences', 'num_absences_including_justified', 'num_tardy'] },
    ],
    rows_in: allRows.length,
    rows_out: results.length,
    filters: [`last ${weeksBack} weeks`, 'both roles'],
  };

  const worst = [...results].sort((a, b) => b.absences_unjustified - a.absences_unjustified)[0];
  const claims: Claim[] = worst ? [{
    id: 'c1',
    text: `${worst.hub} (${worst.role}): ${worst.absences_unjustified} unjustified absences over ${weeksBack} weeks, the highest of any hub/role`,
    evidence: { kind: 'rows', refetch: { tool: 'attendanceByHub', args: { weeksBack }, predicate: { hub: worst.hub, role: worst.role } }, highlight: ['num_absences'] },
  }] : [];

  return {
    data: { weeks_back: weeksBack, hubs: results },
    confidence: {
      coverage: confirmed(`${results.length} hub/role slices over ${weeksBack} weeks`),
      meaning: confirmed('num_absences is UNJUSTIFIED-only (DATA_DICTIONARY.md, CORRECTED round 2) — do not read it as all absence'),
      statistical: assumed('7 hubs × 2 roles = 14 points at most; cross-hub spread is a lead, not a distribution'),
      causal: confirmed('descriptive counts only — no cause attributed by this function'),
    },
    caveats: [],
    provenance,
    claims,
  };
}

export interface AuxLoadRow {
  hub: string;
  assembler: string;
  is_role_account: boolean;
  num_assembled: number;
  num_idle_days: number | null;
}

/** Shared row-fetcher — one row per armador-week — also used by evidence.ts. */
export async function fetchAuxLoadRows(sb: SB, weeksBack: number): Promise<AuxLoadRow[]> {
  const uploads = await validatedUploads(sb, 'desempeno_operadores', { weeksBack });
  const rows = await fetchRowsForUploads(sb, uploads.map((u) => u.id));
  const out: AuxLoadRow[] = [];
  for (const r of rows) {
    const d = r.data;
    const hub = resolveHubId(String(d['geofence'] ?? '').trim());
    if (!hub) continue;
    const raw = String(d['assembler'] ?? '');
    const asm = toNum(d['num_assembled']);
    const idle = toNum(d['num_idle_days']);
    out.push({ hub, assembler: raw, is_role_account: ROLE_ACCOUNT_PATTERN.test(raw), num_assembled: Number.isFinite(asm) ? asm : 0, num_idle_days: Number.isFinite(idle) ? idle : null });
  }
  return out;
}

export interface HubAuxLoad {
  hub: string;
  assembled_total: number;
  assembled_by_role_accounts: number;
  role_account_share: number;
  idle_days_sum: number;
}

export interface AuxAssemblyLoadData {
  weeks_back: number;
  hubs: HubAuxLoad[];
}

/**
 * Role-account (auxiliar) share of total assembly, per hub. OPS_CONTEXT.md §2:
 * this is a SCHEDULED Mon/Tue/Sun rota, not an emergency signal — a flat
 * cross-hub share does not distinguish rota from deviation (that needs a
 * day-level view this weekly-grain data does not have). Read as a
 * flex-intensity measure, not a stress marker.
 */
export async function auxAssemblyLoad(sb: SB, weeksBack = 12): Promise<AnalysisResult<AuxAssemblyLoadData>> {
  const rows = await fetchAuxLoadRows(sb, weeksBack);

  const byHub = new Map<string, HubAuxLoad>();
  for (const r of rows) {
    const h = byHub.get(r.hub) ?? { hub: r.hub, assembled_total: 0, assembled_by_role_accounts: 0, role_account_share: 0, idle_days_sum: 0 };
    h.assembled_total += r.num_assembled;
    if (r.is_role_account) h.assembled_by_role_accounts += r.num_assembled;
    if (r.num_idle_days !== null) h.idle_days_sum += r.num_idle_days;
    byHub.set(r.hub, h);
  }
  const hubs = [...byHub.values()].map((h) => ({ ...h, role_account_share: h.assembled_total > 0 ? h.assembled_by_role_accounts / h.assembled_total : 0 }))
    .sort((a, b) => a.hub.localeCompare(b.hub));

  const provenance: Provenance = {
    tool: 'auxAssemblyLoad',
    args: { weeksBack },
    source: [{ file: 'desempeno_operadores', columns: ['assembler', 'num_assembled', 'num_idle_days'] }],
    rows_in: rows.length,
    rows_out: hubs.length,
    filters: [`last ${weeksBack} weeks`, `assembler matches ${ROLE_ACCOUNT_PATTERN}`],
  };

  const top = [...hubs].sort((a, b) => b.role_account_share - a.role_account_share)[0];
  const claims: Claim[] = top ? [{
    id: 'c1',
    text: `${top.hub}: role accounts assembled ${(top.role_account_share * 100).toFixed(1)}% of orders over ${weeksBack} weeks, the highest share network-wide`,
    evidence: { kind: 'rows', refetch: { tool: 'auxAssemblyLoad', args: { weeksBack }, predicate: { hub: top.hub, isRoleAccount: true } }, highlight: ['assembler', 'num_assembled'] },
  }] : [];

  return {
    data: { weeks_back: weeksBack, hubs },
    confidence: {
      coverage: confirmed(`${hubs.length}/${ACTIVE_HUBS.length} hubs present`),
      // `data` carries idle_days_sum, which touches num_idle_days — a ❓ OPEN
      // column. BUILD.md Phase 2 test requirement: any function touching it
      // returns meaning: OPEN, wholesale, even though the rest of this
      // result (role-account detection) is independently CONFIRMED.
      meaning: open(
        `role-account detection is CONFIRMED (OPS_CONTEXT.md §2) — but this result also carries ` +
        `idle_days_sum, and ${NUM_IDLE_DAYS_OPEN_NOTE}`
      ),
      statistical: assumed('7 hubs = 7 points; cross-hub comparison is a lead, not a distribution'),
      causal: open(
        'aux-assembly share is a SCHEDULED Mon/Tue/Sun/weekend rota (OPS_CONTEXT.md §2), not an emergency-only signal. ' +
        'The real signal is DEVIATION from the rota, which needs day-level data this function cannot see at weekly grain.'
      ),
    },
    caveats: [
      `num_idle_days is included as idle_days_sum for reference only. ${NUM_IDLE_DAYS_OPEN_NOTE}`,
    ],
    provenance,
    claims,
  };
}
