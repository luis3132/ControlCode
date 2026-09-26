//! Fuente `skillssh` — el directorio abierto de skills de <https://skills.sh>.
//!
//! Se habla con los mismos dos endpoints públicos que usa su CLI oficial (`npx skills`):
//!
//! - `GET /api/search?q=…&owner=…` — lo que hace `npx skills find`, que no es más que
//!   esa llamada y un formato para la terminal.
//! - `GET /api/download/<owner>/<repo>/<slug>` — lo que hace `npx skills add` antes de
//!   recurrir a clonar el repo: devuelve los archivos de la skill ya listos.
//!
//! Antes todo pasaba por la CLI, y eso ataba skills.sh a tener un Node reciente, `npx` y
//! un PATH donde encontrarlos — lo que falla distinto en cada máquina (el Node 18 de
//! Ubuntu, un `default` de nvm más viejo que el que pide la CLI, el `npx.cmd` de Windows
//! lanzado desde una app de ventana). Hablando HTTP desde acá, buscar e instalar anda en
//! cualquier sistema sin nada instalado.
//!
//! La CLI queda como respaldo para instalar ([`install_into`]): si el endpoint de descarga
//! no tiene una copia de la skill, `npx skills add <owner/repo@slug>` la saca del repo.
//! `add` no tiene forma de elegir el destino: escribe siempre relativo a su directorio de
//! trabajo (`./.claude/skills/<slug>/`). Se aprovecha eso corriéndolo con el cwd apuntando
//! a una carpeta temporal nuestra, y de ahí el `SKILL.md` resultante entra por el mismo
//! pipeline de instalación que usa cualquier otra fuente. Así una skill de skills.sh queda
//! indistinguible del resto: misma copia global, mismos symlinks, mismo desinstalador.
//!
//! Ese respaldo pide Node 22.20 o más nuevo; cuando no está, el error lo dice con todas
//! las letras — ver `skillssh_check`, que es también la sección de Configuración que lo
//! valida paso a paso.

use rusqlite::params;
use serde::Deserialize;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use std::process::Command;

use crate::database::DbConnection;
use crate::skills::{install_skill_internal, SkillInfo};

use crate::util::now_ts;

use super::types::MarketplaceSkillEntry;

/// Plazo del respaldo con la CLI. `add` clona el repo de origen entero para sacar una
/// sola skill, así que un repo grande con una conexión lenta necesita bastante más que un
/// fetch normal.
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

/// El servicio. Es el mismo valor por defecto que usa la CLI (`SKILLS_API_URL`).
const API_BASE: &str = "https://skills.sh";

/// Cuántos resultados se piden por búsqueda. La CLI pide 10 porque los muestra en una
/// terminal; acá van a una grilla con scroll.
const SEARCH_LIMIT: &str = "50";

/// Plazo de cada llamada HTTP. Una descarga trae la skill entera en un solo JSON.
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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

/// `npx` por su ruta completa y con el PATH donde se lo encontró (ver
/// `skillssh_check::tool`). En Windows es `npx.cmd`, que `Command` ejecuta directo.
fn npx_command() -> Command {
    super::skillssh_check::tool("npx").0
}

/// Variables comunes a toda invocación de la CLI.
///
/// `CI=1` es la parte importante: sin eso la CLI decide si puede preguntar mirando si su
/// entrada es una terminal, y al lanzarla desde una app de escritorio esa heurística puede
/// dejarla esperando una respuesta que nunca va a llegar. Con `CI` puesto se comporta
/// siempre de forma no interactiva, que es la única que sirve acá.
pub(super) fn with_env(cmd: &mut Command) {
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

/// Cuando la CLI falla, la causa más común no está en lo que imprime: con un Node viejo
/// revienta con un `SyntaxError` sobre `node:util` (probado con el Node 18 de Ubuntu 24.04),
/// que no dice nada de versiones. Si falta Node o `npx`, se dice eso; si el Node es más
/// viejo que el que pide la CLI, se agrega como pista — sin reemplazar el error, porque
/// muchas veces anda igual (un 22.17 corre la CLI sin problemas).
fn explain(failure: String) -> String {
    if let Err(cause) = super::skillssh_check::requirement_error() {
        return cause;
    }
    match super::skillssh_check::old_node_note() {
        Some(note) => format!("{failure}. {note}"),
        None => failure,
    }
}

pub const NPX_MISSING: &str = "skills.sh necesita Node.js 22.20 o más nuevo: usa su CLI \
    oficial (`npx skills`) en vez de una API, y la app no pudo ejecutar `npx`. \
    Configuración → skills.sh lo valida paso a paso y dice cómo instalarlo en este sistema.";

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

// ── API HTTP ─────────────────────────────────────────────────────

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ControlCode-App")
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Una URL de la API con cada segmento escapado: un slug no debería traer `/` ni `?`,
/// pero si lo trae no puede terminar pidiendo otra cosa.
fn api_url(segments: &[&str]) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(API_BASE).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "URL base de skills.sh inválida".to_string())?
        .extend(segments);
    Ok(url)
}

/// Un error de red dicho de forma que se entienda desde la grilla del marketplace.
fn network_error(what: &str, e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("skills.sh no respondió a tiempo al {what}. Probá de nuevo o revisá tu conexión.")
    } else {
        format!("No se pudo conectar con skills.sh al {what}: {e}")
    }
}

#[derive(Deserialize)]
struct ApiSearch {
    #[serde(default)]
    skills: Vec<ApiSkill>,
}

#[derive(Deserialize)]
struct ApiSkill {
    /// `owner/repo/slug`. Las skills que no salen de GitHub traen dos partes
    /// (`dominio/slug`): no hay repo del que `add` pueda sacarlas, y se omiten — igual
    /// que antes, cuando se parseaban los links de la salida de la CLI.
    id: String,
    #[serde(default)]
    installs: Option<u64>,
}

/// `968596` → `"968.6K"`, como lo muestra la CLI (y la web).
pub(super) fn format_installs(n: u64) -> String {
    let compact = |value: f64, suffix: &str| {
        let text = format!("{value:.1}");
        format!("{}{suffix}", text.strip_suffix(".0").unwrap_or(&text))
    };
    match n {
        0..=999 => n.to_string(),
        1_000..=999_999 => compact(n as f64 / 1_000.0, "K"),
        _ => compact(n as f64 / 1_000_000.0, "M"),
    }
}

/// Parsea la respuesta de `/api/search`, ordenada por instalaciones como la ordena la CLI.
pub(super) fn parse_search_response(body: &str) -> Result<Vec<SkillsShHit>, String> {
    let parsed: ApiSearch =
        serde_json::from_str(body).map_err(|e| format!("skills.sh devolvió una búsqueda que no se entiende: {e}"))?;
    let mut skills = parsed.skills;
    skills.sort_by(|a, b| b.installs.unwrap_or(0).cmp(&a.installs.unwrap_or(0)));
    Ok(skills
        .into_iter()
        .filter_map(|skill| {
            let parts: Vec<&str> = skill.id.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() != 3 {
                return None;
            }
            Some(SkillsShHit {
                id: parts.join("/"),
                source: format!("{}/{}", parts[0], parts[1]),
                slug: parts[2].to_string(),
                // La CLI las omite cuando son cero.
                installs: skill.installs.filter(|n| *n > 0).map(format_installs),
            })
        })
        .collect())
}

/// Busca en el directorio de skills.sh. `owner` restringe a un publicador puntual.
pub async fn search(query: &str, owner: Option<&str>) -> Result<Vec<SkillsShHit>, String> {
    let query = query.trim();
    // Menos de dos caracteres los rechaza el buscador del propio servicio; cortar acá evita
    // una llamada entera para recibir un error.
    if query.len() < 2 {
        return Ok(Vec::new());
    }

    let mut url = api_url(&["api", "search"])?;
    url.query_pairs_mut().append_pair("q", query).append_pair("limit", SEARCH_LIMIT);
    if let Some(owner) = owner.map(str::trim).filter(|o| !o.is_empty()) {
        url.query_pairs_mut().append_pair("owner", owner);
    }

    let response = api_client()?.get(url).send().await.map_err(|e| network_error("buscar", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("skills.sh contestó {status} a la búsqueda"));
    }
    let body = response.text().await.map_err(|e| network_error("buscar", e))?;
    parse_search_response(&body)
}

#[derive(Deserialize)]
struct ApiDownload {
    #[serde(default)]
    files: Vec<ApiFile>,
}

#[derive(Deserialize)]
struct ApiFile {
    path: String,
    contents: String,
}

/// Una ruta de la descarga convertida en una ruta segura dentro de la carpeta de la skill.
/// `None` para lo que se saldría de ella (`..`, rutas absolutas, `C:\`): los archivos
/// vienen de un servicio de terceros y se escriben en disco.
fn safe_relative(path: &str) -> Option<PathBuf> {
    let normalized = path.replace('\\', "/");
    let mut out = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Escribe los archivos de una descarga en `dir`. El `SKILL.md` de la raíz queda con ese
/// nombre exacto aunque venga como `skill.md`: en Linux el resto de la app lo busca así.
pub(super) fn write_download(dir: &Path, files: &[(String, String)]) -> Result<(), String> {
    for (path, contents) in files {
        let Some(mut relative) = safe_relative(path) else { continue };
        if relative.as_os_str().eq_ignore_ascii_case("skill.md") {
            relative = PathBuf::from("SKILL.md");
        }
        let target = dir.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, contents).map_err(|e| format!("{}: {e}", target.display()))?;
    }
    if dir.join("SKILL.md").is_file() {
        Ok(())
    } else {
        Err("la descarga de skills.sh no trajo un SKILL.md".into())
    }
}

/// Baja una skill del directorio (`owner/repo/slug`) a `staging/<slug>/` y devuelve esa
/// carpeta. Es el mismo endpoint que usa `npx skills add` antes de recurrir a clonar.
pub async fn download_into(staging: &Path, id: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = id.split('/').collect();
    let [owner, repo, slug] = parts.as_slice() else {
        return Err(format!("Identificador de skill inesperado: {id}"));
    };
    let url = api_url(&["api", "download", owner, repo, slug])?;
    let response = api_client()?.get(url).send().await.map_err(|e| network_error("descargar", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("skills.sh contestó {status} al pedir {id}"));
    }
    let body = response.text().await.map_err(|e| network_error("descargar", e))?;
    let parsed: ApiDownload =
        serde_json::from_str(&body).map_err(|e| format!("skills.sh devolvió una descarga que no se entiende: {e}"))?;

    let dir = staging.join(safe_relative(slug).unwrap_or_else(|| PathBuf::from("skill")));
    let files: Vec<(String, String)> = parsed.files.into_iter().map(|f| (f.path, f.contents)).collect();
    write_download(&dir, &files)?;
    Ok(dir)
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
        return Err(explain(format!(
            "`npx skills add {target}` falló: {}",
            strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim()
        )));
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
        // El directorio lista skills de MUCHOS publicadores bajo un mismo "repositorio",
        // así que sin el autor dos entradas homónimas son indistinguibles en la grilla.
        author: hit.source.split('/').next().map(str::to_string),
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
        let found = search(query, Some(owner.as_str())).await;

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
                // Con entradas frescas en el cache se puede vincular lo instalado que
                // todavía no sabe de qué entrada salió. Para skills.sh esta es la ÚNICA
                // oportunidad: "refrescar" no baja ningún catálogo (no existe tal cosa sin
                // su API privada), así que el vínculo que hace `refresh_registry` nunca
                // llegaba acá. Sin esto, una instalación vieja se quedaba huérfana para
                // siempre: el marketplace la ofrecía como no instalada y volver a
                // instalarla dejaba dos copias.
                crate::skills::link_orphan_installs(&conn, &id);
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

/// "Refrescar" un repositorio de skills.sh no puede rebajar la lista completa: el
/// directorio solo sabe buscar. Los resultados de la última búsqueda se conservan.
///
/// Antes esto exigía Node y `npx` y marcaba el repositorio como roto sin ellos. Ya no hacen
/// falta para buscar ni para instalar (ver el encabezado del módulo), así que no se exigen.
pub(super) async fn refresh_skillssh(db: &DbConnection, id: &str) -> Result<Vec<MarketplaceSkillEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let cache: Option<String> = conn
        .query_row("SELECT cache_json FROM registries WHERE id = ?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(cache.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
}

/// Instala una skill del directorio: se baja a una carpeta temporal nuestra y de ahí sigue
/// por el mismo camino que cualquier otra fuente.
///
/// Primero por la API (no necesita nada instalado). Si skills.sh no tiene una copia lista
/// —la CLI en ese caso clona el repo—, se recurre a `npx skills add`.
pub(super) async fn install_from_skillssh(
    entry: &MarketplaceSkillEntry,
    origin: crate::skills::SkillOrigin<'_>,
    db: &DbConnection,
) -> Result<SkillInfo, String> {
    let target = add_target(&entry.folder_path)
        .ok_or_else(|| format!("Identificador de skill inesperado: {}", entry.folder_path))?;

    let staging = std::env::temp_dir().join(format!("controlcode-skillssh-{}", Uuid::new_v4()));
    let staged = match download_into(&staging.join("api"), &entry.folder_path).await {
        Ok(dir) => Ok(dir),
        Err(api_error) => {
            let cli_staging = staging.join("cli");
            tauri::async_runtime::spawn_blocking(move || install_into(&cli_staging, &target))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|cli_error| {
                    format!("{api_error}. El respaldo con la CLI (`npx skills add`) también falló: {cli_error}")
                })
        }
    };

    let result = staged.and_then(|dir| {
        install_skill_internal(&dir.join("SKILL.md").to_string_lossy(), None, Some(origin), db)
    });

    let _ = std::fs::remove_dir_all(&staging);
    result
}
