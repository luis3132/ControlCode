# ccmem — variante 2: mismo repositorio, misma independencia

> Plan alternativo a [`plan-ccmem.md`](./plan-ccmem.md). Todo lo que no se menciona acá (esquema de la DB, ingesta, destilado, redacción, seguridad, ranking, matriz de agentes) es **idéntico** al plan 1. Lo que cambia es la topología, el fasado y la deuda técnica.

---

## La pregunta: ¿se puede tener todo en el mismo repo sin perder independencia?

**Sí, y además sale mejor.** La confusión habitual es tratar "repo separado" y "producto independiente" como la misma cosa. No lo son:

| Propiedad | La da el… | ¿Se pierde en monorepo? |
|---|---|---|
| Instalable solo (`cargo install`, brew, releases) | **empaquetado** | No |
| No depende de ControlCode para guardar sesiones | **DB propia + cero deps de compilación** | No |
| Las TUIs agénticas leen el historial por MCP | **protocolo MCP stdio** | No |
| Versionado/tags propios | **tags con prefijo** (`ccmem-v0.1.0`) | No |
| Sin duplicar el código de transcripts | **workspace de cargo** | Se **gana** |

Lo único que un repo separado da de verdad es una *marca* separada y un `git log` limpio. Lo que cuesta es lo caro: `session/title.rs` + `session/export.rs` son ~750 líneas de conocimiento verificado sobre dónde esconde cada CLI sus transcripts, y en dos repos eso se bifurca en un mes.

### Las tres invariantes que garantizan la independencia

Estas tres reglas se escriben en el README del workspace y se testean en CI. Mientras se cumplan, estar en el mismo repo es puramente un detalle de dónde vive el código:

1. **Compilación**: `ccmem-cli` y sus crates **no** dependen de `tauri`, `portable-pty`, ni `controlcode_lib`. Test en CI: `cargo tree -p ccmem-cli | grep -q tauri && exit 1`.
2. **Runtime**: `ccmem` abre **su propia** DB en `~/.ccmem/mem.db`. `~/.controlcode/data.db` se abre en **solo lectura y de forma opcional** (`file:…?mode=ro`), tolerando `NotFound`. Test: correr toda la suite con `HOME` apuntando a un tmpdir vacío — todo verde.
3. **Distribución**: `cargo install --git https://github.com/luis3132/ControlCode ccmem-cli` y los binarios de release funcionan sin que la app se instale nunca. Test: instalar el binario en un contenedor limpio y correr `ccmem doctor`.

### Y las TUIs agénticas, ¿acceden al historial por MCP?

Sí, y no cambia una línea respecto del plan 1. El servidor MCP (`ccmem mcp`) es un proceso stdio que el agente lanza; expone `mem_recall_chat(query, agent?, project?, limit)` sobre la tabla `turns` — o sea, búsqueda cruda sobre **todos** los transcripts indexados de **todos** los agentes, no solo los que pasaron por ControlCode. Cualquier cliente MCP (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, VS Code, Qwen, Kiro) lo consume igual.

El punto que importa: **el índice de chats se llena leyendo los archivos de cada CLI directamente**, no la `session_history` de ControlCode. La app aporta una señal *extra* y opcional (qué skills estaban attachadas), nunca la fuente de verdad de las sesiones. Si borrás ControlCode del disco, `ccmem` sigue indexando y sirviendo el historial completo.

---

## Topología

```
ControlCode/
├── Cargo.toml                    ← NUEVO: [workspace] resolver = "2"
│                                    members = ["src-tauri", "crates/*"]
├── Cargo.lock                    ← se mueve acá desde src-tauri/
├── target/                       ← se mueve acá desde src-tauri/target/
├── crates/
│   ├── ccmem-transcripts/        descubrimiento + lectura streaming por agente
│   ├── ccmem-skilllink/          convenciones de symlinks de skills
│   ├── ccmem-core/               storage SQLite+FTS5, ranking, destilado, retrieval
│   ├── ccmem-mcp/                servidor MCP stdio
│   └── ccmem-cli/                [[bin]] ccmem
├── src-tauri/                    la app, package `controlcode` sin cambios de nombre
├── src/                          frontend React
├── skills/                       skills que la app publica
├── plan.md                       plan original de la app (fases 0-10)
├── plan-ccmem.md                 variante repo separado
└── plan-ccmem2.md                este documento
```

### Dirección de dependencias — estrictamente en un sentido

```
src-tauri   ──→ ccmem-transcripts, ccmem-skilllink      (crates chicos y puros)
ccmem-cli   ──→ ccmem-core ──→ ccmem-transcripts, ccmem-skilllink
ccmem-cli   ──→ ccmem-mcp  ──→ ccmem-core
src-tauri   ──→ ccmem-core   SOLO en M5 (página Memory en la app)
```

`src-tauri` **no** debe depender de `ccmem-core` antes de M5. Mantener el build de la app libre del stack de memoria hasta que el esquema se estabilice significa que un cambio de esquema no puede romper el escritorio.

### `Cargo.toml` raíz

```toml
[workspace]
resolver = "2"
members  = ["src-tauri", "crates/*"]

[workspace.package]
edition = "2021"
license = "MIT"

[workspace.dependencies]
# PINNED: libsqlite3-sys declara links = "sqlite3"; dos versiones mayores en el
# mismo grafo es un error de compilación duro, no un warning.
rusqlite   = { version = "0.31", features = ["bundled"] }
serde      = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }  # setup no debe reordenar la config del usuario
serde_yaml = "0.9"
toml_edit  = "0.22"    # config.toml de codex: mergear sin destruir comentarios
dirs       = "5"
uuid       = { version = "1", features = ["v4"] }
regex      = "1"
sha2       = "0.10"
```

`src-tauri/Cargo.toml` pasa a `rusqlite.workspace = true`, etc. El `[package]` y los dos `[[bin]]` existentes no se tocan.

---

## M0 — la conversión a workspace (medio día, cero cambios de comportamiento)

Es la única fase que este plan tiene y el plan 1 no. Cuatro cosas rompen si se saltean, y las cuatro van **en el mismo commit**:

1. **`target/` se muda a la raíz.** `scripts/stage-cli.mjs` hardcodea `join(tauriDir, "target", "release", fileName)` → pasa a `join(root, "target", "release", fileName)`. Sin esto el bundle sale sin `ccode` (y el script está escrito para *no* fallar el build, así que el error sería silencioso — exactamente el modo de fallo más caro).
2. **`.gitignore`**: agregar `/target` en la raíz; el `/target` de `src-tauri/.gitignore` queda muerto.
3. **`Cargo.lock`**: borrar `src-tauri/Cargo.lock`, commitear el nuevo de la raíz.
4. **`tauri build` sigue corriendo desde `src-tauri/`.** `tauri-build` maneja workspaces bien, pero hay que verificar una vez que `gen/schemas` se regenere igual.

**Criterio de aceptación de M0**: `cargo build --workspace && cargo test --workspace` verde, `bun run tauri build --debug` produce el bundle con `binaries/ccode` adentro, y `git diff` sobre `src-tauri/src/` está vacío.

---

## Qué se mueve a los crates compartidos

### `crates/ccmem-transcripts`

Sale de `src-tauri/src/session/title.rs`: `claude_project_dir`, `claude_session_file`, `gemini_root`/`gemini_session_file`, `codex_root`/`codex_session_file`, `opencode_*`, `custom_session_file*`, `collect_files`, `newest_matching`, `find_string_field`, `extract_text_block` y las cuatro funciones `*_title`.

Sale de `src-tauri/src/session/export.rs`: `role_of`, `dig`, `text_of_content`, `content_of`, `extract_transcript` y `format_ts` (el civil-from-days de Howard Hinnant — se conserva, mantiene el cero-dependencias de fechas del repo y evita una segunda implementación).

Los tests unitarios existentes se mudan con el código.

```rust
pub struct AgentProfile {
    pub id: String,                          // "claude-code", "codex", "mitui"
    pub sessions_root: Option<PathBuf>,      // ~ ya expandido
    pub session_id_from: SessionIdSource,    // Filename | Field(String)
    pub extensions: &'static [&'static str],
    pub skills_subdir: Option<String>,       // ".claude/skills" | ".agents/skills"
}
impl AgentProfile { pub fn builtin(id: &str) -> Option<Self>; }

pub struct Turn { pub role: Role, pub text: String, pub line_no: u64, pub ts: Option<i64> }

/// Lector streaming y reanudable. Reemplaza el read_to_string de export.rs:78,
/// que es aceptable para exportar y fatal para un rollout de Codex de 200 MB.
pub struct TranscriptReader { /* BufReader + cursor de bytes */ }
impl TranscriptReader {
    pub fn open(path: &Path) -> io::Result<Self>;
    pub fn seek_bytes(&mut self, offset: u64) -> io::Result<()>;
    /// Devuelve SOLO líneas completas; una línea parcial al final no avanza el cursor.
    pub fn next_turn(&mut self) -> io::Result<Option<Turn>>;
    pub fn bytes_consumed(&self) -> u64;
    pub fn head_fingerprint(path: &Path) -> io::Result<String>;  // sha256 de los primeros 4 KiB
}

/// Wrapper de compatibilidad: lo que src-tauri sigue llamando.
pub fn extract_transcript(path: &Path) -> Vec<Turn>;
pub fn title_for(profile: &AgentProfile, path: &Path, fallback: &str) -> TitleResult;
pub fn discover_sessions(profile: &AgentProfile) -> Vec<PathBuf>;
pub fn format_ts(unix_seconds: i64) -> String;
```

**Lo que se queda en `src-tauri`**: todo lo que toca `tauri::State`, `DbConnection` o `crate::agents::CustomAgent` — o sea `session_file_for`, `discover_session_id`, `get_session_title`, `session_markdown`. Pasan a ser adaptadores finos que arman un `AgentProfile` (desde `AGENTS` o desde la tabla `custom_agents`) y delegan. La búsqueda en la DB para agentes custom se queda en la app; el crate nunca toca SQLite. **Esa es la costura que hace al crate reusable.**

> **Bug conocido que no se propaga**: el comentario arriba de `opencode_data_dir()` admite que la ruta de OpenCode fue asumida y que OpenCode en realidad persiste en SQLite. En el crate nuevo eso se convierte en un *probe* real, y `ccmem doctor` reporta qué agentes resolvieron. Mientras tanto OpenCode queda cubierto por MCP, que no depende de parsear archivos.

### `crates/ccmem-skilllink` (~150 LOC, sin DB)

```rust
pub fn links_dir_for(cwd: &Path, agent_id: &str) -> Option<PathBuf>;   // de skills/mod.rs:683
pub fn slug_from_source_path(source_path: &str) -> String;
pub fn ensure_symlink(target: &Path, link: &Path) -> Result<(), Error>;
pub fn remove_managed_symlink(path: &Path, global_root: &Path) -> Result<bool, Error>;
pub fn scan_managed_links(links_dir: &Path, global_root: &Path) -> Vec<ManagedLink>;
```

La invariante queda **codificada en la firma**: `remove_managed_symlink` recibe `global_root` y se niega a borrar cualquier cosa que no apunte adentro. Es la propiedad de seguridad que hoy vive en un comentario de `skills/mod.rs`, promovida a obligación de tipos. `links_dir_for_conn` (que necesita la DB para agentes custom) se queda en la app y envuelve a esta.

---

## Lo que cambia respecto del plan 1

| | Plan 1 (repo separado) | **Plan 2 (mismo repo)** |
|---|---|---|
| Duplicación de código de transcripts | Sí, entre M1 y M5 | **Ninguna, nunca** |
| Fase de migración de ControlCode al crate | M5, obligatoria y postergable (deuda que se pudre) | **No existe** — M0 ya deja a la app usando el crate |
| Fase extra al inicio | — | M0, conversión a workspace (medio día) |
| Esfuerzo total a v1.0 | ~7 fases | **~6 fases**, aprox. una semana menos |
| CI | Dos pipelines | Uno solo, con jobs separados por crate |
| Riesgo nuevo | Bifurcación silenciosa de la lógica de transcripts | Un cambio en `ccmem-transcripts` puede romper la app |
| Mitigación del riesgo | — | `src-tauri` no depende de `ccmem-core`; los crates compartidos son chicos, puros y con tests golden |
| Marca / `git log` | Limpios y propios | Mezclados (mitigable con tags `ccmem-v*` y un `crates/ccmem-cli/README.md` propio) |

**Si más adelante querés separarlo igual**: `git subtree split --prefix=crates` extrae los cinco crates con su historia intacta y ControlCode pasa a consumirlos como dependencia git. Esa puerta queda abierta y cuesta una tarde; la puerta inversa (unir dos repos que ya divergieron) cuesta semanas. Es un argumento fuerte para empezar acá.

---

## Fases

| # | Entregable | Publica |
|---|---|---|
| **M0** | Workspace + extracción de `ccmem-transcripts` (con reader streaming) y `ccmem-skilllink`; `src-tauri` recableado a ambos; `stage-cli.mjs`, `.gitignore` y `Cargo.lock` arreglados. **Cero cambios de comportamiento, todos los tests existentes verdes.** | — |
| **M1** | `ccmem-core`: esquema + FTS5 + migraciones forward-only, identidad de proyecto por remote git, cursor incremental, redacción, `.memignore`, memorias heurísticas. CLI: `init`, `sync`, `chat`, `search`, `context`, `save/show/rm/pin`, `stats`, `doctor`. **Valor día uno: buscar cualquier cosa que le dijiste a cualquier CLI de IA, desde la terminal. Sin LLM, sin MCP, sin hooks.** | **v0.1** |
| **M2** | `ccmem mcp` (8 tools, JSON-RPC a mano) + `ccmem hook` (4 eventos de Claude Code) + `ccmem setup claude\|codex\|gemini\|opencode` con `--detect/--dry-run/--uninstall` + bloques gestionados + ranking + presupuesto de tokens + dedupe vía `injections`. **Acá es donde las TUIs agénticas empiezan a leer el historial solas.** | **v0.2** |
| **M3** | Destilado con la CLI que ya tenés instalada: contrato de prompt, chunk/reduce, lock de concurrencia 1, timeouts, `judge`/`compare`, cadenas de supersede, `distill --queue` | v0.3 |
| **M4** | Skills: `skill_catalog`/`skill_stats`, lector read-only de `data.db`, ranking de sugerencias, `IpcAttacher` + `skill.attach/detach/suggest` en el IPC + tabla `external_skill_links`, `DirectAttacher` | v0.4 |
| **M5** | Integración visible: bundle de `ccmem` junto a `ccode`, sección Memoria en Settings, sugeridas en el diálogo de attach, SKILL.md `ccmem-memory`, y (opcional) página Memory en la app linkeando `ccmem-core` in-process | v0.5 |
| **M6** | `cargo-dist` (linux musl x86/arm, mac x86/arm firmado y notarizado, windows), `install.sh` con SHASUMS, tap de Homebrew, `setup` para cursor/windsurf/vscode/qwen/kiro, `ccmem daemon`, `export`/`import` | v1.0 |

Todo lo demás — esquema de la DB, cursor de ingesta, redacción de secretos, contrato del destilado, escalera de retrieval, inteligencia de skills, matriz de configuración por agente, seguridad y riesgos — es literalmente el del plan 1. No se reescribe acá para que las dos variantes no se desincronicen: **`plan-ccmem.md` es la fuente de verdad de todo eso**.

---

## Verificación específica de esta variante

Además de la verificación del plan 1, tres pruebas que existen solo porque compartimos repo — las que demuestran que la independencia se mantiene:

```bash
# 1. Independencia de compilación: ccmem no arrastra Tauri
cargo tree -p ccmem-cli | grep -qi tauri && { echo "FALLA: ccmem depende de tauri"; exit 1; }
cargo tree -p ccmem-cli | grep -qi portable-pty && exit 1

# 2. Independencia de runtime: todo verde sin ControlCode en el disco
HOME=$(mktemp -d) cargo test -p ccmem-core -p ccmem-cli

# 3. Independencia de distribución: instalación limpia desde el repo
cargo install --path crates/ccmem-cli --root /tmp/ccmem-standalone
HOME=$(mktemp -d) /tmp/ccmem-standalone/bin/ccmem doctor   # debe reportar 0 sesiones sin fallar

# 4. La conversión a workspace no rompió la app (M0)
cargo build --workspace && cargo test --workspace
bun run tauri build --debug && ls src-tauri/binaries/ccode
```

Y la prueba de la pregunta original — el historial por MCP sin la app corriendo:

```bash
pkill -f ControlCode                       # la app apagada
ccmem sync --since 90d
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mem_recall_chat","arguments":{"query":"symlink reconciliation"}}}' \
  | ccmem mcp | jq -c '.result.content[0].text'
```
Criterio de aprobación: devuelve turnos reales de sesiones tuyas, de más de un agente, con la app cerrada y sin haber abierto `~/.controlcode/data.db` para nada.

---

## Recomendación

**Esta variante.** El repo separado compra una marca limpia y paga con ~750 líneas duplicadas y una migración (M5 del plan 1) que es fácil de postergar hasta que las dos copias divergen — y cuando divergen, el síntoma es que ControlCode y `ccmem` discrepan sobre dónde está un transcript, que es exactamente el bug más difícil de notar y más caro de depurar en todo el proyecto.

El monorepo elimina esa clase de bug por construcción, ahorra una fase, y no cuesta nada en independencia siempre que las tres invariantes estén testeadas en CI. Y si la marca separada termina importando, `git subtree split` sigue disponible con la historia intacta.
