//! El PATH con el que la app busca y lanza las TUIs.
//!
//! ## El problema
//!
//! Una app abierta desde el menú del escritorio NO hereda el PATH de la terminal del
//! usuario, y el de la terminal es el único donde los instaladores dejan sus carpetas:
//!
//! - **Ubuntu/Debian.** El instalador de OpenCode agrega `~/.opencode/bin` al final de
//!   `~/.bashrc`, y el `~/.bashrc` de Ubuntu empieza con `case $- in *i*) ;; *) return;;`:
//!   un shell que no es interactivo —el de la sesión de escritorio, y también `bash -l`—
//!   se va en la línea 6 y nunca llega. Reproducido en un contenedor 24.04: `which` no lo
//!   encuentra, `bash -l -c` tampoco, `bash -i -l -c` sí. En Fedora no pasaba porque su
//!   `~/.bashrc` no tiene ese corte: la sesión de GNOME lo lee entero.
//! - **macOS.** Lo que se abre desde el Dock recibe el PATH de launchd,
//!   `/usr/bin:/bin:/usr/sbin:/sbin`: sin Homebrew, sin `~/.local/bin`, sin nvm.
//! - **Arch** y otras bases mínimas no traen `which`, y la detección lo usaba: ahí no se
//!   encontraba ninguna TUI.
//!
//! Y no es solo la lista de agentes: la terminal embebida busca el programa en el mismo
//! PATH, así que una TUI que la lista mostrara tampoco se habría podido lanzar.
//!
//! ## La solución
//!
//! Al arrancar, con el proceso todavía en un solo hilo, se arma el PATH real y se deja en
//! el entorno del proceso. Así lo heredan TODOS: la detección, la terminal, los procesos
//! de la flota, `opencode session list`, git, graphify y cualquier cosa que se agregue
//! después sin tener que acordarse de esto.
//!
//! Se arma con tres fuentes, en este orden de prioridad:
//!
//! 1. **El shell del usuario, interactivo y de login** (`$SHELL -ilc`): es el único que lee
//!    todo lo que la persona configuró, y es exactamente lo que ve cuando escribe
//!    `opencode` en su terminal. Es lo mismo que hace VS Code (`resolveShellEnv`).
//! 2. **El PATH heredado**, por si el shell no pudo contestar (o faltaba algo).
//! 3. **Las carpetas donde instalan las TUIs** (`~/.opencode/bin`, `~/.local/bin`,
//!    Homebrew, `%APPDATA%\npm`…), al final: solo deciden si nada más encontró el programa.
//!
//! En Windows no hay paso 1: el PATH de una app de ventana sale del registro y ya es el
//! del usuario. Ahí lo que fallaba era otra cosa —ver [`find_program`]—.
//!
//! Solo se toma el PATH, no el resto del entorno del shell. Importar todo cambiaría con qué
//! variables corre cada TUI (claves, proxies, `NODE_OPTIONS`) de una forma que nadie pidió;
//! para encontrar y lanzar programas alcanza con el PATH.

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(unix)]
use std::time::Duration;

/// Cuánto se espera al shell. Un perfil normal tarda menos de medio segundo (con nvm, un
/// poco más). El tope existe para un perfil roto —uno que abre tmux, o que pregunta algo—:
/// la app tiene que abrir igual, con el PATH que haya.
#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// La variable que el shell ve mientras se lo consulta. Es la misma idea que
/// `VSCODE_RESOLVING_ENVIRONMENT`: quien tenga algo pesado en su perfil (un `exec tmux`,
/// un `neofetch`) puede saltearlo con `[ -n "$CONTROLCODE_RESOLVING_ENVIRONMENT" ] && return`.
#[cfg(unix)]
pub const RESOLVING_ENV: &str = "CONTROLCODE_RESOLVING_ENVIRONMENT";

/// Qué se hizo al arrancar, para poder mostrarlo en Configuración: "no la encuentro" sin
/// decir dónde se buscó no le sirve a nadie.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PathReport {
    /// El shell que se consultó. `None` = no se consulta en este sistema (Windows).
    pub shell: Option<String>,
    /// Si el shell contestó. Cuando no, `shell_error` dice por qué.
    pub shell_ok: bool,
    pub shell_error: Option<String>,
    /// Carpetas que aportó el shell y que el proceso NO tenía: es lo que esto arregla.
    pub from_shell: Vec<String>,
    /// Carpetas de instalación conocidas que se sumaron al final.
    pub known: Vec<String>,
    /// El PATH con el que quedó el proceso, en orden.
    pub effective: Vec<String>,
}

static REPORT: OnceLock<PathReport> = OnceLock::new();

/// Lo que se hizo al arrancar. Vacío si `configure` no corrió (los tests).
pub fn report() -> PathReport {
    REPORT.get().cloned().unwrap_or_default()
}

/// Arma el PATH real y lo deja en el entorno del proceso.
///
/// Tiene que correr con el proceso en un solo hilo: antes del hilo de señales y antes de
/// construir Tauri (ver `app::run`). Escribir el entorno mientras otro hilo lo lee es
/// comportamiento indefinido — por eso `set_var` es `unsafe` —, y WebKit lee el entorno
/// desde sus propios hilos todo el tiempo. Por lo mismo la consulta al shell no usa
/// [`super::output_with_timeout`]: esa crea hilos para drenar los pipes, y si el shell se
/// cuelga, quedan vivos.
pub fn configure() {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let home = dirs::home_dir();

    #[cfg(unix)]
    let (shell, from_shell) = {
        let shell = user_shell();
        let result = shell_path(&shell, &[]);
        (Some(shell), result)
    };
    #[cfg(not(unix))]
    let (shell, from_shell): (Option<String>, Result<String, String>) =
        (None, Err("en Windows el PATH ya viene del registro".into()));

    let known = home.as_deref().map(known_dirs).unwrap_or_default();
    let merged = merge(from_shell.as_deref().ok(), &inherited, &known);

    let before: Vec<PathBuf> = std::env::split_paths(&inherited).collect();
    let report = PathReport {
        shell_ok: from_shell.is_ok(),
        shell_error: from_shell.as_ref().err().cloned(),
        from_shell: from_shell
            .as_deref()
            .map(|p| {
                std::env::split_paths(p)
                    .filter(|d| !before.contains(d))
                    .map(|d| d.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default(),
        known: known
            .iter()
            .filter(|d| !before.contains(d))
            .map(|d| d.to_string_lossy().into_owned())
            .collect(),
        effective: merged.iter().map(|d| d.to_string_lossy().into_owned()).collect(),
        shell,
    };

    if let Ok(joined) = std::env::join_paths(&merged) {
        // SAFETY: `app::run` llama a esto antes de crear cualquier hilo — el de señales es
        // el primero, y abrir SQLite no crea ninguno. La consulta al shell tampoco (ver
        // `run_shell`), así que en este punto el proceso sigue teniendo uno solo.
        unsafe { std::env::set_var("PATH", joined) };
    }
    let _ = REPORT.set(report);
}

/// El PATH final: el del shell primero, después lo heredado que falte, al final las
/// carpetas conocidas. Sin repetidos y sin entradas vacías.
///
/// Las vacías se sacan a propósito: en un PATH, una entrada vacía significa "la carpeta
/// actual", y eso haría que abrir una tab en un repo ejecute un `opencode` que esté en la
/// raíz de ese repo en vez del instalado.
pub fn merge(from_shell: Option<&str>, inherited: &std::ffi::OsStr, known: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !dir.as_os_str().is_empty() && !out.contains(&dir) {
            out.push(dir);
        }
    };
    if let Some(shell) = from_shell {
        std::env::split_paths(shell).for_each(&mut push);
    }
    std::env::split_paths(inherited).for_each(&mut push);
    known.iter().cloned().for_each(&mut push);
    out
}

/// Lo que hay entre las dos marcas en lo que imprimió el shell. (En Windows no hay shell
/// que consultar; queda para los tests.)
///
/// Las marcas existen porque un shell interactivo imprime cosas por su cuenta —un saludo,
/// un `fortune`, el aviso de "no job control"— y todo eso cae en la misma salida.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn between_markers(output: &str, marker: &str) -> Option<String> {
    let start = output.find(marker)? + marker.len();
    let rest = &output[start..];
    let end = rest.find(marker)?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// El shell del usuario: `$SHELL`, o el de su cuenta si la app no lo recibió.
///
/// En macOS una app lanzada por launchd puede no traer `SHELL`; el de la cuenta es el
/// que figura en la base de usuarios, y es el mismo que abre la Terminal.
#[cfg(unix)]
fn user_shell() -> String {
    if let Some(shell) = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()) {
        return shell;
    }
    // SAFETY: `getpwuid` no es reentrante, pero esto corre con el proceso en un solo hilo
    // (ver `configure`). El puntero se lee enseguida y no se guarda.
    let from_passwd = unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            None
        } else {
            std::ffi::CStr::from_ptr((*entry).pw_shell).to_str().ok().map(str::to_string)
        }
    };
    from_passwd.filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
}

/// El PATH que ve el usuario en su terminal.
///
/// Primero interactivo y de login (`-i -l -c`), que es lo único que lee el `~/.bashrc`
/// de Ubuntu entero. Si ese shell no acepta esos flags —csh exige `-l` solo—, se prueba
/// de login a secas. Si se colgó, no se reintenta: el segundo intento se colgaría igual.
///
/// `envs` son variables extra para el shell. En la app va vacío; los tests lo usan para
/// apuntarlo a un `HOME` armado a mano, sin tocar el entorno del proceso.
#[cfg(unix)]
pub fn shell_path(shell: &str, envs: &[(&str, &std::ffi::OsStr)]) -> Result<String, String> {
    let marker = format!("__CONTROLCODE_PATH_{}__", std::process::id());
    // `printf` y `printenv` existen en bash, zsh, fish, dash y busybox. `printenv` es un
    // programa aparte, así que el PATH sale igual sin importar cómo lo guarde cada shell
    // (fish lo tiene como lista).
    let script = format!("printf '%s\\n' '{marker}'; printenv PATH; printf '%s\\n' '{marker}'");
    let mut last = String::new();
    for flags in [&["-i", "-l", "-c"][..], &["-l", "-c"][..]] {
        match run_shell(shell, flags, &script, envs) {
            Ok(output) => match between_markers(&output, &marker) {
                Some(path) => return Ok(path),
                None => last = format!("{shell} {} no devolvió el PATH", flags.join(" ")),
            },
            Err(ShellError::TimedOut) => {
                return Err(format!(
                    "{shell} no terminó en {}s: algo en el perfil espera o no termina (ver {RESOLVING_ENV})",
                    SHELL_TIMEOUT.as_secs()
                ));
            }
            Err(ShellError::Failed(e)) => last = e,
        }
    }
    Err(last)
}

#[cfg(unix)]
enum ShellError {
    TimedOut,
    Failed(String),
}

/// Lanza el shell sin crear hilos, y lo mata entero si se pasa del tope.
///
/// - La salida va a un archivo y no a un pipe: leer un pipe sin bloquear necesitaría un
///   hilo, y acá todavía no puede haber ninguno (ver `configure`).
/// - `setsid` le da una sesión propia, sin terminal. Un shell interactivo sin terminal no
///   activa el control de trabajos; con la terminal de quien abrió la app —si la abrió
///   desde una— se la podría quedar, y esa terminal dejaría de responder.
/// - Al vencer, se mata el GRUPO: un perfil que lanza algo en segundo plano (un agente de
///   ssh, un `tmux`) no puede dejar procesos colgados de la app.
#[cfg(unix)]
fn run_shell(
    shell: &str,
    flags: &[&str],
    script: &str,
    envs: &[(&str, &std::ffi::OsStr)],
) -> Result<String, ShellError> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let file = std::env::temp_dir().join(format!(
        "controlcode-path-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    let out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|e| ShellError::Failed(format!("no se pudo crear {}: {e}", file.display())))?;

    let mut cmd = std::process::Command::new(shell);
    cmd.args(flags)
        .arg(script)
        .env(RESOLVING_ENV, "1")
        // Sin colores ni prompts elaborados: nadie va a mirar esta salida.
        .env("TERM", "dumb")
        .envs(envs.iter().copied())
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(Stdio::null());
    // SAFETY: `setsid` es async-signal-safe, que es lo único que se puede llamar entre el
    // fork y el exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let result = (|| {
        let mut child = cmd.spawn().map_err(|e| ShellError::Failed(format!("no se pudo lanzar {shell}: {e}")))?;
        let deadline = std::time::Instant::now() + SHELL_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    // SAFETY: después de `setsid` el shell es líder de su propio grupo, así
                    // que `-pid` alcanza a todo lo que lanzó y a nada más.
                    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                    let _ = child.wait();
                    return Err(ShellError::TimedOut);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(15)),
                Err(e) => return Err(ShellError::Failed(e.to_string())),
            }
        }
        std::fs::read_to_string(&file).map_err(|e| ShellError::Failed(e.to_string()))
    })();
    let _ = std::fs::remove_file(&file);
    result
}

/// Las carpetas donde instalan las TUIs y sus runtimes, por si el shell no las dio.
///
/// Las que están adentro del home se suman AUNQUE todavía no existan: una TUI instalada
/// con la app ya abierta crea la carpeta en ese momento, y "volver a buscar" tiene que
/// encontrarla sin reiniciar. Las del sistema, solo si existen.
pub fn known_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    #[cfg(unix)]
    {
        for rel in [
            // Claude Code (instalador nativo), pipx, `uv tool`, Kimi.
            ".local/bin",
            // El instalador oficial de OpenCode.
            ".opencode/bin",
            ".bun/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".deno/bin",
            ".yarn/bin",
            ".nix-profile/bin",
            // Gestores de versiones de Node: fnm, asdf y mise. Es por donde se instala un
            // Node nuevo en las distros cuyos repositorios traen uno viejo.
            ".local/share/fnm/aliases/default/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            "bin",
        ] {
            dirs.push(home.join(rel));
        }
        // nvm: la versión nueva primero. La que el usuario eligió como `default` la da el
        // shell; esto es el respaldo cuando el shell no contestó.
        dirs.extend(nvm_bins(&home.join(".nvm/versions/node")));
        for system in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/snap/bin",
            "/nix/var/nix/profiles/default/bin",
        ] {
            let dir = PathBuf::from(system);
            if dir.is_dir() {
                dirs.push(dir);
            }
        }
    }

    #[cfg(windows)]
    {
        let env_dir = |var: &str, rel: &str| std::env::var_os(var).map(|base| PathBuf::from(base).join(rel));
        dirs.extend(
            [
                // `npm i -g`: deja `opencode.cmd`, `claude.cmd`… (ver `find_program`).
                env_dir("APPDATA", "npm"),
                Some(home.join(".local").join("bin")),
                Some(home.join(".opencode").join("bin")),
                Some(home.join(".bun").join("bin")),
                Some(home.join(".cargo").join("bin")),
                Some(home.join("scoop").join("shims")),
                env_dir("LOCALAPPDATA", "Microsoft\\WinGet\\Links"),
                env_dir("LOCALAPPDATA", "Volta\\bin"),
                env_dir("ProgramData", "chocolatey\\bin"),
            ]
            .into_iter()
            .flatten(),
        );
        // Node: el instalador oficial (y `winget install OpenJS.NodeJS`) y nvm-windows. Son
        // del sistema: solo si existen.
        let node = [env_dir("ProgramFiles", "nodejs"), std::env::var_os("NVM_SYMLINK").map(PathBuf::from)];
        dirs.extend(node.into_iter().flatten().filter(|d| d.is_dir()));
    }

    dirs
}

/// Los `bin` de cada versión de node instalada con nvm, la más nueva primero.
#[cfg(unix)]
fn nvm_bins(versions: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(versions) else { return Vec::new() };
    let mut found: Vec<(Vec<u64>, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let parts = name.trim_start_matches('v').split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
            let bin = entry.path().join("bin");
            bin.is_dir().then_some((parts, bin))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, bin)| bin).collect()
}

/// Dónde está un programa, buscándolo en el PATH del proceso.
///
/// Reemplaza a `which`/`where`: `which` no viene en todas las distribuciones (Arch base no
/// lo trae) y lanzar un proceso por cada TUI solo para preguntar si existe es más lento y
/// más frágil que mirar el disco.
///
/// En Windows respeta `PATHEXT`. Importa por los instaladores de npm, que dejan
/// `opencode.cmd` y no `opencode.exe`: el `Command` de Rust solo completa `.exe`, así que
/// lanzar `opencode` a secas fallaba aunque `where` lo encontrara. Con la ruta completa
/// del `.cmd` funciona.
pub fn find_program(name: &str) -> Option<PathBuf> {
    find_in(name, std::env::var_os("PATH"), &extensions())
}

/// Dónde está un programa en un PATH dado, en vez del del proceso.
pub fn find_program_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    find_in(name, Some(path.to_os_string()), &extensions())
}

/// El PATH como quedaría si la app arrancara ahora: le vuelve a preguntar al shell y
/// vuelve a mirar las carpetas conocidas.
///
/// Es para ver algo instalado con la app abierta —un Node nuevo con nvm— sin reiniciarla.
/// No toca el entorno del proceso (con hilos corriendo no se puede, ver `configure`):
/// quien lo usa se lo pasa a su proceso hijo. Tarda lo que tarde el shell, hasta
/// `SHELL_TIMEOUT`, así que no va en un camino que se repita seguido.
pub fn fresh_path() -> OsString {
    let current = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(unix)]
    let from_shell = shell_path(&user_shell(), &[]).ok();
    #[cfg(not(unix))]
    let from_shell: Option<String> = None;
    let known = dirs::home_dir().as_deref().map(known_dirs).unwrap_or_default();
    std::env::join_paths(merge(from_shell.as_deref(), &current, &known)).unwrap_or(current)
}

/// Un `Command` para un programa, con la ruta completa si se encontró. Si no, con el
/// nombre tal cual, y el error de lanzarlo es el de siempre.
pub fn program(name: &str) -> std::process::Command {
    match find_program(name) {
        Some(path) => std::process::Command::new(path),
        None => std::process::Command::new(name),
    }
}

/// Las extensiones de ejecutable: `PATHEXT` en Windows, ninguna en el resto.
fn extensions() -> Vec<String> {
    if cfg!(windows) {
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        raw.split(';').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect()
    } else {
        Vec::new()
    }
}

/// La búsqueda, sobre un PATH y unas extensiones dados, para poder probarla sin tocar el
/// entorno.
pub fn find_in(name: &str, path: Option<OsString>, extensions: &[String]) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // Con separador es una ruta, no un nombre: se mira ahí y en ningún otro lado.
    if name.contains('/') || (cfg!(windows) && name.contains('\\')) {
        return candidates(Path::new(name), extensions).into_iter().find(|c| is_executable(c));
    }
    std::env::split_paths(&path?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| candidates(&dir.join(name), extensions))
        .find(|c| is_executable(c))
}

/// Los nombres que puede tener el archivo: tal cual, y con cada extensión si no trae una
/// de las conocidas.
fn candidates(base: &Path, extensions: &[String]) -> Vec<PathBuf> {
    if extensions.is_empty() {
        return vec![base.to_path_buf()];
    }
    let has_known = base
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()).to_lowercase())
        .is_some_and(|ext| extensions.iter().any(|x| x.to_lowercase() == ext));
    if has_known {
        return vec![base.to_path_buf()];
    }
    extensions
        .iter()
        .map(|ext| {
            let mut name = base.as_os_str().to_os_string();
            name.push(ext.to_lowercase());
            PathBuf::from(name)
        })
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}
