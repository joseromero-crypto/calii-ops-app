/**
 * SKU category classifier for MNA products.
 *
 * Uses a two-tier approach:
 *   1. Supplier (Proveedor) — most reliable signal, built from the full catalog.
 *   2. Product name keywords — fallback for unknown or shared suppliers.
 *
 * IMPORTANT: "Carnes" in Calii's taxonomy means REFRIGERATED / COLD-CHAIN,
 * not just meat. It includes dairy (crema, queso, yogurt), frozen items
 * (helados, congelados), fresh bakery, refrigerated ready meals, and seafood.
 * A keyword-only approach would misclassify hundreds of SKUs — supplier is the
 * primary signal.
 *
 * Categories:
 *   'fyv'       → Frutas y Verduras (fresh produce + eggs)
 *   'carnes'    → Refrigerated / cold-chain (dairy, meats, frozen, deli)
 *   'abarrotes' → Shelf-stable / dry goods  ← DEFAULT for unknowns
 *
 * Coverage from catalog data (4,925 total SKUs):
 *   FyV: 6 exclusive suppliers → 100% of 161 FyV SKUs covered by supplier alone
 *   Carnes: 57 exclusive suppliers → covers ~600 Carnes SKUs by supplier alone
 *   Shared suppliers (21): keyword disambiguation handles the split
 *   Unknown supplier: default to abarrotes (correct ~79% of the time)
 */

export type MnaCategory = 'carnes' | 'fyv' | 'abarrotes';

// ── Tier 1a: Exclusive FyV suppliers ─────────────────────────────────────────
// Every SKU from these suppliers is Frutas y Verduras. 100% accurate.

const FYV_SUPPLIERS = new Set([
  'MA',               // 122 items — main fresh produce supplier
  'Mr. Lucky',        // 22 items — packaged salads, pre-cut veg
  'Food Solutions',   // 6 items  — organic packaged produce
  'Bachoco Huevo',    // 4 items  — eggs
  'Granjas Orespi',   // 4 items  — eggs
  'D&L Huevo',        // 3 items  — eggs
]);

// ── Tier 1b: Exclusive Carnes suppliers ──────────────────────────────────────
// Every SKU from these suppliers is Carnes (refrigerated/cold-chain).

const CARNES_SUPPLIERS = new Set([
  'Diver Alimentos',               // 55 items
  'Qualtia',                       // 36 items
  'Único',                         // 26 items
  'Helados Holanda',               // 23 items
  'CAFISON',                       // 22 items
  'Europastry',                    // 22 items
  'Lyncott',                       // 18 items
  'Calii Kitchen',                 // 17 items
  'Grupo Piscimex',                // 15 items
  'Proveedora HyH',                // 12 items
  'Mr Tofu',                       // 11 items
  'Bebida Viva',                   // 11 items
  'Proboca',                       // 10 items
  'El Charal',                     // 10 items
  'Saboregio',                     // 10 items
  'Helados Nestlé',                // 10 items
  'Laben',                         // 10 items
  'Yakult MTY',                    // 9 items
  'Alimentos Saludables Valle',    // 9 items
  'Flora',                         // 9 items
  'Bachoco Congelados Natural',    // 8 items
  'Calii Kitchen Postres',         // 8 items
  'Dialsa Foods',                  // 8 items
  'Kowi',                          // 8 items
  'Eatics',                        // 8 items
  'Mexideli',                      // 8 items
  'Tyson',                         // 7 items
  'PROAN Cerdo',                   // 7 items
  'Carnes Cantú',                  // 7 items
  'Aires de Campo',                // 7 items
  'Bachoco Congelados',            // 6 items
  'Natureganix Congelados',        // 6 items
  'Camanchaca',                    // 6 items
  'Kool Farming',                  // 6 items
  'Corganic',                      // 6 items
  'Alco',                          // 6 items
  'Cremería Americana',            // 6 items
  'Cremería San José',             // 6 items
  'Tribu Natural',                 // 5 items
  'RGB Foods',                     // 5 items
  'Ultraorganics',                 // 5 items
  'Milive Orgánicos de México',    // 5 items
  'Bekax Congelado',               // 5 items
  'Peñaranda',                     // 4 items
  'Wica',                          // 4 items
  'Wafflus',                       // 4 items
  'Bachoco Cerdo Congelado',       // 3 items
  'Ahumados Noruegos',             // 3 items
  'Congelados Alysa',              // 3 items
  'Bacomsa',                       // 3 items
  'Triangular Concept',            // 3 items
  'Las Sevillanas',                // 2 items
  'D&L Claras',                    // 2 items
  'Amor a Mar',                    // 2 items
  'Tío Baldo',                     // 2 items
  'Salsa Pa Todo',                 // 1 item
  'Ah Masa!',                      // 1 item
]);

// ── Tier 1c: Shared suppliers — Carnes dominant ───────────────────────────────
// These suppliers sell to both Carnes and Abarrotes but Carnes is the majority.
// Default guess is Carnes; overridden to Abarrotes only when a strong
// shelf-stable keyword signal is present in the product name.

const SHARED_CARNES_DOMINANT = new Set([
  'Sigma eCommerce',          // 89% Carnes (92c / 11a)
  'LALA',                     // 65% Carnes (51c / 27a) — cremas, yogurts vs leche UHT
  'Alpura',                   // 52% Carnes (25c / 23a) — cremas vs leche UHT
  'Danone',                   // 83% Carnes (25c / 5a)  — Activia, Danonino vs Silk UHT
  'Fudsend',                  // 85% Carnes (28c / 5a)  — Chobani, salmon noruego
  'Bafar',                    // 97% Carnes (31c / 1a)  — Griller's, embutidos
  'Operadora Orca',           // 72% Carnes (13c / 5a)  — mantequilla, quesos vs condimentos
  'Interdeli',                // 92% Carnes (11c / 1a)  — hummus, jocoque, pan pita fresco
  'Comercial Hispana',        // 65% Carnes (11c / 6a)  — acaí, lasagna, mantequilla
  'Cremería Aguascalientes',  // 86% Carnes (6c / 1a)   — quesos, crema
  'Praderas Huastecas',       // 67% Carnes (6c / 3a)   — carnes frescas vs carne seca
  'Sta Evelia',               // 80% Carnes (4c / 1a)   — dip jocoque vs pita chips
  'NotCo',                    // 67% Carnes (4c / 2a)   — hamburguesas, nuggets vs NotMilk
  'Alimentos Trad',           // 40% Carnes (2c / 3a)   — fruta congelada vs snacks secos
]);

// ── Tier 2: Keyword signals ───────────────────────────────────────────────────
// Applied when supplier is unknown (Abarrotes default) or in SHARED_CARNES_DOMINANT
// (Carnes default, overrideable).

/**
 * Product name tokens that indicate refrigerated/cold-chain → Carnes.
 * Sourced from actual shared-supplier product names where keywords reliably
 * distinguish the refrigerated item from its shelf-stable counterpart.
 */
const CARNES_NAME_SIGNALS = [
  // Dairy — refrigerated
  'crema acida', 'crema agria', 'crema para cafe', 'crema lyncott',
  'yoghurt', 'yogurt',
  'jocoque',
  'mantequilla',
  'queso',
  'alimento lacteo', 'alimento lácteo',
  // Frozen
  'helado', 'nieve', 'paleta',
  'congelad',
  // Fresh seafood (vs canned)
  'salmon fresco', 'salmón fresco', 'sashimi', 'cevichero', 'noruego',
  // Refrigerated dips / deli
  'hummus', 'dip jocoque', 'jocoque seco',
  // Refrigerated dairy desserts
  'flan', 'arroz con leche',
  // Refrigerated coffee drinks (Café Olé 281ml from Sigma)
  'cafe capuccino', 'café capuccino',
  // Fresh bread / tortillas (refrigerated section)
  'pan pita',
  'tortillas de harina sin gluten', 'tortillas de harina multigrano',
  // Frozen fruit / acaí
  'acai', 'acaí',
  'fresa congelada', 'mora azul congelada',
  // Smoked refrigerated fish
  'salmon ahumado', 'salmón ahumado',
];

/**
 * Product name tokens that indicate shelf-stable → Abarrotes.
 * Used to override the Carnes default for shared/dominant-Carnes suppliers
 * (e.g. LALA UHT milk, Praderas carne seca, Pinsa canned tuna).
 */
const ABARROTES_NAME_SIGNALS = [
  // Shelf-stable packaging indicators
  'en lata', 'en aceite', 'pouch', 'cup can',
  // Shelf-stable milk (vs refrigerated crema/yogurt from same suppliers)
  'leche deslactosada', 'leche entera', 'leche de almendra',
  'leche de avena', 'leche de coco', 'leche de soya',
  'leche light', 'leche orgánica', 'leche organica',
  'leche barista', 'leche vegetal',
  // Canned / preserved meats
  'carne seca', 'chilorio', 'cochinita pibil', 'cochinita',
  // Shelf-stable snacks
  'chips de', 'stick de', 'churritos',
  // Dry / powdered cheese
  'parmesano molido',
  // Shelf-stable dips / crackers
  'pita crisp', 'pita chips',
];

// ── Normalizer ────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// ── Public classifier ─────────────────────────────────────────────────────────

/**
 * Classify a single MNA product into its assembly category.
 *
 * @param nombre    Product name as it appears in the MNA CSV "Producto" column.
 * @param proveedor Supplier name as it appears in the MNA CSV "Proveedor" column.
 *                  Pass empty string if not available — classification falls back
 *                  to keywords only (less accurate).
 */
export function classifyMnaProduct(
  nombre: string,
  proveedor: string,
): MnaCategory {
  // ── Tier 1a: Exclusive FyV supplier ─────────────────────────────────────
  if (FYV_SUPPLIERS.has(proveedor)) return 'fyv';

  // ── Tier 1b: Exclusive Carnes supplier ──────────────────────────────────
  if (CARNES_SUPPLIERS.has(proveedor)) return 'carnes';

  const n = norm(nombre);

  // ── Tier 1c: Shared supplier — Carnes dominant ──────────────────────────
  // Default to Carnes; only flip to Abarrotes if a strong shelf-stable signal
  // is present in the name (e.g. LALA "leche deslactosada" → abarrotes).
  if (SHARED_CARNES_DOMINANT.has(proveedor)) {
    const shelfStable = ABARROTES_NAME_SIGNALS.some((k) => n.includes(norm(k)));
    return shelfStable ? 'abarrotes' : 'carnes';
  }

  // ── Tier 2: Unknown supplier — keyword driven ────────────────────────────
  // Abarrotes is the correct prior for unknown suppliers (79% of catalog).
  // Only override to Carnes when a refrigerated signal is found AND no
  // stronger shelf-stable signal contradicts it.
  const coldChain  = CARNES_NAME_SIGNALS.some((k)    => n.includes(norm(k)));
  const shelfStable = ABARROTES_NAME_SIGNALS.some((k) => n.includes(norm(k)));

  if (coldChain && !shelfStable) return 'carnes';
  return 'abarrotes';
}
