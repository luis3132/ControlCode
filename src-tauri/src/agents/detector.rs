use serde::{Deserialize, Serialize};
use std::time::Duration;

use super::registry::{self, AgentDef, SHELL_AGENT_ID};

/// Cuánto se espera a un `--version`. Una TUI que tarda más está haciendo otra cosa —una
/// migración, un chequeo de actualización, esperando algo— y la lista no puede quedar
/// colgada de ella.
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);

/// Una TUI tal como la ve el frontend: lo que dice el registro más lo que solo se puede
/// saber sondeando esta máquina.
///
/// `resume` y `skills_dir` viajan aunque el backend no los necesite para responder: son
/// justamente los dos datos que el frontend tenía copiados en tablas propias
/// (`agentResume.ts`), y mandarlos acá es lo que le permite dejar de tenerlas.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub version: Option<String>,
    /// Dónde se encontró. `None` = no está en el PATH (ver `util::path_env::report` para
    /// saber dónde se buscó).
    pub path: Option<String>,
    /// Argumentos de reanudación con el placeholder `{session}`. `None` = no sabe.
    pub resume: Option<String>,
    /// Carpeta de skills relativa al cwd. `None` = no gestiona skills.
    pub skills_dir: Option<String>,
}

/// ¿Está este comando en el PATH?
///
/// Se mira el disco en vez de preguntarle a `which`/`where`: `which` no viene en todas las
/// distribuciones (Arch base no lo trae, y ahí no se detectaba NINGUNA TUI), y el PATH en
/// el que busca es el que armó `util::path_env` al arrancar — el mismo con el que después
/// se lanza, así que lo que se detecta es lo que se puede abrir.
pub fn command_exists(command: &str) -> bool {
    crate::util::find_program(command).is_some()
}

/// La primera línea con texto de lo que imprimió `--version`.
///
/// De stdout primero y de stderr si stdout vino vacío: hay TUIs que escriben la versión
/// en stderr, y antes eso las dejaba sin versión aunque la dijeran.
pub fn version_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr].into_iter().find_map(|raw| {
        String::from_utf8_lossy(raw)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
    })
}

fn probe_agent(def: &AgentDef) -> AgentInfo {
    // `bash` es la salida de emergencia a una terminal pelada, no una TUI que se instale:
    // se reporta disponible sin sondear. En Windows el binario ni siquiera está en el
    // PATH con ese nombre, así que sondearlo lo daría por ausente.
    let is_shell = def.id == SHELL_AGENT_ID;
    let path = if is_shell { None } else { crate::util::find_program(def.command) };

    // Con la ruta que se encontró y no con el nombre: en Windows un `opencode.cmd` de npm
    // no se ejecuta por su nombre a secas. Con tope y sin stdin: una TUI que se pone a
    // esperar algo no puede dejar colgada la lista entera.
    let version = path.as_ref().and_then(|p| {
        let mut cmd = std::process::Command::new(p);
        cmd.arg(def.version_flag);
        crate::util::output_with_timeout(&mut cmd, VERSION_TIMEOUT)
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| version_line(&o.stdout, &o.stderr))
    });

    AgentInfo {
        id: def.id.to_string(),
        label: def.label.to_string(),
        command: def.command.to_string(),
        available: is_shell || path.is_some(),
        version,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        resume: def.resume.map(str::to_string),
        skills_dir: def.skills_dir.map(str::to_string),
    }
}

/// Detecta qué agentes de IA están instalados en el PATH del sistema.
/// Siempre incluye bash como último elemento con available: true.
///
/// `probe_agent` mira el disco y lanza un `--version` bloqueante por candidato — sin
/// `spawn_blocking`, ese trabajo síncrono corre directo sobre un
/// worker thread del executor async de Tauri (esta función es `async fn` pero no tiene
/// ningún `.await` real), bloqueándolo mientras dura. Se llama una vez por cada ventana
/// nueva que monta `AppShell`, así que con varias ventanas abriéndose a la vez podía
/// demorar otros comandos async programados en ese mismo worker.
///
/// Los sondeos van en paralelo: son independientes, y en serie la lista tardaba la SUMA de
/// todos los `--version` — con uno lento, varios segundos de "no hay agentes".
#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> {
    tokio::task::spawn_blocking(|| {
        std::thread::scope(|scope| {
            let probes: Vec<_> = registry::AGENTS
                .iter()
                .map(|def| scope.spawn(move || probe_agent(def)))
                .collect();
            probes.into_iter().filter_map(|p| p.join().ok()).collect()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Dónde busca la app los programas: qué aportó el shell del usuario, qué carpetas
/// conocidas se sumaron y el PATH final. Es lo que se muestra cuando una TUI no aparece.
#[tauri::command]
pub fn agent_search_path() -> crate::util::path_env::PathReport {
    crate::util::path_env::report()
}
