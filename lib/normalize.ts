/**
 * Shared name normaliser — NFD accent strip → lowercase → trim → collapse
 * whitespace. Originally lived only in `validate-identity.ts`; extracted so
 * `lib/tenure.ts` can join on the same normalised key without a second copy
 * diverging (see the hub-alias-map divergence footgun in HANDOFF §12).
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}
