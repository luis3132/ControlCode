# Extensiones

> Diseño, no implementado todavía. Estado: borrador para revisar.

## 1. Objetivo

Que cualquier desarrollador pueda agregarle a Control Code lo que quiera, con HTML, CSS y JS para la interfaz y un backend nativo (Rust por defecto, pero cualquier lenguaje sirve) para la lógica. Una extensión no se limita a "una pantalla más": puede sumar tools al MCP, comandos, soporte de lenguajes, editores para ciertos archivos, reacciones a eventos y configuración.

Ejemplos de lo que tiene que poder hacerse **sin tocar el código de la app**:

- **Gestor de base de datos.** Una UI para explorar tablas y correr queries, y su propio servidor MCP (`mcp__db-manager__query`, `…__schema`) para que el agente consulte la misma conexión.
- **Docker.** Contenedores, logs, reinicios; el agente puede leer los logs de un contenedor que falla.
- **Lenguajes.** Validación, autocompletado, hover e ir a la definición vía LSP; el agente recibe los diagnósticos como tool.
- **Cliente HTTP, Redis, S3, Linear/Jira, visores de logs**, o lo que se le ocurra a alguien.

### Principios

1. **Lo que comparten la persona y el agente es el mismo estado.** La UI y las tools MCP de una extensión hablan con el *mismo* proceso backend, así que la query que corre el agente aparece en el historial de la UI, y la conexión que configuró la persona es la que usa el agente.
2. **Puntos de contribución + API del host, no features especiales.** La app define *dónde* se puede enchufar algo y *qué* se le puede pedir. Base de datos o Docker son casos particulares.
3. **El protocolo no depende del lenguaje.** Un backend es cualquier ejecutable que hable JSON-RPC por stdio. El SDK oficial es Rust; nada impide hacer uno en Go, Python o Node.
4. **Las features propias tienen que poder escribirse como extensión.** Si diagramas o slides no se pudieran reescribir con esta API, a la API le falta algo. Es la prueba de que está completa.
5. **Una extensión que se cae no se lleva la app.** Por eso el backend es un proceso aparte y no una librería cargada adentro.

## 2. Arquitectura

```
                                       ┌──────────────── App (Tauri) ─────────────────┐
 Agente ──MCP──► ccode mcp --ext <id> ──IPC (TCP+token)──► ExtensionHost            │
                                       │                        │  ▲                    │
                                       │        stdio JSON-RPC  ▼  │ eventos            │
                                       │                  backend de la extensión ──────┼──► Postgres, Docker, rust-analyzer…
                                       │                        ▲                       │
 UI de la extensión ───────────────────┼─ postMessage ─► bridge ┘                       │
 (iframe en view tab)                  └────────────────────────────────────────────────┘
```

Cada extensión con tools es **su propio servidor MCP** para el agente (`mcp__db-manager__query`), aunque por debajo sea un puente a la app, igual que `controlcode`. Ver sección 4.1.

Tres piezas nuevas:

| Pieza | Dónde | Qué hace |
|---|---|---|
| `ExtensionHost` | `src-tauri/src/extensions/` | Descubre extensiones, valida manifests, lanza y supervisa los backends, rutea llamadas y eventos, aplica permisos. |
| Bridge de UI | `src/features/extensions/` | Monta las vistas en iframes sandboxed y les expone `window.controlcode`. |
| Comandos IPC `ext.*` | `src-tauri/src/ipc/commands/extensions.rs` | Para que `ccode mcp --ext` (y la CLI) lleguen a las extensiones: `ext.tools`, `ext.call`, `ext.list`, `ext.command`… |

Todo pasa por la app. Ni la UI ni `ccode mcp` hablan directo con el proceso de la extensión, porque es la app quien aplica permisos, pide aprobaciones y sabe qué extensión está activa en qué workspace.

### Por qué un proceso y no `.so`/WASM

- **Librería dinámica (`.so`/`.dll`):** Rust no tiene un ABI estable, así que cada extensión tendría que compilarse con la misma versión exacta del compilador que la app. Además, un panic o un segfault tira la app entera. Descartada.
- **WASM (wasmtime/WASI):** es aislado, pero WASI todavía no da sockets ni procesos de forma práctica. Un gestor de Postgres, Docker o un servidor LSP necesitan las dos cosas. Queda como posible segundo tipo de backend más adelante, para extensiones que solo transforman datos.
- **Proceso con JSON-RPC por stdio:** es el modelo de LSP y del extension host de VS Code, y el mismo que ya usa `ccode mcp` con Claude Code. Sirve cualquier lenguaje, aísla las caídas y deja reiniciar.

## 3. Anatomía de una extensión

```
~/.controlcode/extensions/db-manager@0.3.0/
├── extension.json        # el manifest
├── bin/
│   ├── linux-x64/db-manager
│   ├── darwin-arm64/db-manager
│   └── windows-x64/db-manager.exe
├── ui/                   # HTML/CSS/JS estático, cualquier framework (ya compilado)
│   ├── index.html
│   └── assets/…
├── skills/               # opcional: skills que se instalan con la extensión
└── README.md
```

Además existen **extensiones de workspace** en `<proyecto>/.controlcode/extensions/`. Viajan con el repo, pero piden confirmación la primera vez que se abre el proyecto, igual que la "confianza de workspace" de VS Code.

### `extension.json`

```jsonc
{
  "id": "acme.db-manager",          // publisher.nombre, único
  "name": "Base de datos",
  "version": "0.3.0",
  "engine": "^1.0",                 // versión de la API de extensiones que necesita
  "description": "Explorar y consultar Postgres, MySQL y SQLite",
  "icon": "ui/icon.svg",

  "backend": {
    "command": {                    // por plataforma; también vale un string único
      "linux-x64": "bin/linux-x64/db-manager",
      "darwin-arm64": "bin/darwin-arm64/db-manager",
      "windows-x64": "bin/windows-x64/db-manager.exe"
    },
    "args": [],
    "scope": "workspace"            // "workspace": un proceso por workspace | "global": uno solo
  },

  "activation": [                    // cuándo se lanza el backend (lazy por defecto)
    "onView:acme.db-manager.explorer",
    "onTool:*",                     // cualquiera de sus tools
    "onFile:**/*.sqlite",
    "onStartup"                     // evitarlo salvo que haga falta
  ],

  "permissions": [
    "network",                      // abrir sockets
    "fs:workspace:read",            // leer archivos del workspace vía la API
    "processes",                    // lanzar procesos visibles en la app
    "secrets"                       // guardar contraseñas en el keychain
  ],

  "contributes": { /* ver sección 4 */ }
}
```

Sobre los permisos: el backend es un ejecutable nativo, así que **nada le impide abrir sockets o leer archivos por su cuenta**. Los `permissions` gobiernan lo que la app le da *a través de la API del host* y lo que se le muestra a la persona al instalar. No son un sandbox, y la documentación tiene que decirlo así (ver sección 9).

## 4. Puntos de contribución

Todo va bajo `contributes`. Cada punto es declarativo: la app lo conoce sin lanzar el backend, así su servidor MCP aparece en el config del agente, los comandos en la paleta y los iconos en la barra sin costo hasta que se usan.

### 4.1 `mcp`: un servidor MCP propio

Cada extensión aporta **su propio servidor MCP**, no tools sueltas dentro de `controlcode`. Así:

- **Cada una tiene sus nombres:** `mcp__db-manager__query`, `mcp__docker__logs`. No hay choques entre extensiones ni prefijos inventados.
- **La persona controla cada servidor:** lo prende o lo apaga por separado, desde `/mcp` en Claude Code o desde la app.
- **`controlcode` queda solo con lo de la app:** navegador, git, procesos, canvas, orquestación.
- **El ecosistema MCP entero se vuelve extensión:** cualquier servidor MCP existente (Postgres, GitHub, Sentry…) puede ser una extensión, con o sin UI propia.

Separar en servidores **no reduce la cantidad de tools** que ve el agente: Claude Code junta las de todos. Lo que la controla es activar extensiones por workspace (sección 14). Ayuda que Claude Code, cuando hay muchas tools MCP, cargue su definición bajo demanda.

Hay dos formas de declararlo.

#### a) Servidor propio, con el backend compartido (`server`)

```jsonc
"mcp": {
  "server": "db-manager",            // nombre con el que lo ve el agente; por defecto el id corto
  "tools": [ /* ver abajo */ ]
}
```

La app agrega al `--mcp-config` de cada tab y de cada tarea de la flota una entrada más:

```jsonc
"db-manager": { "command": "<ccode>", "args": ["mcp", "--ext", "acme.db-manager", "--cwd", "…", "--tab", "…"] }
```

`ccode mcp --ext` es el mismo puente de siempre, pero solo expone las tools de esa extensión y las manda como `ext.call` a la app, que las pasa al **mismo proceso backend que usa la UI**. Esto es lo que mantiene el principio 1: la query que corre el agente aparece en la pantalla de la extensión. Si Claude Code lanzara el backend directamente, habría un proceso por tab, separado del de la UI, y ese estado compartido se perdería.

La aprobación de tools `destructive` sigue pasando por la app, porque toda llamada pasa por ella.

#### b) Servidor MCP externo (`external`)

```jsonc
"mcp": {
  "server": "postgres",
  "external": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-postgres", "${setting:url}"] }
}
```

Para envolver un MCP que ya existe. La app solo lo agrega al config, igual que `languages` declara un servidor LSP, y reemplaza `${setting:…}` y `${secret:…}` al escribirlo.

- **No comparte estado con la UI:** lo lanza Claude Code. Si la extensión también tiene backend y UI, ve sus propias conexiones, no las llamadas del agente.
- **La app no ve sus llamadas:** no puede aplicar `destructive` ni mostrar el historial. Rigen los permisos de Claude Code.

Es la forma más barata de sumar algo, a cambio de esas dos limitaciones.

#### Declarar tools (forma `server`)

```jsonc
"tools": [
  {
    "name": "query",
    "description": "Run a read-only SQL query on a saved connection. Returns at most `limit` rows.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "connection": { "type": "string" },
        "sql": { "type": "string" },
        "limit": { "type": "number" }
      },
      "required": ["connection", "sql"]
    },
    "destructive": false
  },
  {
    "name": "execute",
    "description": "Run a statement that changes data or schema.",
    "inputSchema": { … },
    "destructive": true               // pasa por aprobación de la persona
  }
]
```

El agente las ve como `mcp__db-manager__query`. Los nombres solo tienen que ser únicos dentro de la extensión. Lo que tiene que ser único es el nombre del servidor: no puede ser `controlcode` ni el de otra extensión activa o un MCP que la persona ya tenga configurado. Si choca, la app le agrega un sufijo y lo avisa en la UI de extensiones.

### 4.2 `views`: interfaz

```jsonc
"views": [
  { "id": "explorer", "title": "Base de datos", "entry": "ui/index.html",
    "location": "tab",               // tab | sidebar | panel | canvas | statusbar
    "icon": "ui/db.svg" },
  { "id": "status", "entry": "ui/status.html", "location": "statusbar" }
]
```

- `tab`: un view tab nuevo (`kind: "extension"` en `src/features/tabs/viewTabs.ts`), al lado de archivos, diffs y navegadores.
- `sidebar`: una sección en la barra lateral, como el explorador o Cambios.
- `panel`: abajo, al lado de las terminales.
- `canvas`: un tipo de nodo que se puede poner en las páginas del canvas.
- `statusbar`: un item chico (alto fijo) en la barra de estado.

### 4.3 `commands`: comandos

```jsonc
"commands": [
  { "id": "connect", "title": "Base de datos: Nueva conexión", "keybinding": "ctrl+alt+d" }
]
```

Aparecen en la paleta de comandos y se pueden correr desde la CLI con `ccode ext run acme.db-manager.connect`. Un comando lo ejecuta el backend (`command/execute`) y puede abrir una vista o pedir datos con `ui.input`.

### 4.4 `languages`: soporte de lenguajes (LSP)

```jsonc
"languages": [
  {
    "id": "rust",
    "extensions": [".rs"],
    "server": {
      "command": "rust-analyzer",     // del PATH, o una ruta dentro de la extensión
      "args": [],
      "initializationOptions": {}
    },
    "agentTools": true              // exponer diagnostics/definition/references al agente (tools de `controlcode`)
  }
]
```

Un lenguaje se suma con solo declarar un servidor LSP: una extensión puede no tener backend propio. Ver sección 8.

### 4.5 `editors`: abrir archivos con una UI propia

```jsonc
"editors": [
  { "view": "explorer", "files": ["**/*.sqlite", "**/*.db"], "priority": "default" }
]
```

`default` hace que abrir el archivo lo muestre en esa vista; `option` lo agrega al menú "Abrir con…".

### 4.6 `events`: hooks

```jsonc
"events": ["file.saved", "agent.taskFinished", "workspace.opened", "git.committed"]
```

El backend recibe una notificación `event/<nombre>`. Sirve, por ejemplo, para correr un linter al guardar o para avisar en Slack cuando termina una tarea de la flota.

### 4.7 `settings`

```jsonc
"settings": {
  "maxRows": { "type": "number", "default": 500, "description": "Filas máximas por query" },
  "readOnlyAgent": { "type": "boolean", "default": true }
}
```

La pantalla de settings arma el formulario sola a partir del esquema (JSON Schema).

### 4.8 Otros

- `skills`: skills que se instalan con la extensión y se desinstalan con ella, usando el sistema actual de `src-tauri/src/skills`.
- `processes`: presets para `process_start`, por ejemplo "docker compose up".
- `themes`: archivos de CSS vars que se suman a los temas de la app.

## 5. Protocolo del backend

JSON-RPC 2.0, un mensaje por línea, por stdin/stdout. Lo que el backend escriba en stderr va a un log que se puede ver desde la UI de extensiones. Es bidireccional: la app llama al backend y el backend llama a la app (la API del host).

### Ciclo de vida

```
app → initialize        { apiVersion, extensionId, workspace: { cwd } | null,
                          settings, platform, locale }
backend ← result        { capabilities: { tools: true, commands: true, … } }
app → initialized
… llamadas en los dos sentidos …
app → shutdown          (el backend tiene 5 s para cerrar conexiones)
app → exit
```

### Lo que la app le pide al backend

| Método | Cuándo |
|---|---|
| `tool/call { name, arguments, caller }` | El agente usó una tool. `caller` dice qué tab o tarea, para que el backend pueda mostrarlo ("lo corrió el agente de la tab 3"). Devuelve un `CallToolResult` de MCP (`content: [...]`, `isError`). |
| `ui/call { view, method, params }` | La UI llamó a `controlcode.call()`. |
| `command/execute { id, args }` | Comando de la paleta o de la CLI. |
| `settings/changed { settings }` | La persona cambió la configuración. |
| `event/<nombre> { … }` | Uno de los `events` a los que se suscribió. |
| `$/cancel { id }` | El agente o la UI canceló una llamada en curso. |

### Lo que el backend le pide a la app

Todo método que empiece con `host/` es la API del host (sección 6). Además:

- `ui/emit { view?, event, data }`: un evento a sus vistas abiertas (sin `view`, a todas).
- `tools/changed`: cambió su lista de tools dinámicas (ver más abajo).
- `log { level, message }`.

### Supervisión

- Si el proceso muere, las llamadas en curso fallan con un error claro y se relanza en la próxima activación. Después de 3 caídas en 1 minuto, la extensión queda en estado "falló", con el log visible y un botón para reintentar.
- Cada `tool/call` tiene timeout: 60 s por defecto, configurable por tool con `timeoutSecs` hasta el tope que use `ccode mcp`.
- Si el backend está inactivo, sin vistas abiertas ni llamadas por 10 minutos y con `scope: workspace`, se apaga y se relanza al volver a necesitarse.

### Tools dinámicas

Algunas extensiones no saben sus tools de antemano; por ejemplo, una que expone cada endpoint de una API OpenAPI. Pueden declarar `"dynamicTools": true` y responder `tools/list`. Como Claude Code pide la lista al arrancar, cuando cambia se manda `notifications/tools/list_changed` por su `ccode mcp --ext`. **Hay que verificar** que Claude Code la respete en caliente. Si no, el cambio llega en la próxima tab.

## 6. API del host

Lo que una extensión puede pedirle a Control Code. Está disponible igual desde el backend (`host/<grupo>.<acción>` por JSON-RPC) y desde la UI (`controlcode.host.<grupo>.<acción>()`), con la diferencia de que la UI solo accede a un subconjunto (marcado **UI**). Cada grupo requiere el permiso indicado.

| Grupo | Métodos | Permiso | UI |
|---|---|---|---|
| `workspace` | `info` (cwd, nombre, rama), `list` | — | sí |
| `fs` | `read`, `write`, `list`, `watch`, `stat`, limitado al workspace | `fs:workspace:read` / `:write` | sí (lectura) |
| `editor` | `open(path, line?)`, `activeFile`, `selection`, `publishDiagnostics`, `decorate` | `editor` | sí (`open`) |
| `ui` | `notify`, `input` (prompt), `pick` (lista), `openView`, `statusbar.set` | — | sí |
| `processes` | `start`, `send`, `output`, `stop`: los mismos de `src-tauri/src/procs` y visibles en la app | `processes` | no |
| `agents` | `ask` (como `ask_user`), `task.add`, `task.status`, `roster`, `tabs.list`, `tabs.send` | `agents` | no |
| `git` | `status`, `diff`, y la cuenta del usuario: `pr.create`, `issue.list`, `checks` (lo de `forge`) | `git` / `git:account` | no |
| `browser` | `navigate`, `snapshot`, `eval` sobre el navegador del proyecto | `browser` | no |
| `storage` | `get`, `set`, `delete`, `keys`: clave/valor propio, global o por workspace | — | sí |
| `secrets` | `get`, `set`, `delete`, sobre el keychain del sistema | `secrets` | no |
| `extensions` | `list`, `callTool(id, name, args)`, `executeCommand` | `extensions` | no |
| `events` | `emit(nombre, data)`: eventos propios que otras extensiones pueden escuchar | — | no |

Notas:

- **No se inventa nada en paralelo.** `processes`, `agents`, `git`, `browser` y `canvas` llaman a los mismos handlers que ya usan la CLI y el MCP (`src-tauri/src/ipc/commands/dispatch.rs`). La API del host es otra puerta a ese mismo router, con un filtro de permisos delante.
- **`secrets` en vez de `storage` para credenciales.** El gestor de base de datos guarda la contraseña de cada conexión ahí, nunca en texto plano.
- **`editor.publishDiagnostics`** permite validar sin LSP: un linter propio puede marcar errores en el editor directamente.

## 7. Interfaz de las extensiones

### Aislamiento

- Cada vista es un `<iframe sandbox="allow-scripts allow-forms">`, **sin** `allow-same-origin`, servido desde un protocolo propio registrado en Tauri: `ccext://<id>/<ruta>`. El handler solo sirve archivos de la carpeta `ui/` de esa extensión.
- La CSP del iframe bloquea `connect-src` externos por defecto. Una extensión que necesite red desde la UI la declara (`"uiConnect": ["https://api.example.com"]`); lo recomendado es pasar por su backend.
- El iframe no ve `window.__TAURI__` ni puede llamar `invoke`. Todo pasa por el bridge.

### `window.controlcode`

Un script de unos pocos KB que la app inyecta en cada vista. Habla por `postMessage` con el bridge de la app, que valida el origen, el id de la extensión y los permisos.

```ts
// Al backend de su propia extensión
const tables = await controlcode.call("list_tables", { connection: "dev" });

// Eventos que emite su backend (ui/emit)
const off = controlcode.on("query-ran", (q) => history.push(q));

// API del host (subconjunto UI)
await controlcode.host.editor.open("src/db/schema.sql", { line: 12 });
await controlcode.host.ui.notify("Conexión guardada");
const value = await controlcode.host.storage.get("lastConnection");

// Contexto y estado de la vista
controlcode.context;      // { extensionId, viewId, workspace, locale }
controlcode.state.get();  // estado que sobrevive a cerrar y reabrir la tab
controlcode.state.set({ selectedTable: "users" });
```

Tipos publicados en `@controlcode/extension-ui` (npm), para quien usa TS o un framework.

### Tema

El bridge inyecta las CSS vars del tema activo (`--cc-bg`, `--cc-fg`, `--cc-accent`, `--cc-border`, `--cc-font-mono`…) y las actualiza cuando cambia. También ofrece una hoja de estilos base opcional (`ccext://_/base.css`) con botones, inputs y tablas al estilo de la app, para que una extensión se vea nativa sin esfuerzo.

## 8. Lenguajes: LSP en el editor

Es la pieza que más acerca la app a un IDE, y vale como feature por sí sola.

- **En la app:** un cliente LSP en Rust (`src-tauri/src/lsp/`), uno por lenguaje y workspace, lanzado según `contributes.languages`. Mantiene los documentos abiertos sincronizados (`didOpen`/`didChange`/`didSave`).
- **En el editor (CodeMirror, `src/features/editor/`):** extensiones de CodeMirror que muestran diagnósticos (lint gutter + subrayados), autocompletado, hover, firma, ir a la definición, renombrar, formatear y code actions. `@codemirror/lint` y `@codemirror/autocomplete` cubren la parte visual; lo que falta es conectarlos con LSP.
- **Para el agente** (`agentTools: true`), tools genéricas que sirven para cualquier lenguaje con extensión. Van en el servidor `controlcode`, no en uno por lenguaje, porque las implementa la app y son las mismas para todos:
  - `lsp_diagnostics(path?)`: errores y warnings de un archivo o del workspace.
  - `lsp_definition(path, line, column)` y `lsp_references(...)`.
  - `lsp_hover(path, line, column)`: tipos y documentación.
  - `lsp_symbols(query)`: buscar símbolos en el workspace.

  Con esto el agente puede verificar que su cambio compila sin correr el build entero, y navegar código por símbolos y no solo por grep.
- **Panel de Problemas:** lista los diagnósticos de todo el workspace. Comparte la fuente con la tool `lsp_diagnostics`, así la persona y el agente ven lo mismo.

Más adelante, con el mismo patrón: **DAP** (Debug Adapter Protocol), con el punto `contributes.debuggers`.

## 9. Seguridad y confianza

Hay que ser honestos: **una extensión con backend corre con los permisos del usuario**, igual que en VS Code. Lo que sí se puede controlar:

- **Al instalar:** se muestran el publisher, el origen (registry, repo, local) y los permisos declarados, y se pide confirmación. Si una actualización pide permisos nuevos, se pide confirmación de nuevo.
- **Integridad:** los binarios de un release traen un `checksums.json` (sha256) que se verifica al descargar. Más adelante, firma con una clave del publisher.
- **API del host:** cada llamada pasa por el filtro de permisos. Sin `agents`, una extensión no puede lanzar tareas, aunque sea nativa.
- **Tools destructivas** (solo en la forma `server` de la sección 4.1; un MCP `external` no pasa por la app): `destructive: true` hace que la llamada del agente pase por aprobación, con el mismo flujo de `approve_tool_use` y la tarjeta del chat en tabs HTML. En una tab de TUI, Claude Code ya pide permiso por tool MCP según su configuración. La app puede pedir una segunda confirmación propia para estas.
- **Extensiones de workspace** (`.controlcode/extensions/` en el repo): nunca se activan solas. La primera vez se pregunta, y la respuesta se recuerda por hash del manifest + binarios, así un cambio en el repo vuelve a preguntar.
- **UI:** iframe sin `same-origin` ni acceso a Tauri, con CSP estricta. Una UI maliciosa solo puede hacer lo que su propia extensión ya podía.
- **Desactivar todo:** `controlcode --disable-extensions`, y un modo seguro en la UI si la app no arranca bien.

## 10. Desarrollo de extensiones

### SDK de Rust: `controlcode-extension`

```rust
use controlcode_extension::{prelude::*, tool, ui_method, command};

#[derive(Default)]
struct Db { pools: Mutex<HashMap<String, PgPool>> }

#[tool(description = "Run a read-only SQL query on a saved connection")]
async fn query(ext: &Ext<Db>, connection: String, sql: String, limit: Option<u32>)
    -> Result<QueryResult>
{
    let rows = ext.state().run(&connection, &sql, limit.unwrap_or(500)).await?;
    ext.emit("query-ran", json!({ "sql": sql, "by": ext.caller() })).await?; // la UI lo muestra
    Ok(rows)
}

#[ui_method]
async fn list_tables(ext: &Ext<Db>, connection: String) -> Result<Vec<Table>> { … }

#[command(id = "connect")]
async fn connect(ext: &Ext<Db>) -> Result<()> {
    let url = ext.host().ui().input("URL de conexión").await?;
    ext.host().secrets().set(&format!("conn:{url}"), &url).await?;
    Ok(())
}

controlcode_extension::main!(Db; query, list_tables, connect);
```

- `#[tool]` usa el nombre de la función como nombre de la tool (`mcp__db-manager__query`) y genera el `inputSchema` a partir de la firma, con `schemars`, y lo puede volcar al manifest con `cargo ccext manifest`.
- `ext.host()` es un cliente tipado de toda la API del host.
- `Result` se convierte en un `CallToolResult` con `isError` si falla.

### CLI para desarrolladores

```bash
ccode ext new mi-extension --template rust+react   # también: rust+vanilla, ts, language
ccode ext dev                                       # la instala apuntando a la carpeta, con recarga
ccode ext pack                                      # arma el .ccext (zip) con binarios por plataforma
ccode ext list | enable | disable | uninstall | logs <id>
```

`ccode ext dev` recompila el backend con cargo watch y recarga los iframes al cambiar `ui/`, sin reiniciar la app.

### Paquete `.ccext`

Es un zip con la misma estructura de la sección 3. Se puede instalar con `ccode ext install ./x.ccext`, desde una URL, o desde un registry.

## 11. Distribución

Se reusa el marketplace (`src-tauri/src/marketplace/`), que hoy maneja registries de skills en GitHub:

- Un registry lista extensiones (id, repo, versiones). Cada versión es un release de GitHub con un `.ccext` por plataforma, o uno solo con todos los binarios.
- La pestaña de marketplace suma "Extensiones" junto a "Skills". Las acciones son instalar, actualizar (manual o automática), desactivar y desinstalar.
- Las versiones respetan `engine`: una extensión que pide una API más nueva que la de la app no se ofrece.

## 12. Cambios en el código existente

| Lugar | Cambio |
|---|---|
| `src-tauri/src/extensions/` (nuevo) | `manifest.rs` (parseo y validación), `registry.rs` (descubrir, habilitar, por workspace), `host.rs` (procesos, JSON-RPC, supervisión), `api.rs` (API del host + permisos), `protocol.rs` (handler `ccext://`). |
| `src-tauri/src/ipc/commands/extensions.rs` (nuevo) | `ext.tools`, `ext.call`, `ext.list`, `ext.run`, `ext.install`… y su entrada en `dispatch.rs`. |
| `src-tauri/src/ipc/mcp.rs` | Un `McpContext` nuevo para `--ext <id>`: `tools_for` devuelve solo las tools de esa extensión (`ext.tools`) y `call_tool` las manda como `ext.call`. Manejo de `tools/list_changed`. Las tools de `controlcode` no cambian. |
| Escritura de `--mcp-config` (`tab_browser_mcp`/`chat_mcp` en `mcp.rs`, `write_mcp_config` en `runs/supervisor.rs`, adaptadores de Codex/Gemini) | Agregar una entrada por extensión activa en el workspace: `ccode mcp --ext …` para la forma `server`, el comando tal cual para `external`. |
| `src-tauri/src/bin/cli.rs` | `mcp --ext <id>`, subcomandos `ext …` y timeouts de `ext.call`. |
| `src-tauri/src/database/schema.rs` | Tabla de extensiones instaladas, habilitadas por workspace y confianza de workspace. |
| `src-tauri/tauri.conf.json` | Registro del protocolo `ccext` y CSP. |
| `src/features/extensions/` (nuevo) | Bridge `postMessage`, `ExtensionView` (iframe), página de gestión, settings generados. |
| `src/features/tabs/viewTabs.ts` | `kind: "extension"` con `{ extensionId, viewId, state }`. |
| `src/features/canvas/` | Nodo `extension-view`. |
| `src/features/editor/` + `src-tauri/src/lsp/` (nuevo) | Cliente LSP y su integración en CodeMirror (fase 3). |
| `src/features/marketplace/` | Sección de extensiones (fase 5). |

## 13. Fases

1. **Host de extensiones.** El manifest, el registro, los procesos con supervisión, el protocolo JSON-RPC, la API del host básica (`workspace`, `ui`, `storage`, `secrets`, `fs`) y los puntos `mcp` (las dos formas, con `ccode mcp --ext`) y `commands`. Instalación local con `ccode ext dev`. *Listo cuando:* una extensión de ejemplo aparece como su propio servidor MCP y el agente usa su tool desde una tab.
2. **UI.** El protocolo `ccext://`, los iframes, `window.controlcode`, el tema, las ubicaciones `tab` y `sidebar` y la página de gestión. *Listo cuando:* la query que corre el agente aparece en vivo en la UI de la extensión.
3. **Gestor de base de datos** como primera extensión oficial (SQLite + Postgres con `sqlx`), escrita solo con la API pública. Sirve para encontrar lo que falta antes de publicar el SDK.
4. **Lenguajes.** El cliente LSP, la integración en CodeMirror, el panel de Problemas y las tools `lsp_*`. Extensiones oficiales para Rust, TS/JS y Python que solo declaran el servidor.
5. **SDK y plantillas.** El crate `controlcode-extension`, `@controlcode/extension-ui`, `ccode ext new/pack` y la documentación para desarrolladores.
6. **Resto de contribuciones y distribución.** `editors`, `events`, `settings`, `panel`/`canvas`/`statusbar`, el marketplace, las actualizaciones y la confianza de workspace.

## 14. Preguntas abiertas

- **`tools/list_changed` en Claude Code.** ¿Recarga las tools en caliente? Define si instalar una extensión requiere reiniciar las tabs abiertas.
- **Cantidad de tools.** Un servidor por extensión ordena los nombres, pero no reduce el total. Propuesta: las extensiones se activan **por workspace** (un proyecto sin base de datos no lleva `db-manager` en su config) y se confía en la carga diferida de Claude Code cuando hay muchas. A medir con 5–10 extensiones activas antes de agregar algo más.
- **MCP `external` y estado compartido.** ¿Vale ofrecer una forma de que un MCP externo pase por la app (la app lo lanza y hace de proxy), para tener historial y aprobación de `destructive` también ahí?
- **Otros agentes.** Codex, Gemini y similares, si la app los soporta: ¿reciben los mismos servidores vía su propio config MCP? `ccode mcp --ext` es estándar, así que en principio sí; hay que sumarlos en sus adaptadores (`extra_args` de Codex, etc.).
- **Backends WASM** como segunda opción para extensiones sin red ni procesos: ¿valen la complejidad?
- **Firma de extensiones:** ¿clave por publisher o confianza en el registry?
- **¿Migrar features propias?** Por ejemplo, diagramas o slides como extensiones oficiales, para validar el principio 4.
