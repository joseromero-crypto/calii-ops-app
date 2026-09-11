# BUGS.md — calii-ops-app

Running bug list for Claude Code. Jose appends new bugs at the bottom under
**Pendientes**; each one gets promoted into a numbered section with root cause
and acceptance criteria before it's worked.

## Cómo usar

From the repo root, in Claude Code:

```
Read BUGS.md and fix every bug marked OPEN. Follow the acceptance criteria
exactly. Run `npm run typecheck` and `npm run lint` when done.
```

## Reglas de la sesión

- `app/(app)/historicos/page.tsx` **sí se toca** — la causa raíz de BUG-1 está
  en la paginación de ese archivo (ver BUG-1a).
- ⚠️ **Actualizado (sesión 16, 2026-09-11 — `HANDOFF.md` §26).** Ese archivo se
  reescribió: ahora **trae datos por pestaña** (`searchParams.tab`) y ya no
  todo en cada request. Dos consecuencias para cualquier fix de este archivo:
  - `sinceIso` (51 semanas) **sigue igual y sigue sin tocarse** para
    `snapshots` — alcanza para todos los rangos de BUG-2, no se necesita query
    nueva.
  - Pero `assemblerTrend` / `driverTrend` **ya NO traen 51 semanas**: usan
    `trendWindowStart()`, las últimas 8 semanas con upload de roster validado
    (las gráficas dibujan `slice(-5)`). Medido: 22450 → 7512 y 8942 → 2975
    filas. **No lo "restaures" a 51 semanas** pensando que es un bug; y si un
    fix necesita más historia en las gráficas WoW, sube `TREND_WEEKS`, no el
    rango entero.
  - `mnaProducts` / `faltantesSkuProducts` **ya no son props de `page.tsx`**.
    Viven en `app/api/historicos/mna-products/route.ts`, se piden por hub
    desde `PorHubTab` después del primer paint y se cachean por hub.
- Do not "fix" things that aren't listed here. Minimal, surgical diffs.
- Keep the existing visual language (Tailwind classes, `var(--line)`,
  `var(--ink)`, `var(--muted)`, `shadow-soft`, `rounded-xl`).
- After each bug: `npm run typecheck` must pass with zero errors, then
  `npm run lint`. Do not declare a bug done before both pass.
- Mark each bug `DONE` in this file when finished (leave the section, just
  flip the status line).

## Archivos en juego

| Archivo | Qué contiene |
|---|---|
| `app/(app)/historicos/PorHubTab.tsx` | La pestaña "Por hub". Todo BUG-1 y BUG-2 vive aquí. |
| ↳ `WowChart` (~línea 950) | El componente de gráfica de líneas por persona. **Aquí está la causa raíz de BUG-1.** |
| ↳ `AssemblerWowSection` (~línea 1139) | Sección Armadores: 7 gráficas + filtro multiselect. |
| ↳ `DriverWowSection` (~línea 1243) | Sección Repartidores: 4 gráficas + filtro multiselect. |
| ↳ `WowTooltip` (~línea 840) | Tooltip que lista a todas las personas seleccionadas. |
| ↳ `MultiSelectDropdown` (~línea 745) | El dropdown de filtro de personas. |
| `app/(app)/historicos/ResumenCharts.tsx` (~línea 16) | **Patrón de referencia** para el selector de rango (`TIME_RANGES`). Cópialo. |
| `app/(app)/historicos/PorKpiTab.tsx` (~línea 366) | Segundo ejemplo del mismo selector de rango. |

---

# Principio rector — un solo origen por valor

**Regla de Jose, y aplica a todos los bugs de este archivo, presentes y futuros:**

> "Toda la información debería leerse igual. Si leo que Jose tiene 5 errores en
> una sección o página y veo lo mismo en otra sección, no solo debe ser 5 —
> debe venir **del mismo lugar**. Si no, es un error esperando a pasar."

Es la regla correcta y es la enfermedad de fondo: BUG-1a no fue un descuido
aislado, fue posible **porque el mismo valor viaja por dos tuberías distintas**.
Mientras existan dos caminos, uno se va a romper en silencio y nadie se entera
hasta que un número no cuadra en una junta.

Dos números iguales por coincidencia no son consistencia. Son dos rutas que
todavía no divergen.

## Cómo se aplica en la práctica

Para cualquier valor que aparezca en más de una pantalla:

1. **Un fetch.** Una query, un paginador, un dedupe. No dos queries a la misma
   tabla con filtros distintos.
2. **Una derivación.** Un accessor con nombre. Si "errores de Jose esta semana"
   se calcula, se calcula en **una** función que todos importan.
3. **Un formato.** Una función de conversión a unidades de display, una de
   delta, una de redondeo.
4. **Prohibido recalcular localmente "solo para esta vista".** Si un accessor
   no da lo que la vista necesita, se extiende el accessor — no se escribe una
   segunda versión adentro del componente.

## El patrón ya existe en este repo — replícalo, no inventes otro

El código ya hace esto bien en varios lados, y esos son el molde:

- `lib/kpi-direction.ts` → `effectiveDirection()`. Un solo lugar decide si
  "arriba es bueno". Lo usan ComparativaTab, PorKpiTab, config y los tiles.
- `lib/hub-aliases.ts` → `resolveHubId()`. Compartido con `kpi-compute.ts`.
- `_shared.ts` → `RESUMEN_CATEGORY` / `isResumenKpi`, con el comentario
  *"Single source of truth for the exclusion applied everywhere else"*.
- `_shared.ts` → `resolveTarget` / `meetsTarget` / `isBelowTarget`, con
  *"the one place that converts"* para unidades de meta.

El instinto ya estaba. Lo que falta es aplicarlo de forma pareja. Ver BUG-3.


---

# BUG-1 — Las gráficas de "Por hub" no grafican a todas las personas · OPEN

## Síntoma (palabras de Jose)

> "en la pestaña por hub las gráficas no están graficando bien, algunas tienen
> solo un par de nombres, algunas tienen uno, algunas tienen todos, y en algunos
> hubs cuando intento filtrar simplemente desaparecen."

Y el dato que identifica la causa raíz:

> "en los flip cards de KPI puedo ver muchos más nombres que en la última
> semana graficada."

Eso descarta que sea un problema de "quién estuvo presente la última semana":
**los datos sí tienen a esa gente, las gráficas no los reciben.**

Tres fallas distintas:

- **1a.** Cada gráfica muestra un conjunto arbitrario y distinto de nombres.
  Una muestra 8 armadores, la de al lado 1, otra todos. **Causa: paginación
  inestable en el servidor — se están perdiendo filas silenciosamente.**
- **1b.** Al filtrar personas, tarjetas completas **desaparecen de la página**.
- **1c.** Filtro de "última semana" en el cliente que borra a gente con historia.

---

## 1a — CAUSA RAÍZ: paginación inestable en `page.tsx` (pierde filas)

Los flip cards y las gráficas leen **de la misma tabla** (`peer_comparisons`)
pero por **dos queries distintas**, y solo una está paginada correctamente.

### La query correcta (flip cards) — `page.tsx` líneas ~152–170

```ts
.eq('week_start', currentWeek)
// Four-column sort guarantees a stable total order across pages.
// With only entity_type, rows within each type are in heap order which
// can shift between requests (VACUUM, concurrent writes), causing
// OFFSET pagination to skip or duplicate rows.
.order('entity_type',  { ascending: true })
.order('kpi_id',       { ascending: true })
.order('scope_type',   { ascending: true })
.order('scope_key',    { ascending: true, nullsFirst: false })
.order('entity_key',   { ascending: true })
.range(i * PAGE, (i + 1) * PAGE - 1)
```

El comentario que ya está en el código describe **exactamente** el bug que
tenemos — pero la lección no se aplicó a las otras dos queries.

### Las queries rotas (las gráficas) — `page.tsx` líneas ~195–230

`assemblerTrend` y `driverTrend`:

```ts
.eq('entity_type', 'operator')      // o 'driver'
.eq('scope_type', 'within_hub')
.gte('week_start', sinceIso)
.lte('week_start', currentWeek)
.order('week_start', { ascending: true })   // ← ÚNICO criterio de orden
.range(i * PAGE, (i + 1) * PAGE - 1)
```

`week_start` **no es único**: dentro de una misma semana hay cientos de filas
(persona × KPI) que empatan. PostgreSQL no garantiza ningún orden entre filas
empatadas, y estas páginas se piden **en paralelo** (`Promise.all`), cada una
como un request independiente. El orden dentro de cada semana puede diferir
entre requests → los `range()` se **enciman y se saltan filas**.

`PAGE = 1000` (línea 16). Con 51 semanas × 7 KPIs de armador × todos los
operadores, `assemblerTrendTotal` son decenas de miles de filas = **decenas de
páginas**. Cada frontera de página es una oportunidad de perder filas.

Esto explica todo lo que Jose ve, y lo que mi diagnóstico anterior no explicaba:

- Por qué el conjunto de nombres es **arbitrario y distinto por gráfica** — se
  pierden filas al azar, no según una regla.
- Por qué **los flip cards tienen más nombres** — esa query sí ordena estable.
- Por qué **varía por hub** — depende de dónde caen las fronteras de página.
- Por qué a veces "algunas tienen todos" — hubs cuyas filas cayeron completas
  dentro de una página.

### Y hay una tercera query con el mismo defecto

`kpi_snapshots`, `page.tsx` líneas ~136–150:

```ts
.order('week_start', { ascending: true })   // ← mismo problema
```

51 semanas × ~20 KPIs × (hubs + ciudades + global) también pasa de 1000 filas.
Los tiles, las sparklines de 12 semanas y el promedio de 4 semanas están
comiendo del mismo plato roto. **Arréglalo en la misma pasada.**

### Fix requerido

1. Agrega un orden **total y determinista** a las tres queries paginadas. Para
   `assemblerTrend` / `driverTrend`:

   ```ts
   .order('week_start',  { ascending: true })
   .order('kpi_id',      { ascending: true })
   .order('scope_key',   { ascending: true, nullsFirst: false })
   .order('entity_key',  { ascending: true })
   ```

   Para `kpi_snapshots`:

   ```ts
   .order('week_start',  { ascending: true })
   .order('kpi_id',      { ascending: true })
   .order('scope_level', { ascending: true })
   .order('scope_key',   { ascending: true, nullsFirst: false })
   ```

   La combinación debe ser única por fila. Si el esquema tiene una PK expuesta,
   agrégala como último criterio de desempate y listo.

2. **Guarda de integridad.** Después de aplanar las páginas, compara contra el
   `count` que ya se pidió en el Step 3 y que ya está en variables
   (`assemblerTrendTotal`, `driverTrendTotal`, `snapTotal`):

   ```ts
   if (allAssemblerTrend.length !== assemblerTrendTotal) {
     console.warn('[historicos] assemblerTrend paginación incompleta:',
       allAssemblerTrend.length, 'de', assemblerTrendTotal);
   }
   ```

   Una para cada una de las tres. Este bug fue invisible durante semanas
   justamente porque falla en silencio. La guarda es parte del fix, no un extra.

3. **Deduplica defensivamente** al aplanar (por
   `` `${week_start}|${kpi_id}|${scope_key}|${entity_key}` ``): si una frontera
   de página se encima, hoy entran filas duplicadas que se cuentan dos veces.

4. **Verifica el arreglo con datos reales antes de tocar el cliente.** Corre
   `npm run dev`, abre "Por hub" en un hub grande, y compara el conteo de
   nombres de la lista del flip card contra los nombres graficados en la
   gráfica del mismo KPI. Deben coincidir (módulo 1c abajo). Si no coinciden,
   la paginación sigue rota — no sigas a 1b hasta que cuadren.

---

## 1b — Early return que desmonta la tarjeta completa

`PorHubTab.tsx` línea 1042:

```ts
if (rowWeeks.length === 0 || visibleEntities.size === 0) return null;
```

Cuando el filtro no intersecta con las entidades de esa gráfica, **la tarjeta
entera devuelve `null`**: desaparece del grid y las demás se recorren de lugar.
Esto es real e independiente de 1a (1a solo lo hace mucho más frecuente).

### Fix requerido

Ninguna tarjeta se desmonta por causa del filtro. Sustituye el early return por
un estado vacío *dentro* de la tarjeta: conserva el marco, el título y el badge
de dirección, y en el área de la gráfica un texto centrado tenue
(`text-[11px] text-[var(--muted)]`), p.ej. *"Sin datos para la selección
actual"*. El grid nunca debe recorrerse.

Único caso en que sí puede devolver `null`: cuando el KPI no tiene **ninguna**
fila para ese hub (`rows.length === 0`) — el archivo ni se subió. Eso ya lo
cubre `hasAnyData` a nivel sección.

---

## 1c — Filtro de "última semana" en el cliente

`PorHubTab.tsx` líneas 974–986:

```ts
const rowWeeks       = [...new Set(rows.map((r) => r.week_start))].sort();
const mostRecentWeek = rowWeeks[rowWeeks.length - 1];
const activeEntities = new Set(
  rows.filter((r) => r.week_start === mostRecentWeek && r.value !== null)
      .map((r) => r.entity_key)
);
```

Esto **no** es la causa principal de los conjuntos de nombres distintos — eso es
1a. Pero sí es un bug por su cuenta: alguien con 4 semanas de historia y un
`null` en la última semana (vacaciones, incapacidad, no salió en ese reporte)
se borra de **toda** su historia. Y como `rows` es de un solo KPI,
`mostRecentWeek` puede diferir entre gráficas.

### Fix requerido

Regla de Jose, literal: **grafica todos los nombres, deja todas las gráficas, y
solo cuando yo filtro desaparece gente.**

1. **Universo de personas por sección, no por gráfica.** Cada sección
   (`AssemblerWowSection`, `DriverWowSection`) define **un solo** conjunto: la
   unión de todos los `entity_key` con al menos un valor no nulo en cualquier
   KPI y cualquier semana de la ventana visible (`displayWeeks`). Ese conjunto
   alimenta las gráficas y el dropdown.
   - Elimina la regla de "solo quien aparece en la última semana". Sí, van a
     aparecer personas que ya se fueron; es lo que Jose pidió explícitamente.
     Para eso está el filtro.
2. **Toda gráfica dibuja una línea por cada persona seleccionada** que tenga al
   menos un punto no nulo en la ventana, tenga o no dato en la última semana.
   `connectNulls` ya está puesto, los huecos se puentean solos.
3. **Mapa de colores estable sobre el universo completo.** Construye
   `assemblerColorMap` / `driverColorMap` desde el universo de la sección
   (punto 1), ordenado alfabéticamente para que sea determinista, no desde la
   gente de la última semana. Un mismo nombre = un mismo color en las 7 (o 4)
   gráficas. `ASSEMBLER_PALETTE` tiene 14 colores; si el hub tiene más gente
   cicla la paleta (`i % length`) — aceptable — pero **ningún nombre debe caer
   al gris de fallback**. En la línea ~1001, `sectionColorMap.get(e) ?? '#94a3b8'`
   manda al gris a cualquiera fuera del mapa: bórralo o cámbialo por un color
   real de paleta.
4. **Dropdown = universo de la sección**, alfabético, todos seleccionados por
   default. El `Todos (N)` del botón debe reflejar el nuevo N.
5. **Orden de líneas**: se queda como está (descendente por valor de la última
   semana, nulos al final).

---

## Notas de implementación

- El patrón "derived state" que resetea el filtro al cambiar de hub
  (`if (filterHubId !== hubId) { setFilterHubId(hubId); setSelected(...) }`,
  líneas ~1180 y ~1280) **es correcto y se conserva** — está ahí a propósito
  para evitar el render intermedio con filtro stale. Solo agrégale el reseteo
  cuando cambie el rango de BUG-2, porque el universo cambia con la ventana.
- **Rendimiento:** `data` se arma con `rows.find(...)` dentro de un doble loop
  (línea ~1013). Con 26 semanas × todos los nombres × 11 gráficas eso es O(n³)
  sobre arreglos. Reemplázalo por un índice construido una sola vez:
  `Map<string, number|null>` con llave `` `${week_start}|${entity_key}` ``.
  No es opcional una vez que BUG-2 permita 6 meses.
- **Eje Y:** `manualYMax` se resetea a `smartYMax` solo cuando cambia `hubKey`
  (líneas ~1035–1039). Agrega el rango seleccionado y el conjunto filtrado a esa
  dependencia. `allowDataOverflow` está en `true`, así que un techo stale
  **recorta datos visualmente**.
- **Tooltip:** `WowTooltip` recibe `allEntities={entityOrder}` y renderiza a
  todos, incluso con `—`. Con el universo completo puede ser una lista de 25
  nombres. Cambia a: primero los que tienen valor en la semana hovereada
  (desc), y colapsa los que no en una sola línea final `+N sin dato`. Máximo
  ~15 filas visibles.

## Criterios de aceptación

- [ ] **La prueba de Jose:** para un hub y KPI dados, los nombres graficados
      coinciden con los nombres del ranking del flip card de ese mismo KPI. Ya
      no hay nombres en el flip card que falten en la gráfica.
- [ ] `allAssemblerTrend.length === assemblerTrendTotal`,
      `allDriverTrend.length === driverTrendTotal` y
      `allSnaps.length === snapTotal` en un hub grande. Sin warnings en consola.
- [ ] Recargar la misma página 5 veces devuelve **el mismo** conjunto de nombres
      en cada gráfica. (Hoy varía entre recargas — es la firma de 1a.)
- [ ] Las 7 gráficas de armadores muestran el mismo conjunto de nombres entre sí
      (salvo quien no tenga ningún dato de ese KPI en la ventana). Igual las 4
      de repartidores.
- [ ] Armadores que faltaron la última semana sí aparecen graficados.
- [ ] Deseleccionar personas **nunca** hace desaparecer una tarjeta. Con
      "Ninguno", las 7 tarjetas siguen ahí con el estado vacío adentro.
- [ ] Una sola persona seleccionada queda graficada en todas las tarjetas donde
      tenga datos, con **el mismo color** en todas.
- [ ] Ninguna línea es gris `#94a3b8`.
- [ ] Probado en ≥3 hubs, incluyendo uno chico y uno grande (>14 armadores,
      para verificar el ciclo de paleta).
- [ ] `npm run typecheck` y `npm run lint` limpios.

---

# BUG-2 — Falta selector de rango 5 sem / 3 m / 6 m en la vista OT · OPEN

## Síntoma

> "Also add the 5w, 3m, 6m option for OT view"

Las secciones de tendencia over-time de "Por hub" (Armadores · tendencia WoW y
Repartidores · tendencia WoW) están **clavadas a 5 semanas**:

- `AssemblerWowSection`, línea 1164: `const displayWeeks = allSectionWeeks.slice(-5);`
- `DriverWowSection`, línea 1265: idéntico.
- Etiqueta hardcodeada "· últimas 5 semanas" en las líneas 1201 y 1298.

## Comportamiento requerido

1. Selector de rango **por sección** (uno para Armadores, uno para
   Repartidores), en la fila del encabezado, a la derecha, junto al dropdown de
   personas. Default: **5 sem**.
2. Opciones y valores — usa exactamente las mismas etiquetas y números que ya
   existen en la app para no inventar un tercer vocabulario:

   ```ts
   const OT_RANGES = [
     { label: '5 sem', value: 5  },
     { label: '3 m',   value: 13 },
     { label: '6 m',   value: 26 },
   ] as const;
   ```

3. **Copia el estilo de botón existente**, no diseñes uno nuevo. Está en
   `ResumenCharts.tsx` líneas 171–182 y en `PorKpiTab.tsx` líneas 366–380:
   activo = `bg-black text-white border-black`, inactivo =
   `bg-white text-slate-500 border-[var(--line)] hover:border-slate-400`,
   con `px-2 py-0.5 rounded text-[11px] font-medium border`.
4. `displayWeeks = allSectionWeeks.slice(-weeksShown)`. Si el hub tiene menos
   semanas de historia que el rango pedido, se muestran las que haya — **sin
   error, sin tarjeta vacía**.
5. La etiqueta "· últimas 5 semanas" del encabezado se vuelve dinámica y debe
   reflejar la selección real ("· últimas 13 semanas", etc.), o simplemente
   quítala ya que los botones dicen el rango.
6. El rango seleccionado **persiste al cambiar de hub** (es preferencia de
   vista, no dato del hub). El filtro de personas sí se sigue reseteando al
   cambiar de hub, como hoy.
7. Con 13 o 26 semanas el eje X se satura de etiquetas. Adelgaza los ticks:
   `interval` calculado para dejar ~6–8 etiquetas visibles, p.ej.
   `interval={Math.max(0, Math.ceil(displayWeeks.length / 7) - 1)}`.

## Notas de implementación

- **No hay que tocar el servidor para esto.** `page.tsx` línea 36–38 ya trae 51
  semanas de `peer_comparisons`; es puro estado de cliente. (La paginación de
  esas queries sí se arregla, pero en BUG-1a — no aquí.)
- El estado vive en la sección (`AssemblerWowSection` / `DriverWowSection`) y
  `displayWeeks` ya se pasa como prop a `WowChart` — no hay que cambiar la firma
  del componente de gráfica.
- Al cambiar el rango cambia el universo de personas (BUG-1 punto 1) y por lo
  tanto el mapa de colores y el reset de `manualYMax`. Verifica que el color por
  persona se mantenga estable entre rangos: ordena el universo alfabéticamente
  antes de asignar colores, para que agregar historia no reasigne colores.
- Ojo con el rendimiento: ver la nota del índice `Map` en BUG-1. Con 26 semanas
  y sin ese arreglo, cambiar de rango se va a sentir lento.

## Criterios de aceptación

- [ ] Los tres botones aparecen en ambas secciones y se ven idénticos a los de
      la pestaña "Por KPI".
- [ ] Cambiar a 3 m y 6 m redibuja las 11 gráficas con más semanas en el eje X.
- [ ] El eje X sigue legible en 6 m (no hay etiquetas encimadas).
- [ ] Cambiar de hub conserva el rango elegido.
- [ ] Un hub con solo 6 semanas de historia, en 6 m, muestra sus 6 semanas sin
      romperse.
- [ ] Los colores por persona no cambian al cambiar de rango.
- [ ] `npm run typecheck` y `npm run lint` limpios.

---

# BUG-3 — Un solo origen por valor (deuda estructural) · OPEN

Aplicación concreta del **Principio rector**. Esto es lo que evita que BUG-1
vuelva a pasar con otro nombre.

## Divergencias confirmadas (auditadas, no hipotéticas)

### D1 — Misma tabla, dos tuberías · `page.tsx`

`peer_comparisons` se lee **dos veces** con filtros, orden y paginación
distintos:

| | Query "peers" (~línea 152) | Query "trend" (~línea 195) |
|---|---|---|
| Consumidores | flip cards, tiles, conteo "N armadores con datos", `GenerarReporte` | las 11 gráficas WoW |
| Semanas | solo `currentWeek` | ~~51 semanas~~ → últimas 8 semanas con upload (sesión 16) |
| Scope | `within_hub` + `within_city` | solo `within_hub` |
| Orden | 5 columnas (estable) | `week_start` solo (**roto**) |

**Este es literalmente el escenario de Jose:** el flip card dice 5 y la gráfica
dice 4, para la misma persona, la misma semana, la misma tabla. Arreglar la
paginación (BUG-1a) hace que **hoy** coincidan; no impide que vuelvan a
divergir mañana. Solo una tubería lo impide.

### D2 — `KPI_META` duplica el catálogo de KPIs · `PorHubTab.tsx` líneas 109–123

`KPI_META` hardcodea `unit` y `direction` de 11 KPIs que **ya viven en la tabla
`kpis`**, y además **se salta `effectiveDirection()`** — que el resto de la app
sí usa, incluido **el mismo archivo** en la línea 355 para los tiles.

Consecuencia hoy: el badge "↓ menor mejor" de una gráfica (línea 1059, leído de
`KPI_META`) puede contradecir al badge del tile de arriba (línea 559, leído de
`effectiveDirection`). El comentario de la línea 353 dice que la dirección de
`tasa_armado` en la BD está mal y por eso existe el override — pero las
gráficas no reciben el override. **Una velocidad de armado más rápida se puede
estar pintando como mala en la gráfica y buena en el tile.**

### D3 — Conversión pct ×100 en 5 lugares, con redondeos distintos

| Lugar | Redondeo |
|---|---|
| `_shared.ts:144` | sin redondeo |
| `_shared.ts:242` (`formatValue`) | `.toFixed(1)` |
| `PorHubTab.tsx:1007` (`toDisplay` de WowChart) | `.toFixed(2)` |
| `PorKpiTab.tsx:224` | sin redondeo |
| `app/api/generar-reporte/route.ts:179` | `.toFixed(1)` |

Mismo valor, distinto número impreso según dónde lo leas.

### D4 — Delta / WoW en 3 lugares

`_shared.ts:249` (`formatDelta`, maneja pp vs %), `PorKpiTab.tsx:84–85` (su
propia rama pp vs %), `route.ts:191` (`fmtMagnitude`). Tres implementaciones de
la misma regla de negocio.

### D5 — `mean4w` con dos ventanas distintas

`PorHubTab.tsx:371` y `PorKpiTab.tsx:233` ambos hacen "usa `rolling_mean_4w` de
la BD, si no calcúlalo local" — pero **cada uno arma su propio arreglo**
(PorHubTab corta las últimas 4 de una serie de 12, línea 369). El fallback
puede promediar semanas distintas. El "4w avg" del tile y el de Por KPI no
tienen por qué coincidir, y no hay nada que lo garantice.

### D6 — El reporte reimplementa el criterio de "flagged"

`app/api/generar-reporte/route.ts` líneas 252–355 arma su propia lógica de qué
armador está "flagged/outlier", con su propia precedencia de metas — separada de
`resolveTarget`/`meetsTarget`/`isBelowTarget` de `_shared.ts` y de lo que pintan
los tiles. **El reporte que se manda a Slack puede señalar a alguien que la app
muestra en verde.** Este es el más caro de los seis: es el que sale del equipo.

## Fix requerido

### Paso 1 — Un solo paginador (`lib/fetch-all-pages.ts`)

Un helper que **exija** las llaves de orden y garantice el orden total:

```ts
export async function fetchAllPages<T>(opts: {
  table: string;
  select: string;
  /** Debe formar una llave ÚNICA por fila. No es opcional. */
  orderBy: { column: string; nullsFirst?: boolean }[];
  filter: (q: PostgrestFilterBuilder) => PostgrestFilterBuilder;
  /** Llave de dedupe, derivada de orderBy. */
  dedupeKey: (row: T) => string;
  label: string;   // para el warning de integridad
}): Promise<T[]>
```

Adentro: count exacto → páginas en paralelo → flatten → dedupe → si
`length !== count`, `console.warn` con el `label`. **Las tres queries paginadas
de `page.tsx` pasan por aquí.** Así BUG-1a queda arreglado estructuralmente: ya
no es posible escribir una query paginada sin orden total, porque el tipo lo
exige. Haz este paso *como* el fix de BUG-1a, no aparte.

### Paso 2 — Una tubería para `peer_comparisons`

Colapsa D1: **una** query multi-semana que traiga lo que ambos consumidores
necesitan (`within_hub` + `within_city`, 51 semanas), y de ahí se derivan las
vistas en cliente:

```ts
peersForWeek(all, currentWeek)   // lo que hoy es `peers`
trendForHub(all, hubId, weeks)   // lo que hoy es assemblerTrend/driverTrend
```

Si el volumen de traer 51 semanas de ambos scopes resulta pesado, mide primero
con el count real antes de optimizar.

> ⚠️ **Ese conteo ya se hizo (sesión 16, `HANDOFF.md` §26) y sí resulta pesado.**
> 51 semanas de `within_hub` solo: 22450 filas de operador (6.03 MB) + 8942 de
> repartidor (2.40 MB). Sumar `within_city` encima lo empeora. Traer eso en
> **una** tubería es exactamente lo que tumbó `/historicos` en producción
> (31.9 MB por request, ~18 s, la conexión cortada a media respuesta).
> Colapsar D1 sigue siendo correcto — un solo origen por valor es la regla de
> Jose — pero **la tubería única tiene que ser la del query-builder compartido
> con ventana acotada**, no la de "traer 51 semanas de todo y derivar en
> cliente". Corre `npx tsx scripts/diag-historicos.ts` antes de decidir el
> alcance; imprime filas y bytes reales por rama. Si de verdad hay que partirlo, entonces
las dos queries se construyen desde **un solo query-builder compartido** con el
mismo `orderBy`, mismo `select` y mismo dedupe — nunca dos escritas a mano.

### Paso 3 — Una capa de derivación (`lib/derive.ts`)

Accessors con nombre, importados por **todas** las superficies (tiles, gráficas,
Por KPI, Comparativa, `GenerarReporte`, la ruta del reporte, `generate-insights`):

- `personValue(rows, { person, kpiId, hubId, week })`
- `personSeries(rows, { person, kpiId, hubId, weeks })`
- `mean4w(snapshots, { kpiId, scopeKey, week })` — **una** definición de la
  ventana, DB primero, fallback único (resuelve D5)
- `toDisplayUnits(value, unit)` — la única conversión ×100 (resuelve D3)
- `formatValue` / `formatDelta` — ya existen en `_shared.ts`; **bórrale las
  copias** a PorKpiTab y a `route.ts` y que importen estas (resuelve D4)
- `isFlagged(person, kpiId, ...)` — un solo criterio, usado por los tiles y por
  el reporte (resuelve D6)

Regla de oro del refactor: **si borras una implementación duplicada y algún
número cambia, el número estaba mal en algún lado.** Anótalo, no lo escondas.

### Paso 4 — Matar `KPI_META` (D2)

`unit` y `direction` salen de la tabla `kpis` (que ya llega como prop a
`PorHubTab`), pasados por `effectiveDirection()`. Lo único que se queda en un
mapa local es el **título corto** de la gráfica, porque es texto de UI, no dato.
Si `lib/kpi-labels.ts` ya hace ese relabeling, úsalo y borra el mapa.

## Criterios de aceptación

- [ ] Existe `fetchAllPages` y **las tres** queries paginadas de `page.tsx` lo
      usan. No queda ningún `.range(` suelto en el archivo.
- [ ] `grep -rn "\* 100" app components lib` no devuelve conversiones de
      unidad fuera de `derive.ts` (los cálculos de ancho de barra en px no
      cuentan).
- [ ] `KPI_META` ya no contiene `unit` ni `direction`.
- [ ] El badge de dirección de cada gráfica coincide con el del tile del mismo
      KPI. Verificado explícitamente en `tasa_armado`, que es el que tiene el
      override.
- [ ] El "4w avg" del tile en Por hub y el de Por KPI dan el mismo número para
      el mismo hub y KPI.
- [ ] La lista de armadores flagged del reporte de Slack coincide exactamente
      con los que la UI pinta en rojo, para el mismo hub y semana.
- [ ] Prueba de Jose, escrita: elige un armador y un KPI, y verifica que el
      valor es idéntico en flip card, gráfica WoW, Por KPI y reporte de Slack —
      y que las cuatro lo obtienen del mismo accessor. Deja el nombre y el
      número anotados en el PR.
- [ ] `npm run typecheck` y `npm run lint` limpios.

## Orden sugerido

BUG-1a (vía Paso 1) → BUG-3 Pasos 2–4 → BUG-1b/1c → BUG-2.

Razón: Paso 1 detiene el sangrado hoy. Pasos 2–4 cambian de dónde leen las
gráficas, así que hacerlos **antes** de tocar el cliente evita escribir el
filtro de personas dos veces.

---

# Pendientes

> Jose: pega aquí los bugs nuevos como vayan saliendo. Formato mínimo:
> qué pestaña, qué esperabas, qué pasó. Yo los convierto en secciones
> numeradas con causa raíz y criterios de aceptación antes de que se trabajen.

- (vacío)
