//! Graphify: instalarlo desde Configuración, con los comandos a la vista.
//!
//! [graphify](https://github.com/Graphify-Labs/graphify) convierte un proyecto —código,
//! docs, PDFs, imágenes— en un grafo de conocimiento que el agente **consulta** en vez de
//! leer archivo por archivo. Es una skill: se instala una vez y aparece como `/graphify`
//! adentro de la TUI, así que lo que la app tiene que resolver no es usarlo, es instalarlo.
//!
//! Son dos pasos, y los dos son comandos de shell (README de graphify, sección *Install*):
//!
//! 1. el paquete de PyPI, que se llama `graphifyy` aunque el comando sea `graphify`;
//! 2. `graphify install`, que registra la skill en la TUI.
//!
//! ## Por qué los comandos se guardan y se editan en vez de estar fijos
//!
//! El paso 1 no tiene una forma única. `uv tool install` es la recomendada, pero en un
//! macOS con Python administrado hay que usar `pipx`, y quien ya tiene su entorno armado
//! usa `pip`. Fijar uno haría que en media de las máquinas el botón falle sin alternativa.
//! Acá se guarda lo que la persona deja escrito y se ejecuta eso: los valores de fábrica
//! son un punto de partida, no una condición.
//!
//! Lo que NO es editable es **cuáles** son los pasos: eso lo dice el instalador de
//! graphify, no el usuario. Por eso [`merge_steps`] conserva el comando guardado pero
//! impone la lista — si una versión futura agrega un paso, aparece igual en una
//! instalación que ya tenía los suyos editados.
//!
//! ## Por qué corre en un shell de login
//!
//! `uv tool install` y `pipx install` dejan el ejecutable en `~/.local/bin`, que está en
//! el PATH del shell del usuario y **no** necesariamente en el de una app abierta desde el
//! menú del escritorio. Sin `-l`, el paso 1 termina bien y el paso 2 contesta
//! `graphify: command not found` — y el paso 1 parecería el que anduvo.
//!
//! ## El paso 2 no es un comando, es una elección
//!
//! `graphify install` instala la skill **para una plataforma y en un alcance**, y graphify
//! no gestiona las skills como esta app: elige la carpeta por plataforma
//! (`.opencode/skills`, `.codex/skills`…) en vez de por el estándar abierto, y copia en
//! vez de enlazar. De sus plataformas, dos caen justo donde la app ya monta skills y el
//! resto no. Eso no se puede resolver con un comando fijo: se muestran los destinos con la
//! carpeta a la que van, y el comando se arma con el que la persona elija — y después lo
//! puede seguir editando. El detalle está en [`targets`].
//!
//! ## Nada corre solo
//!
//! Ni al abrir Configuración ni al arrancar. Cada paso se ejecuta cuando la persona lo
//! pide, y lo único que la app hace sin que se lo pidan es leer: `graphify --version` y
//! los sellos `.graphify_version` que la skill deja en cada carpeta.

use serde::{Deserialize, Serialize};
use std::time::Duration;

mod catalog;
mod requirements;
mod targets;
#[cfg(test)]
mod test;

pub use catalog::{Choice, GraphifyCommand};
pub use requirements::GraphifyRequirement;
pub use targets::{install_command, GraphifyTarget, Scope};

/// Dónde se guardan los comandos editados, en el key-value de la app.
const STEPS_KEY: &str = "graphify.steps";

/// El paquete de PyPI. Se llama con dos yes aunque el comando sea `graphify`: el nombre
/// corto está tomado, y el README avisa que los otros `graphify*` no son de ellos.
pub const PACKAGE: &str = "graphifyy";

/// Los pasos y su comando de fábrica, en orden. Los ids no son texto de interfaz: la
/// interfaz les pone título y explicación traducidos, acá solo se identifican.
pub const DEFAULT_STEPS: &[(&str, &str)] = &[
    ("cli", "uv tool install graphifyy"),
    ("skill", "graphify install"),
];

/// Las tres formas documentadas de instalar el paquete, para poder llenar el paso 1 sin
/// tener que acordarse de ninguna. El orden es el del README: primero la recomendada.
pub const CLI_ALTERNATIVES: &[&str] = &[
    "uv tool install graphifyy",
    "pipx install graphifyy",
    "pip install graphifyy",
];

/// Cuánto se espera a `graphify --version`. Es una lectura: si tarda más que esto, algo
/// está mal y conviene decir "no está" antes que dejar Configuración en blanco.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Cuánto se espera a un paso. Largo a propósito: `uv tool install graphifyy` compila
/// ruedas de tree-sitter en una máquina sin wheels, y cortarlo a los dos minutos dejaría
/// una instalación a medias. El tope existe igual para que un comando que pide algo por
/// stdin no quede colgado para siempre.
const RUN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Tope de lo que se muestra de un paso. Se conserva el FINAL: un instalador imprime
/// cientos de líneas de progreso y el error, cuando lo hay, está en la última.
const OUTPUT_MAX: usize = 20_000;

/// Un paso del instalador, tal como la persona lo ve y lo edita.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GraphifyStep {
    pub id: String,
    /// Lo que se ejecuta, tal cual quedó escrito.
    pub command: String,
}

impl GraphifyStep {
    fn new(id: &str, command: &str) -> Self {
        Self { id: id.to_string(), command: command.to_string() }
    }
}

/// Todo lo que Configuración necesita para mostrar el instalador de una vez.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyPlan {
    /// Los pasos con el comando vigente: el guardado si lo hay, el de fábrica si no.
    pub steps: Vec<GraphifyStep>,
    /// Los de fábrica, para poder volver a ellos sin tener que recordarlos.
    pub defaults: Vec<GraphifyStep>,
    pub cli_alternatives: Vec<String>,
    /// Dónde puede caer la skill, con lo que hay en cada carpeta ahora. El alcance lo
    /// elige quien pregunta: la misma plataforma va a carpetas distintas según cuál sea.
    pub targets: Vec<GraphifyTarget>,
    /// Los extras de PyPI (`graphifyy[pdf,video]`): cada uno agrega un formato o un backend.
    pub extras: Vec<String>,
    /// Los backends de `--backend`, para no tener que escribirlos de memoria.
    pub backends: Vec<String>,
}

/// Si graphify ya está en el PATH del usuario, y con qué versión.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyStatus {
    pub installed: bool,
    /// Lo que contestó `graphify --version`, sin el nombre del programa: `8.3.1`.
    pub version: Option<String>,
}

/// Cómo terminó un paso.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyRun {
    pub ok: bool,
    /// El código de salida. `None` = lo mató el tope de tiempo.
    pub code: Option<i32>,
    /// Lo que imprimió, salida y errores juntos y en ese orden. Recortado al final si es
    /// muy largo (ver [`OUTPUT_MAX`]).
    pub output: String,
}

/// El comando tal como lo ejecuta el shell del usuario.
///
/// Es un shell y no un `Command` armado a mano porque lo que se ejecuta es **una línea que
/// escribió una persona**: puede traer comillas, `&&`, una variable. Partirla nosotros
/// sería inventar un parser de shell peor que el que ya hay instalado.
#[cfg(unix)]
fn shell_command(command: &str) -> std::process::Command {
    // `$SHELL` y no `bash` fijo, y `-l` para leer el perfil: es de ahí de donde sale el
    // PATH con `~/.local/bin`, que es donde `uv tool install` deja el ejecutable. Mismo
    // criterio que `terminal::pty_manager::shell_running`.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.arg("-l").arg("-c").arg(command);
    cmd
}

#[cfg(windows)]
fn shell_command(command: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/C").arg(command);
    cmd
}

/// Lo que contesta `<programa> <flag>`, o `None` si no está en el PATH.
///
/// Por el shell de login, por lo mismo que los pasos: una app abierta desde el menú del
/// escritorio no hereda el PATH de la terminal, y sin eso un `uv` recién instalado
/// aparecería como faltante.
pub(super) fn probe_version(program: &str, flag: &str) -> Option<String> {
    let mut cmd = shell_command(&format!("{program} {flag}"));
    let out = crate::util::output_with_timeout(&mut cmd, PROBE_TIMEOUT).ok()?;
    if !out.status.success() {
        return None;
    }
    // Varios escriben la versión en stderr, no en stdout.
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    requirements::first_line(&text)
        .or_else(|| requirements::first_line(&String::from_utf8_lossy(&out.stderr)))
}

/// La versión que hay adentro de lo que contesta `graphify --version` (`graphify 8.3.1`).
///
/// Tolerante: si un día imprime otra cosa, se devuelve la línea entera en vez de `None`.
/// Saber que está instalado no puede depender de acertarle al formato.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().find(|l| !l.trim().is_empty())?.trim();
    Some(line.strip_prefix("graphify").unwrap_or(line).trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Lo que se muestra de un paso: salida y errores, con el final entero si hay que recortar.
pub fn run_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut parts = Vec::new();
    for raw in [stdout, stderr] {
        let text = String::from_utf8_lossy(raw);
        let text = text.trim_end();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    tail(&parts.join("\n"), OUTPUT_MAX)
}

/// El final de un texto, avisando lo que se sacó. Se recorta por el principio porque el
/// error de un instalador está abajo, después de todo el progreso.
fn tail(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().skip(text.chars().count() - max).collect();
    // Desde el primer salto de línea, para no empezar a mitad de una.
    let kept = match kept.find('\n') {
        Some(i) => &kept[i + 1..],
        None => &kept[..],
    };
    format!("[…]\n{kept}")
}

/// Los pasos vigentes: la lista la impone la app, el comando lo pone quien lo editó.
///
/// Un id guardado que ya no existe se descarta y uno nuevo aparece con su valor de
/// fábrica, así que actualizar la app nunca deja el instalador incompleto ni con un paso
/// que ya no va.
pub fn merge_steps(saved: &[GraphifyStep]) -> Vec<GraphifyStep> {
    DEFAULT_STEPS
        .iter()
        .map(|(id, default)| {
            let command = saved
                .iter()
                .find(|s| s.id == *id)
                .map(|s| s.command.trim())
                .filter(|c| !c.is_empty())
                .unwrap_or(default);
            GraphifyStep::new(id, command)
        })
        .collect()
}

pub fn default_steps() -> Vec<GraphifyStep> {
    DEFAULT_STEPS.iter().map(|(id, command)| GraphifyStep::new(id, command)).collect()
}

/// Todo junto: los comandos vigentes y los destinos con lo que hay en cada uno.
///
/// `cwd` es el proyecto sobre el que se está mirando — el de la tab activa. Decide dónde
/// caen los destinos de alcance `project`, que son los que conviven con las skills que la
/// app monta en ese repo.
#[tauri::command]
pub fn graphify_plan(
    cwd: String,
    scope: Scope,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<GraphifyPlan, String> {
    let saved = crate::database::get_setting(&db, STEPS_KEY)?
        .and_then(|raw| serde_json::from_str::<Vec<GraphifyStep>>(&raw).ok())
        .unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    Ok(GraphifyPlan {
        steps: merge_steps(&saved),
        defaults: default_steps(),
        cli_alternatives: CLI_ALTERNATIVES.iter().map(|s| s.to_string()).collect(),
        targets: targets::targets(scope, &home, std::path::Path::new(&cwd)),
        extras: catalog::EXTRAS.iter().map(|s| s.to_string()).collect(),
        backends: catalog::BACKENDS.iter().map(|s| s.to_string()).collect(),
    })
}

/// El comando del paso 2 para un destino, para que la interfaz no arme flags de graphify.
#[tauri::command]
pub fn graphify_install_command(platform: Option<String>, scope: Scope) -> String {
    install_command(platform.as_deref(), scope)
}

/// Guarda los comandos editados. Devuelve los que quedaron vigentes, que es lo que la
/// interfaz muestra: así guardar y leer no pueden discrepar.
#[tauri::command]
pub fn graphify_save_steps(
    steps: Vec<GraphifyStep>,
    db: tauri::State<crate::database::DbConnection>,
) -> Result<Vec<GraphifyStep>, String> {
    let merged = merge_steps(&steps);
    let raw = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    crate::database::set_setting(&db, STEPS_KEY, &raw)?;
    Ok(merged)
}

/// Si graphify ya está instalado. Nunca falla: no poder preguntarlo es "no está".
#[tauri::command]
pub async fn graphify_status() -> GraphifyStatus {
    // En `spawn_blocking` y no directo: lanza un proceso y lo espera, y hacerlo sobre un
    // worker del runtime async bloquearía a todo lo demás que esté esperando ahí.
    tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = shell_command("graphify --version");
        match crate::util::output_with_timeout(&mut cmd, PROBE_TIMEOUT) {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).to_string();
                GraphifyStatus { installed: true, version: parse_version(&text) }
            }
            _ => GraphifyStatus::default(),
        }
    })
    .await
    .unwrap_or_default()
}

/// Ejecuta UN paso, en la carpeta que se le diga.
///
/// El comando es el que la persona dejó escrito en ese paso. La carpeta importa: con
/// `graphify install --project` la skill se instala en el repo donde se corrió, no en el
/// perfil del usuario.
///
/// Un paso que falla no es un error del comando: es un resultado con su código y su
/// salida, que es justamente lo que hay que leer para arreglarlo.
#[tauri::command]
pub async fn graphify_run_step(command: String, cwd: String) -> Result<GraphifyRun, String> {
    if command.trim().is_empty() {
        return Err("El paso no tiene ningún comando".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = shell_command(command.trim());
        cmd.current_dir(&cwd);
        match crate::util::output_with_timeout(&mut cmd, RUN_TIMEOUT) {
            Ok(out) => GraphifyRun {
                ok: out.status.success(),
                code: out.status.code(),
                output: run_output(&out.stdout, &out.stderr),
            },
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => GraphifyRun {
                ok: false,
                code: None,
                output: format!(
                    "El comando pasó los {} minutos y se cortó. Si de verdad tarda tanto, \
                     corrélo en una terminal.",
                    RUN_TIMEOUT.as_secs() / 60
                ),
            },
            Err(e) => GraphifyRun { ok: false, code: None, output: e.to_string() },
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Los requisitos previos, sondeados en esta máquina.
///
/// Aparte del plan porque lanza tres procesos y tarda; el instalador se dibuja sin esperar.
#[tauri::command]
pub async fn graphify_requirements() -> Vec<GraphifyRequirement> {
    tauri::async_runtime::spawn_blocking(|| requirements::probe(std::env::consts::OS))
        .await
        .unwrap_or_default()
}

/// Todo lo que graphify sabe hacer. Es una tabla constante: no toca disco ni procesos.
#[tauri::command]
pub fn graphify_commands() -> Vec<GraphifyCommand> {
    catalog::commands()
}

/// El comando final de una fila del catálogo, con los flags prendidos y los huecos llenos.
///
/// Lo arma el backend y no la interfaz para que lo que se muestra y lo que se ejecuta
/// salgan de la misma función: si se armaran por separado, un día dirían cosas distintas.
#[tauri::command]
pub fn graphify_render(id: String, choice: Choice) -> Result<String, String> {
    catalog::render(&id, &choice).ok_or_else(|| format!("no existe el comando '{id}'"))
}

/// El paso 1 con los extras elegidos: `uv tool install "graphifyy[pdf,video]"`.
///
/// Las comillas no son decorativas: sin ellas el shell se come los corchetes (zsh los trata
/// como glob) y la instalación falla con un error que no menciona a los extras.
#[tauri::command]
pub fn graphify_package_command(base: String, extras: Vec<String>) -> String {
    let extras: Vec<String> = extras.into_iter().filter(|e| !e.trim().is_empty()).collect();
    let package = if extras.is_empty() {
        PACKAGE.to_string()
    } else {
        format!("\"{PACKAGE}[{}]\"", extras.join(","))
    };
    // Se reemplaza el nombre del paquete donde esté, así funciona con `uv tool install`,
    // `pipx install` o lo que la persona haya escrito, sin tener que entenderlo entero.
    let base = base.trim();
    if base.is_empty() {
        return format!("uv tool install {package}");
    }
    base.split_whitespace()
        .map(|word| {
            let bare = word.trim_matches('"').trim_matches('\'');
            if bare == PACKAGE || bare.starts_with(&format!("{PACKAGE}[")) { package.clone() } else { word.to_string() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
