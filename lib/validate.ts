import type { AppColumn, ValidationReport, ValidationIssue } from './types';
import { coerce } from './parse';

export interface ValidateInput {
  appId: string;
  expectedColumns: AppColumn[];
  csvHeaders: string[];
  rows: Record<string, string>[];
  /** Most recent uploaded rows for this (app, city, hub) — used for distribution check. */
  rollingNumericMeans?: Record<string, { mean: number; stddev: number }>;
}

/**
 * Three-layer validation — proposal §4.3:
 *  1. Header check (hard fail on missing required columns)
 *  2. Type check (sample 50 rows, fail if >5% mismatch)
 *  3. Distribution check (vs rolling 4-week mean of prior accepted uploads)
 */
export function validateUpload(input: ValidateInput): ValidationReport {
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];

  const expected = input.expectedColumns;
  const expectedNames = new Set(expected.map((c) => c.name));
  const csvHeaderSet = new Set(input.csvHeaders);

  // 1. Header check
  let schemaMatch: ValidationReport['schema_match'] = 'exact';

  for (const col of expected) {
    if (!csvHeaderSet.has(col.name) && col.required) {
      errors.push({
        code: 'missing_required_column',
        field: col.name,
        message: `Falta columna requerida: ${col.name}`,
      });
      schemaMatch = 'mismatch';
    }
  }
  for (const h of input.csvHeaders) {
    if (!expectedNames.has(h)) {
      warnings.push({ code: 'extra_column', field: h, message: `Columna extra (será ignorada): ${h}` });
      if (schemaMatch === 'exact') schemaMatch = 'partial';
    }
  }

  if (schemaMatch === 'mismatch') {
    return { warnings, errors, schema_match: schemaMatch };
  }

  // 2. Type check — sample first 50 rows
  const sample = input.rows.slice(0, Math.min(50, input.rows.length));
  let mismatches = 0;
  for (const [rowIndex, row] of sample.entries()) {
    for (const col of expected) {
      if (col.role === 'ignored') continue;
      const raw = row[col.name];
      if (raw === undefined || raw === '') continue;
      const parsed = coerce(raw, col.type);
      const expectedNonNull = col.required && (col.type === 'int' || col.type === 'float' || col.type === 'bool' || col.type === 'datetime');
      if (parsed === null && expectedNonNull) {
        mismatches += 1;
        if (mismatches <= 5) {
          errors.push({
            code: 'type_mismatch',
            field: col.name,
            message: `Valor "${String(raw).slice(0, 40)}" no parsea a ${col.type}`,
            sample_row_index: rowIndex,
          });
        }
      }
    }
  }
  const mismatchRatio = sample.length > 0 ? mismatches / (sample.length * expected.length) : 0;
  if (mismatchRatio > 0.05) {
    errors.push({
      code: 'type_mismatch_threshold_exceeded',
      message: `${(mismatchRatio * 100).toFixed(1)}% de los valores fallaron el type check (máximo 5%).`,
    });
  }

  // 3. Distribution check (warning, not error) — compare key numeric columns vs rolling mean
  const distChecks: NonNullable<ValidationReport['rolling_distribution_check']> = [];
  if (input.rollingNumericMeans) {
    for (const col of expected) {
      if (col.type !== 'int' && col.type !== 'float') continue;
      const rolling = input.rollingNumericMeans[col.name];
      if (!rolling || rolling.stddev === 0) continue;
      const values = input.rows
        .map((r) => coerce(r[col.name], col.type))
        .filter((v): v is number => typeof v === 'number');
      if (values.length === 0) continue;
      const currentMean = values.reduce((a, b) => a + b, 0) / values.length;
      const z = (currentMean - rolling.mean) / rolling.stddev;
      distChecks.push({
        column: col.name,
        z_score: Number(z.toFixed(2)),
        rolling_mean: rolling.mean,
        current_value: currentMean,
        flag: Math.abs(z) > 3 ? 'shift' : 'ok',
      });
      if (Math.abs(z) > 3) {
        warnings.push({
          code: 'distribution_shift',
          field: col.name,
          message: `${col.name}: media actual ${currentMean.toFixed(2)} vs rolling ${rolling.mean.toFixed(2)} (z=${z.toFixed(1)}). ¿Archivo correcto?`,
        });
      }
    }
  }

  return {
    warnings,
    errors,
    schema_match: schemaMatch,
    rolling_distribution_check: distChecks.length > 0 ? distChecks : undefined,
  };
}
