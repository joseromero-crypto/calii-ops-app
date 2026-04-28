import Papa from 'papaparse';
import type { AppColumn } from './types';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  errors: Papa.ParseError[];
}

/**
 * Parse a CSV string with Papa, returning typed rows keyed by header.
 * Strips a UTF-8 BOM if present (Retool exports include one).
 */
export function parseCsv(text: string): ParsedCsv {
  // Strip BOM
  const cleaned = text.startsWith('﻿') ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
    errors: result.errors,
  };
}

/**
 * Coerce a raw string cell into the declared column type. Returns either
 * the typed value or `null` for unparsable / empty strings.
 */
export function coerce(raw: string | null | undefined, type: AppColumn['type']): unknown {
  if (raw == null || raw === '' || raw === 'null' || raw === 'NaN' || raw === 'Infinity') {
    return null;
  }
  switch (type) {
    case 'string':
      return raw;
    case 'int': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'float': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return /^true$/i.test(raw) ? true : /^false$/i.test(raw) ? false : null;
    case 'datetime': {
      const t = Date.parse(raw);
      return Number.isFinite(t) ? new Date(t).toISOString() : raw; // keep raw if unparsable
    }
    case 'json':
      try { return JSON.parse(raw); } catch { return raw; }
    case 'list':
      // Retool emits "[1,2,3]" or "[\"a\",\"b\"]". Try JSON; fall back to comma split.
      try { const x = JSON.parse(raw); return Array.isArray(x) ? x : [x]; } catch { /* noop */ }
      return raw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Apply the app's column schema to coerce all rows.
 */
export function coerceRows(rows: Record<string, string>[], cols: AppColumn[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of cols) {
      out[c.name] = coerce(row[c.name], c.type);
    }
    return out;
  });
}
