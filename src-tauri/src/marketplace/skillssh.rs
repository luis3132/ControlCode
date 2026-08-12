//! Fuente `skillssh` — el directorio abierto de skills de <https://skills.sh>.
//!
//! A diferencia de `local` y `github`, acá NO se habla con ninguna API: todo pasa por la
//! CLI oficial (`npx skills …`), que es la vía pública y gratuita del proyecto. Eso deja
//! la integración atada a un contrato que ellos mantienen y documentan, en vez de a
//! endpoints internos que pueden cambiar sin aviso.
//!
//! Dos comandos alcanzan:
//!
//! - `npx skills find <query>` — con query en la línea de comandos imprime la lista y
//!   termina; sin query abre un buscador interactivo, que acá no serviría de nada.
//! - `npx skills add <owner/repo@slug>` — instala la skill.
//!
//! `add` no tiene forma de elegir el destino: escribe siempre relativo a su directorio de
//! trabajo (`./.claude/skills/<slug>/`). Se aprovecha eso corriéndolo con el cwd apuntando
//! a una carpeta temporal nuestra, y de ahí el `SKILL.md` resultante entra por el mismo
//! pipeline de instalación que usa cualquier otra fuente. Así una skill de skills.sh queda
//! indistinguible del resto: misma copia global, mismos symlinks, mismo desinstalador.
//!
//! Requiere Node instalado. Cuando no está, el error lo dice con todas las letras en vez
//! de dejar un "no se encontró el programa" del sistema operativo — ver [`ensure_npx`].

use rusqlite::params;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use std::process::Command;

use crate::database::DbConnection;
use crate::skills::{install_skill_internal, SkillInfo};

use crate::util::now_ts;

use super::types::MarketplaceSkillEntry;

/// Cuánto puede tardar `npx skills add` clonando el repo de origen antes de rendirse.
/// La CLI clona el repo entero para sacar una sola skill, así que un repo grande con una
/// conexión lenta necesita bastante más que un fetch normal.
/// Plazos de cada llamada a la CLI. `add` clona el repo de origen entero, así que es la
/// que puede tardar de verdad; `--version` tendría que ser inmediata.
const NPX_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const FIND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const ADD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Un plazo vencido merece su propio mensaje: "Node no está instalado" mandaría a revisar
/// algo que sí está.
fn timeout_or(e: std::io::Error, ausente: &str) -> String {
    if e.kind() == std::io::ErrorKind::TimedOut {
        format!("`npx skills` no respondió a tiempo ({e}). Probá de nuevo o revisá tu conexión.")
    } else {
        ausente.to_string()
    }
}

const CLONE_TIMEOUT_MS: &str = "180000";

/// El identificador de Claude Code dentro de la CLI de skills — define en qué carpeta deja
/// la skill instalada (`.claude/skills/`). No es el mismo string que el `agent_id` de
/// ControlCode; se fija acá porque lo único que importa es dónde aterriza el archivo, y de
/// esa carpeta lo levantamos nosotros.
const SKILLS_AGENT: &str = "claude-code";

/// Carpeta, relativa al cwd con el que se corrió `npx skills add`, donde deja lo instalado.
const INSTALL_SUBDIR: &str = ".claude/skills";

/// Una skill del directorio, tal como sale de `npx skills find`.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillsShHit {
    /// `owner/repo/slug` — identifica la skill de forma única en todo el directorio.
    pub id: String,
    /// `owner/repo` del repositorio de GitHub que la publica.
    pub source: String,
    pub slug: String,
    /// Instalaciones acumuladas, ya formateadas por la CLI (`"3.3K"`, `"1.2M"`). Se guarda
    /// el texto y no un número porque es lo único que la CLI expone, y es exactamente lo
    /// que se quiere mostrar.
    pub installs: Option<String>,
}

/// Traduce un id del directorio (`owner/repo/slug`) a la forma que `npx skills add`
/// espera para instalar una skill puntual (`owner/repo@slug`).
///
/// Vive acá y no en quien instala porque es parte del contrato con la CLI: el id es lo
/// único que se guarda en el cache, y esta es la única forma de volver de ahí al comando.
pub fn add_target(id: &str) -> Option<String> {
    let (source, slug) = id.rsplit_once('/')?;
    if source.is_empty() || slug.is_empty() || !source.contains('/') {
        return None;
    }
    Some(format!("{source}@{slug}"))
}

// ── Ejecución de la CLI ──────────────────────────────────────────

/// `npx` no es un ejecutable en Windows sino un `.cmd`, y `CreateProcess` (lo que usa
/// `Command` por debajo) no sabe correr scripts de shell: hay que pasar por `cmd`.
fn npx_command() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx"]);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new("npx")
    }
}

/// Variables comunes a toda invocación de la CLI.
///
/// `CI=1` es la parte importante: sin eso la CLI decide si puede preguntar mirando si su
/// entrada es una terminal, y al lanzarla desde una app de escritorio esa heurística puede
/// dejarla esperando una respuesta que nunca va a llegar. Con `CI` puesto se comporta
/// siempre de forma no interactiva, que es la única que sirve acá.
fn with_env(cmd: &mut Command) {
    cmd.env("CI", "1");
    cmd.env("SKILLS_CLONE_TIMEOUT_MS", CLONE_TIMEOUT_MS);
    // Sin esto la CLI puede pintar de colores incluso redirigida, y el parser tendría que
    // lidiar con secuencias ANSI. Igual se limpian por las dudas (ver `strip_ansi`).
    cmd.env("NO_COLOR", "1");
    cmd.env("FORCE_COLOR", "0");
    // `npx` pregunta antes de bajar un paquete que no está en cache; sin esto la primera
    // búsqueda de la máquina se colgaría esperando un "sí".
    cmd.env("npm_config_yes", "true");
}

/// Verifica que se pueda ejecutar `npx` antes de intentar nada más.
///
/// Es la diferencia entre "Node.js no está instalado" y un críptico "No such file or
/// directory (os error 2)" saliendo del sistema operativo. Se llama al refrescar el
/// repositorio, así el problema se ve en la pantalla de repositorios y no recién cuando
/// alguien busca algo.
pub fn ensure_npx() -> Result<(), String> {
    let mut cmd = npx_command();
    with_env(&mut cmd);
    match crate::util::output_with_timeout(cmd.arg("--version"), NPX_VERSION_TIMEOUT) {
        Ok(out) if out.status.success() => Ok(()),
        // `npx` existe pero devolvió error: raro, pero es un entorno de Node roto, no uno
        // ausente — conviene decir cuál de las dos cosas es.
        Ok(out) => Err(format!(
            "`npx` está instalado pero falló al ejecutarse ({}). {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(_) => Err(NPX_MISSING.to_string()),
    }
}

pub const NPX_MISSING: &str = "skills.sh necesita Node.js instalado: usa su CLI oficial \
    (`npx skills`) en vez de una API. Instalá Node.js desde https://nodejs.org y volvé a \
    refrescar este repositorio. Si ya lo tenés, puede que la app no vea tu PATH — probá \
    abrirla desde una terminal.";

/// Quita las secuencias de escape ANSI (colores, movimientos de cursor) de la salida.
///
/// La CLI dibuja spinners y colorea resultados; el parser necesita el texto pelado. Se
/// implementa a mano en vez de sumar una dependencia: el subconjunto que hace falta —
/// `ESC [ … letra` — se resuelve en unas pocas líneas.
pub(super) fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // Tras el ESC viene un byte que indica el tipo de secuencia; para `[` (la familia
        // CSI, que es la que usa la CLI) el final es la primera letra que aparezca.
        // Cualquier otra secuencia queda descartada con haber consumido ese byte.
        if chars.next() == Some('[') {
            for f in chars.by_ref() {
                if f.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

// ── Búsqueda ─────────────────────────────────────────────────────

/// Parsea la salida de `npx skills find`. Cada resultado ocupa dos líneas:
///
/// ```text
/// callstack/react-native-testing-library@react-native-testing 3.3K installs
/// └ https://skills.sh/callstack/react-native-testing-library/react-native-testing
/// ```
///
/// El ancla es la línea del link, no la del nombre: de ahí sale el `owner/repo/slug`
/// completo y sin ambigüedad (un slug puede tener guiones, y el `@` del nombre no alcanza
/// para separar si el repo tuviera uno). La línea de arriba solo aporta las instalaciones.
pub(super) fn parse_find_output(raw: &str) -> Vec<SkillsShHit> {
    const LINK: &str = "https://skills.sh/";
    let clean = strip_ansi(raw);
    let lines: Vec<&str> = clean.lines().map(str::trim).collect();

    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(pos) = line.find(LINK) else { continue };
        let id = line[pos + LINK.len()..].trim().trim_end_matches('/');

        // `owner/repo/slug`: menos partes es un link a otra cosa (el home, un pack), más
        // partes no lo produce esta salida.
        let parts: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() != 3 {
            continue;
        }

        // Las instalaciones vienen en la línea anterior, después del nombre. Que falten no
        // invalida el resultado: la CLI las omite cuando son cero.
        let installs = i
            .checked_sub(1)
            .and_then(|p| lines.get(p))
            .and_then(|prev| prev.split_once(" installs"))
            .and_then(|(head, _)| head.rsplit(char::is_whitespace).next())
            .filter(|s| !s.is_empty() && s.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .map(|s| s.to_string());

        out.push(SkillsShHit {
            id: parts.join("/"),
            source: format!("{}/{}", parts[0], parts[1]),
            slug: parts[2].to_string(),
            installs,
        });
    }
    out
}

/// Busca en el directorio de skills.sh. `owner` restringe a un publicador puntual.
///
/// Bloquea el hilo hasta que la CLI termina — quien la llame desde un contexto async tiene
/// que sacarla del hilo del runtime (ver `marketplace::search_remote_registries`).
pub fn search(query: &str, owner: Option<&str>) -> Result<Vec<SkillsShHit>, String> {
    let query = query.trim();
    // Menos de dos caracteres los rechaza el buscador del propio servicio; cortar acá evita
    // un `npx` entero para recibir un error.
    if query.len() < 2 {
        return Ok(Vec::new());
    }

    let mut cmd = npx_command();
    with_env(&mut cmd);
    cmd.args(["-y", "skills", "find", query]);
    if let Some(owner) = owner.map(str::trim).filter(|o| !o.is_empty()) {
        cmd.args(["--owner", owner]);
    }

    let out = crate::util::output_with_timeout(&mut cmd, FIND_TIMEOUT)
        .map_err(|e| timeout_or(e, NPX_MISSING))?;
    if !out.status.success() {
        return Err(format!(
            "`npx skills find` falló: {}",
            strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim()
        ));
    }
    Ok(parse_find_output(&String::from_utf8_lossy(&out.stdout)))
}

// ── Instalación ──────────────────────────────────────────────────

/// Corre `npx skills add` con el cwd apuntando a `staging` y devuelve la carpeta donde
/// quedó la skill — la que contiene su `SKILL.md`.
///
/// `--copy` es deliberado: por defecto la CLI puede dejar symlinks a su propia cache, y
/// acá la carpeta temporal se borra apenas termina la instalación. Se necesitan archivos
/// de verdad para poder copiarlos a la biblioteca global.
pub fn install_into(staging: &Path, target: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;

    let mut cmd = npx_command();
    with_env(&mut cmd);
    cmd.current_dir(staging);
    cmd.args(["-y", "skills", "add", target, "--agent", SKILLS_AGENT, "--yes", "--copy"]);

    let out = crate::util::output_with_timeout(&mut cmd, ADD_TIMEOUT)
        .map_err(|e| timeout_or(e, NPX_MISSING))?;
    if !out.status.success() {
        return Err(format!(
            "`npx skills add {target}` falló: {}",
            strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim()
        ));
    }

    let installed = staging.join(INSTALL_SUBDIR);
    let slug = target.rsplit('@').next().unwrap_or(target);
    find_installed_skill(&installed, slug).ok_or_else(|| {
        // La CLI puede terminar con éxito sin instalar nada (un slug que ya no existe en el
        // repo, por ejemplo); su propio mensaje es la mejor pista que tenemos.
        let detail = strip_ansi(&String::from_utf8_lossy(&out.stdout));
        let tail: Vec<&str> = detail.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        format!(
            "`npx skills add {target}` no dejó ningún SKILL.md. Última salida: {}",
            tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" · ")
        )
    })
}

/// Busca la carpeta instalada dentro de `.claude/skills/`.
///
/// Se prefiere la que coincide con el slug pedido; si la CLI la nombró distinto y hay
/// **una sola**, se toma esa. Con varias no se adivina: `read_dir` no tiene orden
/// garantizado, así que quedarse con la primera instalaba una skill al azar bajo el
/// nombre de otra.
pub(super) fn find_installed_skill(dir: &Path, slug: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("SKILL.md").is_file())
        .collect();

    candidates
        .iter()
        .find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(slug)))
        .or_else(|| candidates.first().filter(|_| candidates.len() == 1))
        .cloned()
}

/// Valida el filtro por publicador de un registry `skillssh`. Vacío es válido y es el caso
/// normal: significa buscar en todo el directorio.
///
/// Acepta que le peguen el link del perfil (`https://skills.sh/vercel-labs`) además del
/// nombre pelado, por la misma razón que `normalize_github_location`: es lo que uno tiene
/// en el portapapeles al venir de la web.
pub(super) fn normalize_owner_filter(input: &str) -> Result<String, String> {
    let raw = input.trim().trim_end_matches('/');
    let raw = raw.split(['?', '#']).next().unwrap_or(raw);
    let owner = raw
        .rsplit('/')
        .find(|s| !s.is_empty())
        .filter(|s| !s.contains(".sh") && !s.contains("://"))
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if owner.is_empty() {
        return Ok(String::new());
    }
    // Mismas reglas que un usuario/organización de GitHub, que es de donde salen los
    // publicadores del directorio.
    let valido = owner.len() <= 39
        && owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !owner.starts_with('-')
        && !owner.ends_with('-');
    if !valido {
        return Err(format!(
            "'{owner}' no parece un publicador de skills.sh. Dejalo vacío para buscar en \
             todo el directorio, o poné un usuario/organización de GitHub (ej. vercel-labs)."
        ));
    }
    Ok(owner)
}

/// Convierte un resultado del directorio en una entrada de marketplace.
///
/// `folder_path` guarda el `owner/repo/slug` completo: es lo único que hace falta para
/// volver a instalarla más tarde desde el cache, sin repetir la búsqueda.
pub(super) fn skillssh_entry(
    hit: SkillsShHit,
    registry_id: &str,
    registry_name: &str,
) -> MarketplaceSkillEntry {
    MarketplaceSkillEntry {
        id: hit.id.clone(),
        registry_id: registry_id.to_string(),
        registry_name: registry_name.to_string(),
        name: hit.slug.clone(),
        // El directorio no expone la descripción en la búsqueda — la única forma de
        // tenerla sería bajar cada skill entera, que son decenas de megas por búsqueda.
        // Se muestra el repo de origen, que es el dato que sí ayuda a elegir.
        description: Some(hit.source.clone()),
        categories: Vec::new(),
        compatible_agents: Vec::new(),
        folder_path: hit.id,
        files: Vec::new(),
        installs: hit.installs,
    }
}

/// Busca en los repositorios `skillssh` habilitados y deja los resultados en su cache.
///
/// El marketplace no puede listar skills.sh como lista a los otros repos: el directorio
/// tiene miles de skills y su CLI solo sabe buscar (no enumerar), así que la búsqueda es la
/// forma de navegarlo. Se llama desde el buscador del marketplace antes de releer la lista.
///
/// Guardar en `cache_json` no es solo para mostrar: instalar necesita reencontrar la skill
/// por id, y así lo último buscado sigue ahí al volver a la pantalla.
#[tauri::command]
pub async fn search_remote_registries(
    query: String,
    db: tauri::State<'_, DbConnection>,
) -> Result<(), String> {
    search_remote_conn(&db, &query).await
}

/// El trabajo real de [`search_remote_registries`], sin la capa de Tauri, para poder
/// ejercitarlo contra una base de prueba.
pub async fn search_remote_conn(db: &DbConnection, query: &str) -> Result<(), String> {
    let targets: Vec<(String, String, String)> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, location FROM registries
                 WHERE source_type = 'skillssh' AND enabled = 1 ORDER BY priority ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    if targets.is_empty() {
        return Ok(());
    }

    for (id, name, owner) in targets {
        // La CLI es un proceso que bloquea; correrla en el hilo del runtime congelaría toda
        // la app mientras busca.
        let (q, owner_owned) = (query.to_string(), owner.clone());
        let found = tauri::async_runtime::spawn_blocking(move || {
            search(&q, Some(owner_owned.as_str()))
        })
        .await
        .map_err(|e| e.to_string())?;

        let now = now_ts();
        let conn = db.lock().map_err(|e| e.to_string())?;
        match found {
            Ok(hits) => {
                let entries: Vec<MarketplaceSkillEntry> = hits
                    .into_iter()
                    .map(|h| skillssh_entry(h, &id, &name))
                    .collect();
                let json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".to_string());
                conn.execute(
                    "UPDATE registries SET cache_json = ?1, cache_error = NULL, last_fetched = ?2
                     WHERE id = ?3",
                    params![json, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
            // Un fallo de búsqueda no puede tumbar el resto del marketplace: queda anotado
            // en el repositorio (la UI lo muestra ahí) y los demás siguen andando.
            Err(e) => {
                conn.execute(
                    "UPDATE registries SET cache_error = ?1, last_fetched = ?2 WHERE id = ?3",
                    params![e, now, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// "Refrescar" un repositorio de skills.sh no puede rebajar la lista completa —  no existe
/// tal cosa sin su API privada. Lo que sí puede es comprobar que la herramienta con la que
/// se lo consulta esté disponible, que es el único motivo real por el que esta fuente deja
/// de funcionar en una máquina. Los resultados de la última búsqueda se conservan.
/// `ensure_npx` arranca un proceso y espera: eso NO puede pasar en el hilo del runtime.
/// Refrescar repositorios recorre todos en serie, así que dejar esta comprobación bloqueando
/// congelaba un worker durante todo el arranque de Node — y la instalación de skills, que es
/// async, quedaba encolada detrás sin motivo aparente. La búsqueda y la instalación ya salían
/// del runtime con `spawn_blocking`; esto se me había escapado.
pub(super) async fn refresh_skillssh(db: &DbConnection, id: &str) -> Result<Vec<MarketplaceSkillEntry>, String> {
    tauri::async_runtime::spawn_blocking(ensure_npx)
        .await
        .map_err(|e| e.to_string())??;

    let conn = db.lock().map_err(|e| e.to_string())?;
    let cache: Option<String> = conn
        .query_row("SELECT cache_json FROM registries WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(cache.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
}

/// Instala una skill del directorio: la CLI la deja en una carpeta temporal nuestra y de
/// ahí sigue por el mismo camino que cualquier otra fuente.
pub(super) async fn install_from_skillssh(
    entry: &MarketplaceSkillEntry,
    origin: crate::skills::SkillOrigin<'_>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let target = add_target(&entry.folder_path)
        .ok_or_else(|| format!("Identificador de skill inesperado: {}", entry.folder_path))?;

    let staging = std::env::temp_dir().join(format!("controlcode-skillssh-{}", Uuid::new_v4()));
    let staged = {
        let staging = staging.clone();
        tauri::async_runtime::spawn_blocking(move || install_into(&staging, &target))
            .await
            .map_err(|e| e.to_string())?
    };

    let result = staged.and_then(|dir| {
        install_skill_internal(&dir.join("SKILL.md").to_string_lossy(), None, origin, db)
    });

    let _ = std::fs::remove_dir_all(&staging);
    result
}
