# Canvas de Control Code: terminales, navegador, diagramas, documentos y presentaciones

## Contexto

En ADE-AGS el canvas solo acomoda terminales y portales de navegador. Tiene tres limitaciones:
- Los agentes no pueden mover nodos ni leer cómo está armado el canvas.
- No hay herramientas MCP: todo pasa por la CLI `ags`.
- No sirve para producir nada: no se pueden hacer diagramas ni documentos.

La idea es que el canvas de Control Code sea un **espacio de trabajo compartido entre el usuario y los agentes**:
- se mueven las terminales y el navegador;
- se hacen diagramas de flujo y de arquitectura, que se exportan a PNG, SVG o PDF;
- se escriben documentos en Markdown y presentaciones en HTML, y se ven en vivo mientras se crean;
- se pueden usar los diagramas y las capturas del navegador dentro de los documentos y las presentaciones.

**Requisito central: el MCP puede hacer todo lo que hace el usuario.** Cada acción de la UI es una operación tipada y el MCP expone esas mismas operaciones. Cuando hay varios agentes, cada uno tiñe con su color lo que está tocando.

Decisiones del usuario:
- **Canvas por workspace, dividido en páginas que empiezan vacías.** El usuario elige qué agentes traer a cada página, y solo la página activa carga algo, así que abrir el canvas no lanza las terminales apagadas. "Crear diagrama" agrega un marco de diagrama a la página, que también se puede abrir en un tab propio.
- **Documentos en Markdown. Presentaciones con un HTML por hoja**, tamaño elegible, carga dinámica de las hojas al pasar, visor dentro del canvas y en pantalla completa, y export a un solo PDF con todas las hojas.
- **Los archivos viven en el proyecto** y se versionan con git. La disposición del canvas va en SQLite.

## Principio de diseño: una sola vía de mutación

Todo cambio, venga del usuario o de un agente, es una operación (`Op`) que pasa por un único reductor:

```
UI (arrastrar, editar…) ─┐
                         ├─> applyOps(target, ops[], actor) ─> store ─> render + guardado
MCP canvas_* / diagram_* ┘                        │
                                                  └─> presence: actor → color sobre lo tocado
```

- `actor` es `"user"` o el `tabId`/`taskId` del agente. El MCP ya lo conoce: `McpContext::scope()` en `src-tauri/src/ipc/mcp.rs` agrega `tabId`/`taskId` a cada payload, y `ownerOf(args)` en `cliBridge.ts` lo convierte en un `ViewOwner`.
- Así no puede pasar que la UI haga algo que el MCP no puede hacer, y los colores salen gratis: cada `Op` registra quién tocó qué.
- Las operaciones se aplican en serie en el store del frontend. Ante conflicto gana la última escritura por elemento. Una `Op` sobre un id inexistente devuelve error al agente, que debe volver a leer.

## Arquitectura

### 1. El canvas: páginas que empiezan vacías

- **Librería:** `@xyflow/react` (React Flow, MIT). La misma que usa ADE-AGS, así que ya está probada en Tauri. Sirve tanto para el canvas como para los diagramas.
- **Modo nuevo del área de trabajo: `Tabs | Canvas`**, un toggle por ventana. En modo Canvas, el `EditorArea` se reemplaza por `CanvasView`.
- **El canvas no es "todo el workspace".** Un workspace tiene **páginas de canvas** (por ejemplo "Arquitectura", "Frontend", "Informe"), con una barra de páginas para crear, renombrar, reordenar y borrar.
  - **Una página nueva empieza vacía.** Nada se carga solo.
  - **El usuario elige qué traer:** "Agregar agente" lista los tabs del workspace (apagados o corriendo) y permite agregar uno o varios. También se pueden crear desde ahí un agente nuevo, un navegador, un diagrama, un documento o una presentación.
  - **Solo la página activa está viva.** Las páginas inactivas no montan nada: ni xterm, ni iframes, ni visores.
  - **Una terminal apagada que no está en la página activa no se lanza.** Se reutiliza `useDormant`/`rouse` (`src/features/terminal/hibernation.ts`): un tab entra en la página dormido y se despierta solo cuando su nodo se ve (o al hacerle clic). Las que ya estaban corriendo siguen corriendo; cambiar de página no las mata.
  - **Un agente está en una sola página a la vez.** "Mover a página…" lo cambia de página. En modo Tabs siguen estando todos, como hoy.
  - Los archivos (diagramas, documentos, presentaciones) sí pueden aparecer en varias páginas: el nodo es solo una referencia al archivo.
- **Nodos del canvas:** `terminal` (un tab de agente), `browser` (un view tab), `diagram`, `doc`, `slides`, `image` y `note`.
- **Terminales y navegador no se mueven de padre en React.** `Terminal.tsx` hace `ptyKill` al desmontarse, así que se reutiliza el patrón overlay que ya usa `EditorArea`:
  - el canvas solo mide el rectángulo de cada nodo en pantalla;
  - ese rectángulo se pasa como *placement* a `TerminalPanel` y `ViewTabsHost`, igual que hoy con `placeStyle` (`src/features/tabs/layout/layoutStore.ts`);
  - los nodos son agujeros, y nada se remonta al mover o hacer zoom.
- **Zoom.** Evitar los problemas de ADE-AGS (selección corrida bajo `scale()`):
  - una terminal solo es interactiva a zoom 1;
  - con otro zoom se dibuja escalada, sin eventos, y un clic o la acción "enfocar" la lleva a 100% centrada;
  - debajo de ~0.4 se ve una vista previa de las últimas líneas.
- **Diagramas, documentos y presentaciones** se dibujan de verdad dentro del nodo (no tienen PTY ni iframe pesado), así que escalan sin trucos.
- **Persistencia:** tabla SQLite nueva `canvas_pages(id, workspace, name, position, json, updated_at)`, en `src-tauri/src/database/schema.rs` y `queries/`, con guardado debounced **por página**. Guarda nodos con su caja, referencias (tabId, viewId, ruta de archivo) y viewport. Mover algo reescribe solo esa página, no un JSON global (era el problema de ADE-AGS). Se recuerda la última página activa de cada ventana.

### 2. Diagramas

- **Archivo:** `<ruta>.diagram.json` en el proyecto, por defecto en `docs/diagrams/`. Formato propio y simple:
  - `nodes`: `id, shape, label, x, y, w, h, style, parent`
  - `edges`: `id, from, to, label, arrow, style`
- **Formas:**
  - para diagramas de flujo: rectángulo, redondeado, rombo, elipse, paralelogramo y texto;
  - para arquitectura: cilindro (base de datos), nube, actor y **grupo/contenedor** (VPC, servicio, capa), implementado con `parentId` de React Flow.
- **Aristas:** ortogonales (`smoothstep`) o rectas, con etiqueta y flecha.
- **Estilos:** una paleta corta de colores de relleno sacada de los tokens de `App.css`.
- **UI mínima:**
  - una barra de formas;
  - doble clic para editar el texto;
  - arrastrar desde un handle para conectar;
  - un inspector chico con color, forma y flecha;
  - Supr, Ctrl+Z/Y, copiar y pegar.
- **Auto-layout con `elkjs`.** El agente no necesita calcular coordenadas: crea nodos y aristas y pide `layout: "LR" | "TB"`. Esto es lo que hace que la IA dibuje bien.
- **Exportar:**
  - **SVG y PNG** con `html-to-image` (el método que recomienda React Flow);
  - **PDF** con `pdf-lib`, embebiendo el PNG a 2x o el SVG rasterizado;
  - además, export a `.drawio` (XML de mxGraph), que es simple de generar y es el "formato común" para seguir editándolo en diagrams.net.
- **Ubicación del nodo:** el diagrama se ve como nodo del canvas, con un React Flow anidado y su propio `ReactFlowProvider` y las clases `nodrag nowheel`. "Abrir en tab" lo abre como view kind `diagram`.

### 3. Documentos (Markdown)

- Se reutilizan `MarkdownPreview.tsx` y `markdownPipeline.ts`. El nodo `doc` muestra la vista previa en vivo y un botón para editar, que abre el `FileTab` existente.
- **En vivo:** agregar al watcher de `src-tauri/src/explorer/watch.rs` un modo por archivo, con eventos `file-changed`, en vez del polling de 2 s de `FileTab`. Al escribir el agente, el nodo se actualiza y hace scroll a la zona cambiada.
- **Imágenes:**
  - los diagramas se insertan como `![](diagrams/x.svg)`: se exportan solos al guardar el diagrama, si está referenciado;
  - las capturas del navegador se copian desde `capture_dir()` (`src-tauri/src/preview/capture.rs`) a `docs/assets/`, ya que hoy viven en temp y se borran;
  - hay que ajustar `rehype-sanitize` para permitir imágenes locales resueltas por la app.
- **PDF:**
  - versión 1: render paginado a A4 de la vista previa → páginas PNG → `pdf-lib`;
  - limitación: el texto no se puede seleccionar. Más adelante se puede pasar a vector (por ejemplo con typst del lado Rust).

### 4. Presentaciones (HTML)

- **Una carpeta por presentación, un HTML por hoja:**
  ```
  docs/slides/demo.slides/
    deck.json      { title, size: {w, h}, slides: ["01-portada.html", "02-problema.html", …], theme?: "theme.css" }
    theme.css      estilos compartidos (opcional)
    01-portada.html
    02-problema.html
    assets/        imágenes: diagramas exportados, capturas del navegador
    index.html     runner autónomo (lo genera la app)
  ```
- **Tamaño elegible por presentación:** 16:9 (1920×1080), 4:3 (1024×768), A4 vertical u horizontal, o un tamaño libre. Cada hoja se dibuja exactamente a ese tamaño y se escala al lugar donde se muestra.
- **Carga dinámica (`slidesLoader.ts`):**
  - solo están montadas la hoja actual y la anterior y siguiente (precargadas); las demás se descargan al alejarse;
  - cada hoja va en su propio `<iframe sandbox>` sin `allow-scripts`, porque el HTML lo escribe un agente;
  - al editar una hoja, el watcher de la carpeta recarga solo esa hoja, así que se ve cómo se va creando;
  - las miniaturas se renderizan bajo demanda y se cachean.
- **El mismo loader en dos lugares:**
  - en la app, como visor del nodo del canvas y en **pantalla completa** (presentador con flechas, Esc y número de hoja);
  - en `index.html` dentro de la carpeta, una versión mínima en JS plano que la app regenera al cambiar `deck.json`. Así la presentación también se abre en cualquier navegador, fuera de Control Code.
- **Imágenes:** rutas relativas a `assets/`, resueltas por la app.
- **PDF de todas las hojas:**
  - se recorren las hojas en orden;
  - cada una se monta fuera de pantalla a su tamaño real y se captura con el snapshot nativo que ya existe (`previewCapture` y el recorte `cropFor` de `src/features/browser/annotate/geometry.ts`);
  - `pdf-lib` arma un PDF con una página por hoja, con el tamaño de la presentación;
  - se muestra el progreso ("hoja 7 de 20") y se puede cancelar.

### 5. Colores por agente (presencia)

- `src/features/browser/agentPaint.ts` ya asigna un color estable por tabId (`AGENT_PAINTS`). Se le agrega el `hex` de cada color para usarlo en SVG y en React Flow.
- **Store de presencia** con `{ elementId → {actor, at} }`:
  - lo que un agente tocó en los últimos ~8 s se ve con el fondo y el borde teñidos de su color, más una etiqueta "Claude · tab 2";
  - después se desvanece;
  - el nodo del canvas que un agente está usando (su terminal, su navegador, el diagrama que edita) lleva un borde de su color mientras dure.
- **Documentos:** los cambios hechos por `doc_write` se atribuyen al agente que los hizo. Los cambios externos (las herramientas propias del agente) se marcan como "modificado". Por eso las instrucciones del MCP piden usar `doc_write`.
- Se puede iluminar todo lo de un agente con `useAgentHighlight` (`src/features/browser/agentHighlight.ts`).

## MCP: herramientas nuevas

Mismo camino que las de navegador:
1. tabla `CANVAS_TOOLS` en `src-tauri/src/ipc/mcp.rs`;
2. comando `canvas.run` en `src-tauri/src/ipc/commands/dispatch.rs`, con su handler en `ipc/commands/canvas.rs` (elige ventana como `browser_run`);
3. `ask_frontend_within` en `ipc/bridge.rs`;
4. caso `handleCanvas` en `src/features/orchestrator/cliBridge.ts`, que llama a `applyOps(target, ops, actor)`.

Las de lectura se marcan como auto-aprobadas en `is_read_only`.

| Herramienta | Qué hace |
|---|---|
| `canvas_pages` | Lista, crea, renombra, borra o activa páginas |
| `canvas_read` | Una página (por defecto la activa): nodos (id, tipo, caja, título, archivo, quién lo usa), viewport y modo. También lista los tabs del workspace que no están en ninguna página |
| `canvas_add` | Agrega un nodo a una página: un agente existente (por tabId, sin lanzarlo si la página no está activa), un agente o shell nuevo, browser (URL), diagram, doc, slides, image o note. Acepta `near` o una caja |
| `canvas_update` | Mover, redimensionar, renombrar, quitar o pasar nodos a otra página, en lote |
| `canvas_arrange` | Acomoda automáticamente en grilla o por grupos |
| `canvas_view` | Modo Tabs/Canvas, enfocar un nodo, zoom y pan |
| `diagram_create` / `diagram_read` | Crea el archivo y su nodo; lee nodos y aristas con ids |
| `diagram_edit` | Lote de ops: add/update/remove de nodo y arista, group y style. Opcional `layout:"LR"\|"TB"` |
| `diagram_export` | png/svg/pdf/drawio → ruta del archivo |
| `doc_write` | Crea o reescribe, o hace `append`/`replace` sobre un .md. Se ve en vivo y queda atribuido |
| `slides_create` | Crea la carpeta con su `deck.json`, tamaño y tema, y su nodo en la página |
| `slide_write` | Crea o reescribe una hoja (por nombre o posición), y opcionalmente el `theme.css` |
| `slides_edit` | Reordena, quita o inserta hojas, o cambia el tamaño o el título |
| `slides_goto` | Navega a una hoja, o abre o cierra la pantalla completa |
| `asset_capture` | Captura el navegador (o un diagrama) a `docs/assets/…` y devuelve la ruta relativa para insertarla |
| `doc_export` / `slides_export` | PDF → ruta del archivo |

Hay que agregar al texto `INSTRUCTIONS` del MCP cómo usar el canvas: preferir `layout` antes que coordenadas y `doc_write` antes que escribir el archivo directo. También actualizar `skills/controlcode-orchestrator/SKILL.md`.

## Fases (cada una se puede publicar sola)

1. **Base del canvas.**
   - Toggle Tabs/Canvas, `CanvasView` con React Flow.
   - Páginas vacías, barra de páginas, "Agregar agente" y "Mover a página…".
   - Nodos de terminal (dormidos hasta verse) y de navegador vía placements overlay.
   - Persistencia SQLite por página.
   - Reductor `applyOps` con actor y presencia.
   - Herramientas `canvas_pages/read/add/update/arrange/view`.
2. **Diagramas:** formas, aristas, UI de edición, archivo `.diagram.json`, elkjs, `diagram_*` y export PNG/SVG/PDF/drawio.
3. **Documentos:** nodo doc, watcher por archivo, `doc_write`, assets (diagramas y capturas), export PDF.
4. **Presentaciones:** carpeta con un HTML por hoja y `deck.json`, tamaño elegible, loader dinámico (en la app y en `index.html`), visor en el canvas y en pantalla completa, `slides_*`/`slide_write` y export PDF de todas las hojas.
5. **Pulido:** minimapa, undo/redo del canvas, atajos, y que el agente siga al usuario o el usuario siga al agente.

## Archivos clave

**Frontend nuevo:** `src/features/canvas/`
- `CanvasView.tsx`, `store.ts` (board, `applyOps`), `ops.ts` (tipos de Op, validación), `presence.ts`, `placements.ts`
- `nodes/`: TerminalNode, BrowserNode, DiagramNode, DocNode, SlidesNode, ImageNode, NoteNode
- `src/features/diagram/`: `Diagram.tsx`, `shapes/`, `layout.ts` (elk), `export.ts`, `drawio.ts`, `format.ts`
- `src/features/slides/`: `deck.ts` (formato de `deck.json`), `slidesLoader.ts` (carga y descarga de hojas), `SlidesView.tsx`, `Presenter.tsx`, `exportPdf.ts`, `runner.ts` (genera el `index.html` autónomo)

**Frontend a tocar:**
- `src/features/tabs/EditorArea.tsx` (toggle de modo)
- `TerminalPanel.tsx` y `ViewTabsHost.tsx` (aceptar placements del canvas)
- `viewTabs.ts` y `viewStore.ts` (view kind `diagram`)
- `src/features/orchestrator/cliBridge.ts` (`handleCanvas`)
- `src/features/browser/agentPaint.ts` (hex)
- `editor/FileTab.tsx` (evento del watcher en vez de polling)
- locales en/es/pt/fr/de/it

**Rust:**
- `src-tauri/src/ipc/mcp.rs` (tabla de herramientas e INSTRUCTIONS)
- `ipc/commands/dispatch.rs` y `ipc/commands/canvas.rs` nuevo
- `database/schema.rs` y `queries/canvases.rs`
- `explorer/watch.rs` (watch por archivo)
- `preview/capture.rs` (copiar captura a `docs/assets`)
- `app/run.rs` (registrar comandos)

**Dependencias nuevas:** `@xyflow/react`, `elkjs`, `html-to-image`, `pdf-lib`.

## Verificación

- **Tests unitarios (vitest):**
  - `applyOps`: cada Op, errores por id inexistente y atribución del actor;
  - formato `.diagram.json` ida y vuelta;
  - conversión a drawio;
  - `deck.json` ida y vuelta y operaciones de `slides_edit`;
  - el loader monta solo actual ± 1 y descarga las demás al avanzar.
- **Rust:** tests de las herramientas nuevas en `mcp.rs` (lista, esquemas, auto-aprobación de lecturas) y de las queries `canvases`.
- **De punta a punta con la app (`bun tauri dev`):**
  - desde una terminal con Claude Code, pedirle que arme un diagrama de arquitectura con `diagram_edit` + `layout`, y ver que se dibuja en vivo y teñido del color de ese agente;
  - con dos agentes a la vez, verificar colores distintos;
  - exportar a PNG, SVG, PDF y drawio, y abrir el `.drawio` en diagrams.net;
  - pedirle un documento que inserte ese diagrama y una captura del navegador (`asset_capture`), verlo crecer en vivo y exportarlo a PDF;
  - pedirle una presentación de ~15 hojas en 16:9: ver cada hoja aparecer mientras la escribe, recorrerla en el nodo y en pantalla completa (revisar que solo haya 3 iframes montados), abrir su `index.html` en un navegador externo y exportarla a PDF (15 páginas de 1920×1080);
  - cambiar el tamaño a A4 y volver a exportar;
  - mover, hacer zoom y cerrar o reabrir la ventana: las terminales no se reinician y la disposición se conserva;
  - con un workspace de varios tabs apagados, abrir el canvas: la página nueva está vacía y no se lanza ningún proceso (revisar con `process_list` o `ps`). Al agregar un agente apagado a una página inactiva, no arranca; arranca al activar esa página y ver su nodo;
  - cambiar de página: los agentes corriendo de la otra página siguen vivos y no se remontan sus xterm.
