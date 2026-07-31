# Control Code — Plan de Desarrollo por Fases

## Resumen del proyecto

Control Code es una aplicación de escritorio (Tauri 2.0) que actúa como command center para herramientas de AI coding agents (Claude Code, Gemini CLI, Codex, OpenCode). Combina gestión de sesiones, skills globales con symlinks, workspaces jerárquicos con aislamiento de contexto, y una UI tipo browser con tabs que se pueden separar en ventanas independientes (tear-off, como Chrome). Expone además una CLI propia para que cualquier agente de IA pueda orquestar la app mediante una skill incluida.

## Stack

- Tauri 2.0 (Rust backend, múltiples ventanas nativas)
- React + shadcn/ui + Tailwind (frontend)
- xterm.js + pty (terminales embebidos)
- tmux como capa de persistencia/migración de terminales entre ventanas
- Zustand (estado frontend)
- SQLite vía rusqlite (persistencia: workspaces, tabs, skills, configuración)
- reqwest (cliente HTTP para registries de skills)

---

## FASE 0 — Setup y validación técnica (1-2 semanas)

Objetivo: validar que las piezas más riesgosas del proyecto son técnicamente viables antes de invertir en el resto.

- Scaffolding del proyecto Tauri 2.0 (React + TypeScript + Rust)
- Spike: embeber una terminal funcional con xterm.js + pty en Rust, ejecutar `claude` dentro y confirmar que el control interactivo (TTY) funciona bien
- Spike: probar viabilidad de tmux como capa intermedia para detach/attach de sesiones entre ventanas
- Spike: crear una segunda ventana nativa de Tauri desde el mismo proceso y confirmar que pueden compartir estado (vía eventos Tauri o estado en Rust)
- Definir el schema inicial de SQLite (workspaces, windows, tabs, skills, project_skills)
- Decisión go/no-go sobre tmux vs alternativa (pty crate directo + reconexión manual)

Entregable: un prototipo mínimo con una ventana, una tab, una terminal funcional corriendo Claude Code.

---

## FASE 1 — Terminal embebido y gestión básica de tabs (2-3 semanas)

Objetivo: UI tipo browser funcional, sin persistencia ni multi-ventana todavía.

- Barra de tabs estilo Chrome (crear, cerrar, reordenar, renombrar)
- Botón `+` con flujo de 2 pasos: selección de carpeta (raíz actual / subcarpeta / nueva) y selección de herramienta (Claude Code, Gemini CLI, Codex, OpenCode, terminal pura)
- Terminal embebido por tab, lanzando el proceso correspondiente en el cwd elegido
- Barra de ruta debajo de los tabs (estilo barra de URL)
- Sidebar colapsable con los 5 accesos (aún sin implementar las vistas)
- Auto-detección de agentes instalados en el PATH del sistema

Entregable: app usable para abrir múltiples tabs con distintos agentes en distintas carpetas, dentro de una sola ventana.

---

## FASE 2 — Persistencia y restauración de estado (2 semanas)

Objetivo: que cerrar y abrir la app no pierda nada, tambien que cuando se abra una pestaña nueva o se haga mergue de una ventana a otra se abra con el mismo estado con el que se cerró o movió.

- Diseño final del schema SQLite para workspaces, tabs, ventanas (posición, tamaño, monitor)
- Guardar automáticamente el estado de tabs abiertas por workspace
- Restaurar al iniciar: mismas tabs, mismos cwd, mismo agente, mismo orden
- Vista Home: listar 5 workspaces/proyectos recientes con ruta raíz, fecha de última actividad
- Generación de título legible por sesión (usar el campo de resumen del JSONL si existe, o fallback al primer mensaje del usuario truncado)

Entregable: cerrar la app y reabrirla reproduce el estado exacto de la última sesión de trabajo.

---

## FASE 3 — Workspaces jerárquicos (2-3 semanas)

Objetivo: el diferenciador central del producto.

- Modelo de datos: workspace con raíz, terminal global, y N tabs cada una con su propio cwd aislado
- UI para crear/gestionar un workspace (agrupación de tabs, visualización como grupo tipo Chrome tab groups)
- Garantizar que el contexto de cada agente está limitado a su subcarpeta hacia abajo (validar con Claude Code y Gemini CLI que no escalan al padre)
- Terminal global del workspace con acceso a la raíz completa
- Persistencia de la estructura jerárquica en SQLite

Entregable: se puede crear un workspace de un monorepo con múltiples paneles aislados por subcarpeta, y se persiste correctamente.

---

## FASE 4 — Multi-ventana y tear-off tabs (3 semanas, la fase más compleja técnicamente)

Objetivo: tabs que se pueden arrastrar fuera para crear ventanas nativas independientes, sin interrumpir los procesos.

- Detectar drag de una tab fuera del área de tabs
- Crear nueva WebviewWindow de Tauri al soltar
- Migrar la conexión de la terminal (pty/tmux) de la ventana original a la nueva sin matar el proceso del agente
- Sincronizar estado entre todas las ventanas abiertas (mismo backend Rust, eventos compartidos)
- Persistir posición, tamaño y monitor de cada ventana
- Restaurar múltiples ventanas en sus posiciones originales al reabrir la app

Entregable: arrastrar una tab fuera de la ventana crea una ventana nueva sin perder la sesión del agente; cerrar y reabrir la app restaura todas las ventanas.

---

## FASE 5 — Skills Manager con symlinks globales (2-3 semanas)

Objetivo: gestión centralizada de skills sin duplicación de archivos.

- Directorio global de skills configurable (default `~/.controlcode/skills/`)
- Vista de skills instaladas: listar, ver qué proyectos las usan, editar SKILL.md, borrar (con advertencia de impacto)
- Sistema de symlinks: al activar una skill para un proyecto/tab, crear symlink hacia la copia global
- Herencia de skills: workspace-level (todas las tabs) vs tab-level (solo esa tab)
- Health check de symlinks al abrir un workspace (detectar y avisar de symlinks rotos)
- Vista de configuración por proyecto: toggles para activar/desactivar skills por workspace y por tab

Entregable: se puede instalar una skill una sola vez y asignarla selectivamente a distintos proyectos/tabs sin duplicar archivos.

---

## FASE 6 — Marketplace y repositorios de skills configurables (2-3 semanas)

Objetivo: descubrir e instalar skills desde múltiples fuentes.

- Definir formato abierto de `registry.json` (id, descripción, tags, compatibilidad, path)
- Cliente para consumir registries vía HTTP (reqwest) con cache local (TTL configurable)
- Soporte para fuentes: GitHub repo, URL con manifest JSON, carpeta local, git genérico
- Repos preconfigurados por defecto: skills.sh (autoskills de midudev), anthropics/skills
- Vista de gestión de repositorios (agregar, quitar, priorizar, refrescar)
- UI de marketplace: búsqueda, filtros por categoría/tecnología, instalación con un click
- Scan automático de SKILL.md para repos sin manifest formal

Entregable: el usuario puede agregar un repositorio propio o de terceros y descargar skills desde la UI.

---

## FASE 7 — Session Manager completo (1-2 semanas)

Objetivo: historial completo, no solo lo reciente.

- Parseo de JSONL de sesiones de cada agente soportado (rutas distintas por herramienta)
- Agrupación por workspace y por subcarpeta
- Vista de historial completo con filtros (agente, proyecto, fecha, skill usada)
- Acciones: reabrir sesión, borrar, exportar a markdown
- Mostrar qué configuración de tabs/skills tenía cada sesión histórica

Entregable: vista de historial navegable y accionable de todas las sesiones pasadas, sin importar cuándo ocurrieron.

---

## FASE 8 — CLI propia y skill de orquestación (2-3 semanas)

Objetivo: que cualquier agente externo pueda controlar la app.

- Diseño y construcción de la CLI `controlcode` (Rust, comunicándose con la instancia corriendo de la app vía IPC local o socket)
- Comandos mínimos: `tab create/close/list/output/send`, `window create/list`, `workspace open/status`, `skill install/list`
- Output en JSON parseable para consumo por agentes
- Redacción del `SKILL.md` de orquestación incluido con la app, instalable en Claude Code / Gemini CLI / otros
- Pruebas reales: usar Claude Code con la skill para crear tabs, leer outputs y orquestar un workspace completo

Entregable: se puede decirle a Claude Code "abre tres tabs para este monorepo" y lo ejecuta vía la CLI sin intervención manual.

---

## FASE 9 — Mitigación de consumo de tokens del orquestador (1-2 semanas)

Objetivo: evitar que el modo orquestador agote el contexto del modelo. Esta fase es obligatoria antes de promover el modo orquestador como feature estable.

- Implementar resumen comprimido de outputs en vez de devolver terminal completa (`tab output` devuelve señales: errores, warnings, últimas N líneas relevantes)
- Modo push de eventos: las tabs notifican al orquestador solo en eventos relevantes (error, proceso terminado), en vez de polling constante
- Límite configurable de tabs monitoreadas simultáneamente por el orquestador (default 3)
- Contexto por invocación, no acumulativo entre llamadas
- Indicador en UI de consumo estimado de tokens cuando el modo orquestador está activo con múltiples tabs

Entregable: el modo orquestador puede operar sobre 5+ tabs sin agotar el contexto del modelo en una sesión típica.

---

## FASE 10 — Pulido y features adicionales (continuo, post-MVP)

- Quick switcher (Cmd+K) para sesiones, proyectos y skills
- Workspace snapshots con nombre (presets reutilizables)
- Importación automática de proyectos existentes (detectar `.claude/`, `AGENTS.md`)
- Usage analytics local sin telemetría
- Soporte multi-perfil (separar skills personales de skills de cliente)
- Empaquetado y distribución (instaladores para Linux, macOS, Windows)

---

## FASE 11 — Gestión de MCPs (3-4 semanas)

Objetivo: instalar un MCP una sola vez y asignarlo selectivamente a workspaces/tabs, igual que las skills — pero resolviendo que cada agente configura MCPs de forma distinta.

### Hallazgo que define el diseño

Los agentes se parten en dos familias, y de eso depende cuánto aislamiento se puede dar:

- **Familia A — aceptan la config por invocación** (no hay que tocar ningún archivo del usuario):
  - Claude Code: `--mcp-config <archivo.json>` (admite varios, se mergean, gana el último) y `--strict-mcp-config`, que ignora todas las demás fuentes (`~/.claude.json`, `.mcp.json`, config gestionada).
  - Codex: respeta `CODEX_HOME`, así que se le puede apuntar a un directorio generado con su propio `config.toml`.
- **Familia B — solo leen de una ruta fija** (hay que escribir en el proyecto):
  - Gemini CLI: `~/.gemini/settings.json` o `.gemini/settings.json`, clave `mcpServers`.
  - OpenCode: `opencode.json`, clave `mcp`. Además expone `opencode mcp add|list|auth|logout|debug` (verificado contra la v1.18.4), así que la gestión puede delegarse en su propia CLI en vez de escribir el archivo a mano — incluido `auth`, que resuelve el OAuth de los servidores que lo pidan.

Con la familia A se consigue aislamiento **por tab** (dos tabs en la misma carpeta con MCPs distintos). Con la B, el techo es por carpeta, igual que los symlinks de skills.

### Tareas

- Modelo de datos gemelo del de skills: `mcp_servers` (catálogo global) + `project_mcps` (intención de attach con scope `workspace`/`tab`). Reutiliza herencia, "qué proyectos lo usan" y borrado con aviso de impacto.
- Copias globales en `~/.controlcode/mcp/<repo>/<servidor>/`, mismo layout por repositorio que las skills.
- Resolución canónica: `project_mcps` → set de MCPs de la tab → adaptador por agente.
- Adaptadores, en orden de preferencia:
  1. **Flag por tab** (Claude Code): generar `~/.controlcode/mcp/<tab_id>.json` y lanzar con `--mcp-config <archivo> --strict-mcp-config`.
  2. **Env por tab** (Codex): generar un `CODEX_HOME` por tab e inyectarlo (`pty_create` ya acepta `env`).
  3. **Archivo por cwd** (Gemini, OpenCode): mergear en el archivo del proyecto tocando **solo las claves que creó Control Code**, con manifiesto de claves gestionadas y reconciliación. Nunca reescribir el archivo entero.
- Importador de lo que el usuario ya tiene configurado (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`): puebla el catálogo sin red y sin adaptadores nuevos.
- Marketplace de MCPs reutilizando la infraestructura de registries (columna `kind` en `registries`), con el registro oficial `registry.modelcontextprotocol.io` como fuente por defecto — API pública, sin auth, `GET /v0/servers?search=&limit=`.
- Secretos por referencia (`"GITHUB_TOKEN": "${GITHUB_TOKEN}"`), expandidos al materializar y nunca almacenados. El registro oficial ya marca `isRequired`/`isSecret` por variable, así que el wizard puede generarlas solo. Keyring del SO queda para más adelante.
- Health check propio: ¿el binario de `command` está en el PATH?, ¿la URL responde?, ¿las variables referenciadas están definidas?, ¿el archivo generado sigue siendo válido?
- UI espejo de la de skills: página de MCPs, detalle, diálogo de attach y un paso en el wizard de tab nueva.

### Prerequisito

`pty_create` parsea el comando con `split_whitespace()` (`pty_manager.rs`), así que se rompe con `--mcp-config /una/ruta con espacios/x.json`. Hay que reemplazarlo por un parser tipo shell-words **antes** de empezar esta fase.

### Riesgos

- Hay issues abiertos reportando que `--mcp-config` y `--strict-mcp-config` se ignoran en algunas versiones de Claude Code. Verificar contra la versión instalada antes de apoyar la estrategia 1 en producción.
- La estrategia 3 escribe en archivos que son del usuario: es la única del proyecto que modifica contenido ajeno en vez de solo agregar symlinks. Necesita backup antes de la primera escritura y tests dedicados.

Entregable: se puede instalar un MCP desde el registro oficial, asignarlo a una tab concreta, y que esa tab arranque viendo exactamente esos servidores sin que se filtren a las demás.

---

## Notas de priorización

- Las fases 0-4 son el núcleo técnico (terminal + persistencia + multi-ventana). Sin esto no hay producto.
- Las fases 5-7 (skills + marketplace + sessions) son el segundo bloque de valor y pueden desarrollarse en paralelo una vez el núcleo esté estable.
- Las fases 8-9 (orquestador) son las más experimentales y arriesgadas — considerar lanzarlas como feature opcional/beta, no como parte del MVP inicial.
- Riesgo técnico más alto: Fase 4 (tear-off de tabs con migración de pty sin interrumpir procesos). Vale la pena un spike dedicado antes de comprometerse con el diseño final.
- La Fase 11 (MCPs) depende del modelo de datos y del marketplace de las fases 5-6, así que va después de ellas — pero no depende del orquestador. Se puede hacer antes que las fases 8-9 si los MCPs resultan más valiosos que el modo orquestador. De hecho `--strict-mcp-config` aporta directamente a la Fase 9: los MCPs son de lo que más contexto consume, y acotar cuáles ve cada tab es un ahorro medible.
