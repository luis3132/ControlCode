//! Dónde deja graphify su skill, y qué relación tiene eso con las skills de la app.
//!
//! Graphify **no** gestiona las skills como Control Code, y esa es la parte que hay que
//! mirar antes de instalarlo:
//!
//! - Control Code tiene una carpeta global de skills y **enlaza** cada una dentro del
//!   proyecto: `.claude/skills/<slug>` para Claude Code y `.agents/skills/<slug>` —el
//!   estándar abierto de Agent Skills— para las otras cuatro TUIs (ver `skills::links`).
//! - Graphify **copia** su skill, y elige la carpeta por plataforma, no por estándar:
//!   `.opencode/skills`, `.codex/skills`, `.gemini/skills`, `.kimi/skills`… Cada una con
//!   su propio cuerpo de SKILL.md, su carpeta `references/` al lado y un sello
//!   `.graphify_version`.
//!
//! O sea que de las plataformas de graphify hay **dos** que caen justo donde la app ya
//! gestiona skills —`claude` y la genérica `agents`— y el resto caen en carpetas que la
//! app no toca. Ninguna de las dos cosas está mal: son dos modelos distintos, y por eso
//! acá se dice de cada destino dónde cae y si es una carpeta compartida con la app, en vez
//! de elegir por el usuario.
//!
//! Que la app no la toque está garantizado por el otro lado: la reconciliación de
//! `skills::links` solo borra symlinks que apuntan a su propia carpeta global, y la skill
//! de graphify es una carpeta de verdad.
//!
//! ## El sello de versión, que es por lo que esto cambia
//!
//! La skill viaja DENTRO del paquete de PyPI, así que actualizar el paquete no actualiza
//! la skill que ya está en disco: hay que volver a correr `graphify install`. Graphify
//! deja en `.graphify_version`, al lado del `SKILL.md`, la versión con la que la escribió,
//! y avisa cuando no coincide con la del paquete. Acá se lee ese mismo archivo para poder
//! decirlo en Configuración en vez de que aparezca a mitad de una sesión del agente.
//!
//! Todo lo de este archivo está verificado contra `graphify/install.py`
//! (`_PLATFORM_CONFIG`, `_platform_skill_destination`) de la rama v8.

use serde::Serialize;
use std::path::PathBuf;

/// El nombre de la carpeta que graphify crea en cada destino.
const SKILL_DIR: &str = "graphify";

/// El archivo donde graphify deja la versión con la que escribió la skill.
const STAMP: &str = ".graphify_version";

/// Una plataforma de graphify, mirada desde las TUIs que corre la app.
struct Target {
    /// Como la nombra graphify en `--platform`. `None` = es la de por defecto.
    platform: Option<&'static str>,
    /// La TUI de la app a la que le sirve, si es una sola.
    agent_id: Option<&'static str>,
    /// Carpeta del destino global, relativa al home.
    global: &'static [&'static str],
    /// Carpeta del destino de proyecto, relativa al cwd.
    project: &'static [&'static str],
}

/// Las plataformas que le importan a esta app: una por TUI de fábrica, más la genérica.
///
/// El orden es el de la interfaz: primero la que no lleva flag, después la que comparte
/// carpeta con la app, y al final las propias de cada TUI.
const TARGETS: &[Target] = &[
    Target {
        platform: None,
        agent_id: Some("claude-code"),
        global: &[".claude", "skills"],
        project: &[".claude", "skills"],
    },
    Target {
        // `agents` (alias `skills`): el estándar abierto de Agent Skills. Es el ÚNICO
        // destino de graphify que cae en la carpeta que la app ya usa para las otras
        // cuatro TUIs, así que es el que las deja a todas con la skill de una sola vez.
        platform: Some("agents"),
        agent_id: None,
        global: &[".agents", "skills"],
        project: &[".agents", "skills"],
    },
    Target {
        platform: Some("opencode"),
        agent_id: Some("opencode"),
        // Global y proyecto NO son la misma carpeta acá, a diferencia de claude.
        global: &[".config", "opencode", "skills"],
        project: &[".opencode", "skills"],
    },
    Target {
        platform: Some("codex"),
        agent_id: Some("codex"),
        global: &[".codex", "skills"],
        project: &[".codex", "skills"],
    },
    Target {
        platform: Some("gemini"),
        agent_id: Some("gemini-cli"),
        global: &[".gemini", "skills"],
        project: &[".gemini", "skills"],
    },
    Target {
        platform: Some("kimi"),
        agent_id: Some("kimi-code"),
        global: &[".kimi", "skills"],
        project: &[".kimi", "skills"],
    },
];

/// Dónde cae la skill de graphify con una plataforma y un alcance, y qué hay ahí ahora.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyTarget {
    /// El valor de `--platform`. `None` = la de por defecto, sin flag.
    pub platform: Option<String>,
    /// La TUI de la app a la que le sirve. `None` = a todas las que leen `.agents/skills`.
    pub agent_id: Option<String>,
    pub label: String,
    /// La carpeta donde queda la skill, ya resuelta para esta máquina.
    pub path: String,
    /// La versión que dice el sello, si la skill está instalada ahí.
    pub installed_version: Option<String>,
    /// Si es una carpeta donde Control Code también monta skills. No es un conflicto —la
    /// reconciliación solo saca sus propios symlinks— pero es lo que hay que saber para
    /// elegir: acá la skill va a convivir con las de la app, y en las otras no.
    pub shared_with_app: bool,
}

/// El alcance del instalador de graphify: el perfil del usuario o este proyecto.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// Sin flag: la skill queda en el home y la ven todos los proyectos.
    Global,
    /// `--project`: la skill queda adentro del repo, versionable con él.
    Project,
}

/// La carpeta de un destino, sin tocar disco.
///
/// `home` y `cwd` entran como parámetro para poder probar esto sin depender de la máquina.
pub fn target_dir(
    target_index: usize,
    scope: Scope,
    home: &std::path::Path,
    cwd: &std::path::Path,
) -> Option<PathBuf> {
    let target = TARGETS.get(target_index)?;
    let (base, parts) = match scope {
        Scope::Global => (home, target.global),
        Scope::Project => (cwd, target.project),
    };
    let mut path = base.to_path_buf();
    for part in parts {
        path.push(part);
    }
    path.push(SKILL_DIR);
    Some(path)
}

/// La versión sellada en una carpeta de skill. `None` = no está instalada ahí.
fn stamped_version(dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join(STAMP)).ok()?;
    let version = raw.trim().to_string();
    // Sin sello pero con SKILL.md igual cuenta como instalada: un install viejo o una
    // copia a mano. Se informa sin versión en vez de decir que no está.
    if version.is_empty() { None } else { Some(version) }
}

/// Si hay una skill de graphify en esa carpeta, con o sin sello.
fn is_installed(dir: &std::path::Path) -> bool {
    dir.join("SKILL.md").exists()
}

/// Todos los destinos con lo que hay en disco ahora mismo.
pub fn targets(scope: Scope, home: &std::path::Path, cwd: &std::path::Path) -> Vec<GraphifyTarget> {
    TARGETS
        .iter()
        .enumerate()
        .filter_map(|(i, target)| {
            let dir = target_dir(i, scope, home, cwd)?;
            let installed = is_installed(&dir);
            Some(GraphifyTarget {
                platform: target.platform.map(str::to_string),
                label: label_of(target),
                agent_id: target.agent_id.map(str::to_string),
                // Compartida con la app: son las dos carpetas que `skills::links` usa
                // (`.claude/skills` y `.agents/skills`), y solo en el alcance de proyecto
                // — la app monta sus symlinks adentro del repo, nunca en el home.
                shared_with_app: scope == Scope::Project
                    && matches!(target.project.first(), Some(&".claude") | Some(&".agents")),
                installed_version: installed.then(|| stamped_version(&dir)).flatten(),
                path: dir.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// Cómo se llama el destino en la interfaz: el nombre de la TUI, o el del estándar.
fn label_of(target: &Target) -> String {
    match target.agent_id {
        Some(id) => crate::agents::agent_label(id).unwrap_or(id).to_string(),
        // No es una TUI: es la carpeta que leen todas las que siguen el estándar.
        None => "Agent Skills (.agents/skills)".to_string(),
    }
}

/// El comando del paso 2 para un destino: el que la persona ve y puede seguir editando.
///
/// Se arma y no se parchea el que había: los flags de graphify son posicionales respecto
/// del subcomando (`graphify install --platform x --project`), y reescribir a mano una
/// línea editada terminaba dejando dos `--platform`.
pub fn install_command(platform: Option<&str>, scope: Scope) -> String {
    let mut command = String::from("graphify install");
    if let Some(platform) = platform {
        command.push_str(" --platform ");
        command.push_str(platform);
    }
    if scope == Scope::Project {
        command.push_str(" --project");
    }
    command
}

#[cfg(test)]
pub(super) fn target_count() -> usize {
    TARGETS.len()
}
