//! Si esta máquina puede usar skills.sh, paso por paso: la sección de Configuración que lo
//! valida, y el mismo criterio para los errores del marketplace.
//!
//! skills.sh se consulta con su CLI (`npx skills`, ver `skillssh.rs`), y eso depende de
//! tres cosas que cambian de máquina en máquina:
//!
//! - **Node, y nuevo.** La CLI pide Node 22.20 o más. Los repositorios de Ubuntu 24.04 y
//!   Debian 12 traen Node 18: `npx` existe, `npx --version` contesta, y la CLI falla después
//!   con un error que no dice por qué. Por eso se mira la versión, no solo que exista.
//! - **`npx`.** En Debian y Ubuntu viene aparte de `node`, en el paquete `npm`.
//! - **Encontrarlos.** Una app abierta desde el menú del escritorio no tiene el PATH de la
//!   terminal, y un Node recién instalado con nvm no está en el PATH con que arrancó la app.
//!   El primer paso vuelve a leer el PATH del shell ([`fresh_path`]), y la CLI se lanza
//!   con ese desde ahí en adelante: instalar Node y volver a validar alcanza, sin reiniciar.
//!
//! Los pasos van de a uno para que la pantalla muestre el avance: el de la CLI puede bajar
//! el paquete la primera vez, y una búsqueda sale a internet.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::util::path_env::{fresh_path, find_program_in};

use super::skillssh::{parse_find_output, strip_ansi, with_env};

/// Lo que pide la CLI: `engines.node` de su `package.json` (`npm view skills engines` dio
/// `>=22.20.0` con skills 1.7.0, en 2026-09). Es un aviso y no una puerta: si un día sube,
/// el paso de la CLI lo va a mostrar igual, fallando.
pub const MIN_NODE: (u64, u64, u64) = (22, 20, 0);

/// Cómo se consigue un Node nuevo en cada sistema. En Linux, nvm y no el gestor de
/// paquetes: los repositorios de varias distros traen uno demasiado viejo, y nvm es lo que
/// recomienda nodejs.org en cualquier distro. `""` = cualquier sistema.
const NODE_INSTALLS: &[(&str, &str)] = &[
    ("macos", "brew install node"),
    ("windows", "winget install OpenJS.NodeJS.LTS"),
    (
        "linux",
        r#"curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts"#,
    ),
];

const NODE_DOCS: &str = "https://nodejs.org/en/download";

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// La primera vez baja el paquete de la CLI.
const CLI_TIMEOUT: Duration = Duration::from_secs(120);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(90);

/// El PATH con que se lanza la CLI. `None` = el del proceso. Lo reemplaza el paso de Node
/// del diagnóstico, y queda para todas las búsquedas e instalaciones que sigan.
static CLI_PATH: RwLock<Option<OsString>> = RwLock::new(None);

pub(super) fn cli_path() -> OsString {
    CLI_PATH
        .read()
        .ok()
        .and_then(|p| p.clone())
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default()
}

/// Un programa lanzado por su ruta completa en ese PATH, y con ese PATH en su entorno: la
/// primera línea de `npx` es `#!/usr/bin/env node`, y ese `node` sale del PATH del hijo.
///
/// En Windows es lo que permite lanzar `npx.cmd` sin pasar por `cmd /C`: `Command` sabe
/// ejecutar un `.cmd` por su ruta y escapa los argumentos como corresponde, cosa que a mano
/// (con una búsqueda que tenga `&` o comillas) no se hacía.
pub(super) fn tool(name: &str) -> (Command, Option<PathBuf>) {
    let path = cli_path();
    let found = find_program_in(name, &path);
    let mut cmd = Command::new(found.clone().map(OsString::from).unwrap_or_else(|| name.into()));
    cmd.env("PATH", &path);
    (cmd, found)
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckStep {
    Node,
    Npx,
    Cli,
    Search,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Ok,
    /// Anda, pero algo no está como debería (un Node más viejo que el que pide la CLI).
    Warn,
    Fail,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub step: CheckStep,
    pub state: CheckState,
    /// Dónde se encontró el programa.
    pub path: Option<String>,
    pub version: Option<String>,
    /// Lo que dijo el programa cuando algo salió mal, recortado.
    pub output: Option<String>,
    /// Búsqueda: cuántas skills trajo.
    pub results: Option<usize>,
}

impl StepResult {
    fn new(step: CheckStep, state: CheckState) -> Self {
        Self { step, state, path: None, version: None, output: None, results: None }
    }
}

/// Lo que se le muestra a quien tiene que arreglar Node.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeInstall {
    pub min_node: String,
    /// El comando de este sistema.
    pub install: Option<String>,
    /// Los de los otros, por si la máquina de al lado es otra.
    pub other_installs: Vec<String>,
    pub docs_url: String,
}

pub fn node_install(os: &str) -> NodeInstall {
    let chosen = NODE_INSTALLS
        .iter()
        .find(|(system, _)| *system == os)
        .or_else(|| NODE_INSTALLS.iter().find(|(system, _)| system.is_empty()))
        .map(|(_, command)| command.to_string());
    NodeInstall {
        min_node: format!("{}.{}.{}", MIN_NODE.0, MIN_NODE.1, MIN_NODE.2),
        other_installs: NODE_INSTALLS
            .iter()
            .map(|(_, command)| command.to_string())
            .filter(|command| Some(command) != chosen.as_ref())
            .collect(),
        install: chosen,
        docs_url: NODE_DOCS.to_string(),
    }
}

/// `v18.19.1` → `(18, 19, 1)`. Tolera lo que agregan algunas distros (`v18.19.1-nodesource`).
pub fn parse_node_version(text: &str) -> Option<(u64, u64, u64)> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut parts = line.trim_start_matches('v').split(['.', '-', ' ']).map(|p| p.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0)))
}

pub fn node_is_enough(version: (u64, u64, u64)) -> bool {
    version >= MIN_NODE
}

/// Lo que se muestra de una salida que falló: el final, que es donde está el error.
fn tail(stdout: &[u8], stderr: &[u8]) -> String {
    let text = strip_ansi(&format!("{}\n{}", String::from_utf8_lossy(stderr), String::from_utf8_lossy(stdout)));
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(25);
    lines[start..].join("\n")
}

fn first_line(bytes: &[u8]) -> Option<String> {
    strip_ansi(&String::from_utf8_lossy(bytes))
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Node: dónde está y si alcanza la versión.
pub fn node_status() -> StepResult {
    let (mut cmd, found) = tool("node");
    let Some(path) = found else { return StepResult::new(CheckStep::Node, CheckState::Fail) };
    let mut result = StepResult::new(CheckStep::Node, CheckState::Fail);
    result.path = Some(path.to_string_lossy().into_owned());
    match crate::util::output_with_timeout(cmd.arg("--version"), PROBE_TIMEOUT) {
        Ok(out) if out.status.success() => {
            result.version = first_line(&out.stdout);
            result.state = match result.version.as_deref().and_then(parse_node_version) {
                Some(v) if node_is_enough(v) => CheckState::Ok,
                _ => CheckState::Warn,
            };
        }
        Ok(out) => result.output = Some(tail(&out.stdout, &out.stderr)),
        Err(e) => result.output = Some(e.to_string()),
    }
    result
}

pub fn npx_status() -> StepResult {
    let (mut cmd, found) = tool("npx");
    let Some(path) = found else { return StepResult::new(CheckStep::Npx, CheckState::Fail) };
    let mut result = StepResult::new(CheckStep::Npx, CheckState::Fail);
    result.path = Some(path.to_string_lossy().into_owned());
    with_env(&mut cmd);
    match crate::util::output_with_timeout(cmd.arg("--version"), PROBE_TIMEOUT) {
        Ok(out) if out.status.success() => {
            result.state = CheckState::Ok;
            result.version = first_line(&out.stdout);
        }
        Ok(out) => result.output = Some(tail(&out.stdout, &out.stderr)),
        Err(e) => result.output = Some(e.to_string()),
    }
    result
}

/// Corre la CLI de verdad. Con esto, lo que diga `npx` (sin red, un Node que no le sirve,
/// un registro de npm inaccesible) queda a la vista tal cual.
fn cli_status(step: CheckStep) -> StepResult {
    let (mut cmd, _) = tool("npx");
    with_env(&mut cmd);
    let timeout = if step == CheckStep::Search {
        cmd.args(["-y", "skills", "find", "react"]);
        SEARCH_TIMEOUT
    } else {
        cmd.args(["-y", "skills", "--version"]);
        CLI_TIMEOUT
    };
    let mut result = StepResult::new(step, CheckState::Fail);
    match crate::util::output_with_timeout(&mut cmd, timeout) {
        Ok(out) if out.status.success() && step == CheckStep::Search => {
            let found = parse_find_output(&String::from_utf8_lossy(&out.stdout)).len();
            result.results = Some(found);
            // Contestó pero sin nada: la CLI anda y el directorio no trajo resultados, que
            // para "react" solo pasa si algo en el camino filtró la respuesta.
            result.state = if found > 0 { CheckState::Ok } else { CheckState::Warn };
            if found == 0 {
                result.output = Some(tail(&out.stdout, &out.stderr));
            }
        }
        Ok(out) if out.status.success() => {
            result.state = CheckState::Ok;
            result.version = first_line(&out.stdout);
        }
        Ok(out) => result.output = Some(tail(&out.stdout, &out.stderr)),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            result.output = Some(format!("no terminó en {} s", timeout.as_secs()));
        }
        Err(e) => result.output = Some(e.to_string()),
    }
    result
}

/// Un paso del diagnóstico. El de Node es el primero y vuelve a leer el PATH del shell.
pub fn run_step(step: CheckStep) -> StepResult {
    match step {
        CheckStep::Node => {
            let fresh = fresh_path();
            if let Ok(mut current) = CLI_PATH.write() {
                *current = Some(fresh);
            }
            node_status()
        }
        CheckStep::Npx => npx_status(),
        CheckStep::Cli | CheckStep::Search => cli_status(step),
    }
}

/// Lo que dice el marketplace cuando skills.sh no puede andar en esta máquina, o `Ok` si
/// puede. Mismos criterios que la sección de Configuración, y la manda ahí.
pub fn requirement_error() -> Result<(), String> {
    let min = node_install(std::env::consts::OS).min_node;
    let node = node_status();
    let where_to = "Configuración → skills.sh lo valida paso a paso y dice cómo instalarlo en este sistema.";
    match (node.state, node.path.as_deref()) {
        (CheckState::Fail, None) => {
            return Err(format!("skills.sh necesita Node.js {min} o más nuevo, y la app no encontró `node`. {where_to}"));
        }
        (CheckState::Fail, Some(path)) => {
            return Err(format!(
                "`node` está en {path} pero falló al ejecutarse: {}. {where_to}",
                node.output.unwrap_or_default()
            ));
        }
        (CheckState::Warn, path) => {
            return Err(format!(
                "skills.sh necesita Node.js {min} o más nuevo, y la app encontró {} en {}. {where_to}",
                node.version.as_deref().unwrap_or("una versión que no se pudo leer"),
                path.unwrap_or("?")
            ));
        }
        (CheckState::Ok, _) => {}
    }
    let npx = npx_status();
    match (npx.state, npx.path) {
        (CheckState::Ok | CheckState::Warn, _) => Ok(()),
        (CheckState::Fail, None) => Err(format!(
            "Está Node.js ({}) pero no `npx`: en Debian y Ubuntu viene aparte, en el paquete `npm`. {where_to}",
            node.version.unwrap_or_default()
        )),
        (CheckState::Fail, Some(path)) => Err(format!(
            "`npx` está en {path} pero falló al ejecutarse: {}. {where_to}",
            npx.output.unwrap_or_default()
        )),
    }
}

/// Un paso del diagnóstico de skills.sh (Configuración → skills.sh).
#[tauri::command]
pub async fn skillssh_check_step(step: CheckStep) -> Result<StepResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_step(step)).await.map_err(|e| e.to_string())
}

/// Cómo instalar un Node que le sirva a la CLI, en este sistema y en los otros.
#[tauri::command]
pub fn skillssh_node_install() -> NodeInstall {
    node_install(std::env::consts::OS)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn la_version_de_node_se_lee_aunque_la_distro_le_agregue_cosas() {
        assert_eq!(parse_node_version("v18.19.1\n"), Some((18, 19, 1)));
        assert_eq!(parse_node_version("v24.14.0-nodesource1"), Some((24, 14, 0)));
        assert_eq!(parse_node_version("\nv22.20.0"), Some((22, 20, 0)));
        assert_eq!(parse_node_version("node"), None);
    }

    /// Lo que pide la CLI: 22.20 exacto alcanza, 22.19 no, y el 18 de Ubuntu tampoco.
    #[test]
    fn alcanza_desde_la_version_que_pide_la_cli() {
        assert!(node_is_enough((22, 20, 0)));
        assert!(node_is_enough((24, 0, 0)));
        assert!(!node_is_enough((22, 19, 9)));
        assert!(!node_is_enough((18, 19, 1)));
    }

    #[test]
    fn cada_sistema_ve_su_forma_de_instalar_node() {
        assert!(node_install("linux").install.unwrap().contains("nvm install"));
        assert_eq!(node_install("windows").install.as_deref(), Some("winget install OpenJS.NodeJS.LTS"));
        let mac = node_install("macos");
        assert_eq!(mac.install.as_deref(), Some("brew install node"));
        assert!(!mac.other_installs.contains(mac.install.as_ref().unwrap()), "el elegido no se repite");
        assert_eq!(mac.min_node, "22.20.0");
    }

    /// Con un `node` y un `npx` de mentira en el PATH de la CLI: lo que se contesta con un
    /// Node viejo, con uno nuevo y sin `npx`. Todo en un test porque el PATH de la CLI es
    /// uno solo para el proceso.
    #[cfg(unix)]
    #[test]
    fn el_diagnostico_dice_que_falta_y_donde() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cc-skillssh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let set_path = |p: Option<OsString>| *CLI_PATH.write().unwrap() = p;
        set_path(Some(dir.clone().into_os_string()));

        script("node", "echo v18.19.1");
        let node = node_status();
        assert_eq!(node.state, CheckState::Warn);
        assert_eq!(node.version.as_deref(), Some("v18.19.1"));
        let err = requirement_error().unwrap_err();
        assert!(err.contains("22.20.0") && err.contains("v18.19.1") && err.contains(dir.to_str().unwrap()), "{err}");

        script("node", "echo v24.14.0");
        let err = requirement_error().unwrap_err();
        assert!(err.contains("npx") && err.contains("npm"), "sin npx dice en qué paquete viene: {err}");

        script("npx", "echo 11.9.0");
        assert_eq!(npx_status().version.as_deref(), Some("11.9.0"));
        assert_eq!(requirement_error(), Ok(()));

        set_path(None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
