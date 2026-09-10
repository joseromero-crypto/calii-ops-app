/**
 * BUILD.md Phase 3 — lookupColumn / lookupContext. ASSISTANT_DESIGN.md §4b
 * layer 3: "Everything else in the docs, in full. Fetched by the model, IF
 * it chooses to." A fallback, not where safety comes from (layer 2 — the
 * caveats each lib/analysis/* function already attaches — carries that).
 *
 * Parses DATA_DICTIONARY.md / OPS_CONTEXT.md into a lookup table at first
 * call (cached in-process — these files only change between deploys, and a
 * server process re-reads them on cold start), rather than pasting either
 * document (~100 KB combined) into the system prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Section {
  heading: string;
  /** For DATA_DICTIONARY.md sections nested under a `## \`file\`` heading. */
  fileContext: string | null;
  columnName: string | null;
  status: string | null;
  body: string;
}

const STATUS_MARKERS: [RegExp, string][] = [
  [/✅✅/, 'CONFIRMED (derivation proven)'],
  [/✅/, 'CONFIRMED'],
  [/⚠️⚠️/, 'CORRECTED (major)'],
  [/⚠️/, 'CORRECTED'],
  [/🔶/, 'ASSUMED'],
  [/❓/, 'OPEN'],
];

/** Last matching marker in a heading wins — corrections read as "OLD → NEW", new is authoritative. */
function detectStatus(headingLine: string): string | null {
  let found: string | null = null;
  for (const [re, label] of STATUS_MARKERS) {
    if (re.test(headingLine)) found = label;
  }
  return found;
}

/**
 * Split a markdown file into ## and ### sections. Each section's body is
 * everything up to the next heading of level <= its own. `##` sections
 * become fileContext for any `###` sections nested inside them.
 */
function parseSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let currentFile: string | null = null;
  let current: { level: number; heading: string; bodyLines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const headingMatch = current.heading.match(/`([^`]+)`/);
    sections.push({
      heading: current.heading,
      fileContext: current.level === 3 ? currentFile : null,
      columnName: current.level === 3 && headingMatch ? headingMatch[1] : null,
      status: detectStatus(current.heading),
      body: current.bodyLines.join('\n').trim(),
    });
    current = null;
  };

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      const heading = h2[1].trim();
      const fileMatch = heading.match(/`([^`]+)`/);
      if (fileMatch) currentFile = fileMatch[1];
      current = { level: 2, heading, bodyLines: [] };
    } else if (h3) {
      flush();
      current = { level: 3, heading: h3[1].trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

let dictSections: Section[] | null = null;
let contextSections: Section[] | null = null;

function loadDictionary(): Section[] {
  if (dictSections) return dictSections;
  const raw = readFileSync(join(process.cwd(), 'DATA_DICTIONARY.md'), 'utf-8');
  dictSections = parseSections(raw).filter((s) => s.columnName);
  return dictSections;
}

function loadContext(): Section[] {
  if (contextSections) return contextSections;
  const raw = readFileSync(join(process.cwd(), 'OPS_CONTEXT.md'), 'utf-8');
  contextSections = parseSections(raw);
  return contextSections;
}

export interface ColumnLookupResult {
  found: boolean;
  file: string;
  column: string;
  status: string | null;
  body: string | null;
  /** Populated when no exact match — other columns in the same file, to help the model retry. */
  suggestions?: string[];
}

/** DATA_DICTIONARY.md's `## \`file\`` / `### \`column\` STATUS` entries. */
export function lookupColumn(file: string, column: string): ColumnLookupResult {
  const sections = loadDictionary();
  const norm = (s: string) => s.toLowerCase().trim();
  const exact = sections.find((s) => norm(s.fileContext ?? '') === norm(file) && norm(s.columnName ?? '') === norm(column));
  if (exact) {
    return { found: true, file, column, status: exact.status, body: exact.body };
  }
  // Fall back to column name matching ANY file, in case the model got the file wrong.
  const byColumnOnly = sections.find((s) => norm(s.columnName ?? '') === norm(column));
  if (byColumnOnly) {
    return { found: true, file: byColumnOnly.fileContext ?? file, column, status: byColumnOnly.status, body: byColumnOnly.body };
  }
  const suggestions = sections
    .filter((s) => norm(s.fileContext ?? '') === norm(file))
    .map((s) => s.columnName!)
    .slice(0, 20);
  return { found: false, file, column, status: null, body: null, suggestions };
}

export interface ContextLookupResult {
  found: boolean;
  topic: string;
  matches: { heading: string; body: string }[];
}

/** OPS_CONTEXT.md's ## / ### sections — simple substring match on the heading, up to 3 best matches. */
export function lookupContext(topic: string): ContextLookupResult {
  const sections = loadContext();
  const norm = (s: string) => s.toLowerCase();
  const needle = norm(topic);
  const scored = sections
    .map((s) => ({ s, score: norm(s.heading).includes(needle) ? 2 : norm(s.body).includes(needle) ? 1 : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return {
    found: scored.length > 0,
    topic,
    matches: scored.map((x) => ({ heading: x.s.heading, body: x.s.body })),
  };
}
