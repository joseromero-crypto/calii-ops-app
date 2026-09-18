# PLAN_MOBILE.md — hacer la app usable en teléfono

Estado: **NO EMPEZADO.** Escrito 2026-09-11 (sesión 16) a partir de lo que José
reportó — "Mobile version is not perfect, cant see past conversations" — más una
auditoría del código que encontró tres cosas más del mismo tipo. Nada aquí se ha
implementado.

## Cómo usar este archivo

Desde la raíz del repo, en Claude Code:

```
Read PLAN_MOBILE.md and implement M1 and M2. Follow the acceptance criteria
exactly. Reuse the drawer pattern in components/MobileHeader.tsx — do not
invent a second one. Run `npm run typecheck` when done.
```

Mismas reglas de sesión que `BUGS.md`: diffs mínimos y quirúrgicos, se conserva
el lenguaje visual existente (clases Tailwind, `var(--line)`, `var(--ink)`,
`var(--muted)`, `shadow-soft`, `rounded-xl`), y `npm run typecheck` debe pasar
con cero errores antes de dar algo por terminado.

⚠️ **`npm run dev` ahora es `netlify dev` y sirve en `http://localhost:8888`, no
en 3000** (HANDOFF §27). `/chat` no funciona en 3000 porque ahí no se enrutan las
funciones de Netlify.

---

## El patrón que ya existe — cópialo, no inventes otro

`components/MobileHeader.tsx` ya resuelve exactamente este problema para la
navegación principal: barra superior visible sólo en móvil, overlay oscuro con
`onClick` para cerrar, y un cajón `fixed inset-y-0 left-0 w-[260px] lg:hidden`
que entra con `translate-x-0` / `-translate-x-full`. Tiene el manejo de z-index
ya resuelto (`z-40` overlay, `z-50` cajón).

Todo lo de abajo debe reusar ese mismo mecanismo y esas mismas clases. Dos
cajones distintos con dos animaciones distintas en la misma pantalla se ve mal y
además duplica el bug cuando haya que arreglarlo.

---

## M1 — No hay forma de llegar a las conversaciones pasadas · OPEN · **el reporte de José**

`components/chat/ChatShell.tsx:196`

```tsx
<div className="hidden lg:block min-h-0">
  <ThreadsSidebar … />
</div>
```

El `lg` de Tailwind es 1024 px, así que en cualquier teléfono la lista de hilos
**no existe**. Lo único que queda en móvil es el botón de
`ChatShell.tsx:207`:

```tsx
<button onClick={startNew} className="lg:hidden text-[12px] font-medium text-teal-700">+ Nueva</button>
```

que **crea** conversaciones pero nunca las **lista**. O sea: en el teléfono se
pueden abrir investigaciones nuevas indefinidamente y no se puede volver a
ninguna. Las conversaciones sí están ahí — `listConversations()` las trae bien,
es puramente que no hay dónde mostrarlas.

**Criterio de aceptación**

- En `<1024 px` existe un control visible que abre `ThreadsSidebar` en un cajón,
  con el mismo overlay/animación que `MobileHeader`.
- Seleccionar un hilo lo abre **y cierra el cajón** (si no, la conversación queda
  tapada por el propio cajón).
- El botón "+ Nueva" existente sigue funcionando; "+ Nueva investigación" dentro
  del cajón también, y cierra el cajón.
- En `≥1024 px` no cambia absolutamente nada.

⚠️ **Footgun: el botón de archivar es `hover`, y en touch no hay hover.**
`components/chat/ThreadsSidebar.tsx` renderiza la `×` como
`opacity-0 group-hover:opacity-100 focus:opacity-100`. En escritorio aparece al
pasar el mouse; **en un teléfono es invisible y no se puede tocar**. Al hacer M1
hay que resolver esto o el cajón llega con una función muerta adentro. Opciones,
en orden de preferencia: mostrar la `×` siempre por debajo de `lg`
(`opacity-100 lg:opacity-0 lg:group-hover:opacity-100`), o un swipe-to-archive.
Lo que no sirve es dejarlo como está.

---

## M2 — Las citas `[c1]` no llevan a ningún lado en móvil · OPEN

`components/chat/ChatShell.tsx:287`

```tsx
<div className="hidden lg:block min-h-0">
  <ExhibitionPane claim={activeClaim} toolCall={activeClaimToolCall} />
</div>
```

Mismo problema, consecuencia peor. Tocar una cita en el texto del modelo llama a
`openClaim`, que hace `setActiveClaim(...)` correctamente — y ese estado sólo se
renderiza dentro del panel oculto. **En móvil la cita no hace nada visible: ni
abre, ni avisa, ni falla.**

Esto no es cosmético. Todo el modelo de confianza del asistente es
claims-con-evidencia (`lib/analysis/evidence.ts`, los enlaces `claim:` en
`MessageBubble.tsx`): cada afirmación viene respaldada por una query re-ejecutable
contra `upload_rows`. En el teléfono, hoy, el asistente afirma cosas y la
evidencia es inalcanzable — que es justo el modo de fallo que el diseño quería
evitar.

**Criterio de aceptación**

- Tocar una cita en `<1024 px` abre `ExhibitionPane` (cajón desde la derecha o
  bottom-sheet, pero con el mecanismo de `MobileHeader`).
- Se puede cerrar sin perder la posición de scroll en la conversación.
- `activeClaim` / `activeClaimToolCall` siguen siendo la única fuente de verdad;
  no dupliques el estado para móvil.
- En `≥1024 px` no cambia nada.

---

## M3 — `100vh` en iOS Safari · OPEN

`components/chat/ChatShell.tsx:195` — `h-[calc(100vh-32px)]`, y
`app/(app)/chat/loading.tsx:3` — `h-[calc(100vh-56px)]`.

En Safari de iOS `100vh` mide el viewport **sin** la barra de direcciones, que es
más alto que lo que realmente se ve. El resultado típico es que el compositor
(el `textarea` y el botón Enviar, al fondo del contenedor) queda empujado debajo
de la barra, y hay que hacer scroll dentro de una zona que no parece scrolleable.

**Criterio de aceptación:** usar `100dvh` (dynamic viewport height) en ambos
archivos. Es un cambio de una palabra por archivo y no afecta escritorio.
Verificar en Safari real, no en el simulador de Chrome — este bug no se
reproduce en el responsive mode de Chrome.

---

## M4 — El skeleton de carga no coincide con el layout real · OPEN

`app/(app)/chat/loading.tsx:3` usa `grid-cols-[220px_1fr]` **en móvil**, mientras
que `ChatShell.tsx:195` usa `grid-cols-1` y sólo pasa a tres columnas en `lg`.
El esqueleto dibuja una columna lateral de 220 px que el contenido real nunca va
a ocupar, así que la pantalla salta al terminar de cargar.

**Criterio de aceptación:** el grid de `loading.tsx` replica el de `ChatShell`
en todos los breakpoints. Trivial, pero es la primera impresión de la página.

---

## Fuera de alcance de este plan (revisar después, no reportado)

No los toques a menos que José los pida — se listan sólo para que no parezcan
olvidos:

- `/historicos` en móvil. Las pestañas ya hacen `overflow-x-auto`
  (`HistoricosClient.tsx:102`) y ocultan sus sub-etiquetas en pantallas chicas, y
  las tablas de `ResumenTab.tsx:133` y `PorKpiTab.tsx:474` ya están envueltas en
  `overflow-x-auto`. Las gráficas WoW de `PorHubTab` sí se ven apretadas en un
  teléfono, pero nadie se ha quejado.
- `/config` (`RampTargetsSection.tsx`) tiene tablas anchas, ya con
  `overflow-x-auto`.
- `/upload` en móvil: subir CSVs desde el teléfono probablemente no es un flujo
  real; confirmar con José antes de invertir ahí.

## Verificación

No basta con `npm run typecheck`. Antes de dar por terminado M1 o M2:

1. `npm run dev`, abrir `http://localhost:8888/chat` **en un teléfono real en la
   misma red** (o en Chrome a 390 px de ancho como mínimo, pero un iPhone real
   para M3 es obligatorio).
2. Con al menos 3 conversaciones ya existentes: abrir el cajón, entrar a una
   vieja, confirmar que carga y que el cajón se cierra.
3. Archivar una desde el teléfono — el control tiene que ser visible sin hover.
4. Tocar una cita `[c1]` en una respuesta con evidencia y confirmar que el panel
   abre y muestra las filas.
5. Con el teclado del teléfono abierto, confirmar que el botón Enviar sigue
   visible (esto es lo que M3 arregla).
