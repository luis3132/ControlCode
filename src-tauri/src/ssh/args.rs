//! Validar una conexión y armar los argumentos de `ssh` y `scp`.
//!
//! Todo es puro a propósito: lo que termina en la línea de comandos de `ssh` es lo que más
//! importa probar, y así se prueba sin red ni procesos.

use super::model::{SshConnection, SshConnectionDraft};

/// Cuánto espera `ssh` a que el otro equipo conteste antes de rendirse.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;

fn clean(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Lo que empieza con `-` lo leería `ssh` como una opción: un host `-oProxyCommand=…`
/// ejecutaría un comando local. Tampoco pueden llevar espacios ni saltos de línea.
fn plain_token(value: &str, what: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!("{what} no puede empezar con '-'"));
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{what} no puede tener espacios"));
    }
    Ok(())
}

/// Deja el formulario listo para guardar, o dice qué está mal.
///
/// Acepta `usuario@equipo` en el campo del equipo, que es como se escribe en la terminal:
/// lo parte en vez de rechazarlo.
pub fn normalize_draft(draft: SshConnectionDraft) -> Result<SshConnectionDraft, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("El nombre no puede estar vacío".into());
    }
    if name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("El nombre solo puede tener letras, números, '-', '_' y '.' (es lo que escriben los agentes)".into());
    }

    let mut host = draft.host.trim().to_string();
    let mut user = clean(draft.user);
    if let Some((u, h)) = host.split_once('@') {
        if user.is_some() {
            return Err("El usuario va en su propio campo, no en el del equipo".into());
        }
        user = Some(u.to_string()).filter(|u| !u.is_empty());
        host = h.to_string();
    }
    if host.is_empty() {
        return Err("Falta el equipo (IP, nombre o alias de ~/.ssh/config)".into());
    }
    plain_token(&host, "El equipo")?;
    if host.contains('@') {
        return Err("El equipo no puede tener más de una '@'".into());
    }
    if let Some(u) = &user {
        plain_token(u, "El usuario")?;
        if u.contains('@') || u.contains(':') {
            return Err("El usuario no puede tener '@' ni ':'".into());
        }
    }
    if draft.port == Some(0) {
        return Err("El puerto tiene que estar entre 1 y 65535".into());
    }

    let identity_file = clean(draft.identity_file);
    if let Some(key) = &identity_file {
        if key.starts_with('-') {
            return Err("La ruta de la clave no puede empezar con '-'".into());
        }
        if key.contains('"') || key.chars().any(char::is_control) {
            return Err("La ruta de la clave no puede tener comillas dobles".into());
        }
    }

    // La carpeta viaja entre comillas dobles en el comando de la terminal (ver
    // `terminal_command`), así que no puede tener una.
    let remote_dir = clean(draft.remote_dir);
    if let Some(dir) = &remote_dir
        && (dir.contains('"') || dir.chars().any(char::is_control))
    {
        return Err("La carpeta remota no puede tener comillas dobles".into());
    }

    Ok(SshConnectionDraft {
        id: clean(draft.id),
        name,
        host,
        user,
        port: draft.port,
        identity_file,
        remote_dir,
        agent_access: draft.agent_access,
    })
}

/// La conexión que describe un formulario, sin guardarla (para "Probar" antes de guardar).
pub fn connection_from_draft(draft: SshConnectionDraft) -> Result<SshConnection, String> {
    let d = normalize_draft(draft)?;
    Ok(SshConnection {
        id: d.id.unwrap_or_default(),
        name: d.name,
        host: d.host,
        user: d.user,
        port: d.port,
        identity_file: d.identity_file,
        remote_dir: d.remote_dir,
        agent_access: d.agent_access,
        created_at: 0,
    })
}

/// `usuario@equipo`, o solo el equipo.
pub fn destination(c: &SshConnection) -> String {
    match &c.user {
        Some(user) => format!("{user}@{}", c.host),
        None => c.host.clone(),
    }
}

/// `~/…` al home local: `ssh -i` lo expande solo, pero `scp` y Windows no siempre.
fn expand_home(path: &str) -> String {
    match (path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// Opciones comunes a `ssh` y `scp`. El puerto es la única diferencia entre los dos
/// (`-p` en uno, `-P` en el otro).
fn common_options(c: &SshConnection, batch: bool, port_flag: &str) -> Vec<String> {
    let mut out = Vec::new();
    if batch {
        // Sin nadie del otro lado para escribir una contraseña o aceptar una huella nueva,
        // `ssh` tiene que fallar enseguida en vez de quedarse esperando.
        out.extend(["-o".into(), "BatchMode=yes".into()]);
        out.extend(["-o".into(), format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}")]);
    }
    if let Some(port) = c.port {
        out.extend([port_flag.to_string(), port.to_string()]);
    }
    if let Some(key) = &c.identity_file {
        out.extend(["-i".into(), expand_home(key)]);
    }
    out
}

/// Comillas de shell POSIX, conservando `~` al principio para que el shell remoto lo
/// expanda (entre comillas quedaría literal).
pub fn sh_quote(value: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    if value == "~" {
        "~".into()
    } else if let Some(rest) = value.strip_prefix("~/") {
        if rest.is_empty() { "~/".into() } else { format!("~/{}", quote(rest)) }
    } else {
        quote(value)
    }
}

/// El comando a correr del otro lado, parado en `dir` si hay una.
///
/// El `cd` y el `&&` asumen un shell POSIX del otro lado (Linux, macOS, WSL). Un Windows
/// con el `cmd` por defecto no entiende las comillas simples: ahí conviene dejar la
/// carpeta vacía y hacer el `cd` en el comando.
pub fn remote_command(dir: Option<&str>, command: &str) -> String {
    match dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => format!("cd {} && {command}", sh_quote(dir)),
        None => command.to_string(),
    }
}

/// Los argumentos de `ssh` para correr `command` sin interacción.
pub fn exec_args(c: &SshConnection, command: &str, cwd: Option<&str>) -> Vec<String> {
    let mut out = common_options(c, true, "-p");
    out.push(destination(c));
    out.push(remote_command(cwd.or(c.remote_dir.as_deref()), command));
    out
}

/// Una ruta del otro equipo como la escribe `scp`: `usuario@equipo:ruta`. Una IPv6 va
/// entre corchetes, si no sus `:` se confundirían con el separador.
pub fn scp_remote(c: &SshConnection, path: &str) -> String {
    let host = if c.host.contains(':') { format!("[{}]", c.host) } else { c.host.clone() };
    match &c.user {
        Some(user) => format!("{user}@{host}:{path}"),
        None => format!("{host}:{path}"),
    }
}

/// Los argumentos de `scp` para copiar `from` a `to` (uno de los dos ya en forma remota).
pub fn scp_args(c: &SshConnection, from: &str, to: &str, recursive: bool) -> Vec<String> {
    let mut out = common_options(c, true, "-P");
    if recursive {
        out.push("-r".into());
    }
    out.push(from.to_string());
    out.push(to.to_string());
    out
}

/// Una palabra para `split_command` de la terminal (ver `terminal::pty_manager`): entre
/// comillas dobles si tiene espacios. Las validaciones ya garantizan que no traiga una.
fn word(value: &str) -> String {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

/// El comando de una tab de terminal conectada a esa computadora.
///
/// Interactivo a propósito (sin `BatchMode`): acá SÍ hay una persona para escribir la
/// contraseña o aceptar la huella de un equipo nuevo. Es también cómo se deja un equipo en
/// `known_hosts` para que después lo puedan usar los agentes.
pub fn terminal_command(c: &SshConnection) -> String {
    let mut words = vec!["ssh".to_string()];
    words.extend(common_options(c, false, "-p").iter().map(|o| word(o)));
    match c.remote_dir.as_deref() {
        Some(dir) => {
            // `-t` porque con un comando remoto `ssh` no pide una terminal sola, y sin ella
            // el shell de allá no sería interactivo. El comando va entero entre comillas
            // dobles: `$SHELL` lo expande el shell REMOTO, no el local.
            words.push("-t".into());
            words.push(word(&destination(c)));
            words.push(format!("\"cd {} && exec $SHELL -l\"", sh_quote(dir)));
        }
        None => words.push(word(&destination(c))),
    }
    words.join(" ")
}

/// Un consejo para los errores de `ssh` que tienen arreglo conocido.
pub fn hint_for(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_lowercase();
    if s.contains("host key verification failed") || s.contains("no matching host key") {
        Some("El equipo todavía no es de confianza. Abrí una terminal con esta conexión una vez y aceptá su huella; después la van a poder usar los agentes.")
    } else if s.contains("remote host identification has changed") {
        Some("La huella del equipo cambió. Si lo reinstalaste es normal: borrá la línea vieja con `ssh-keygen -R <equipo>`. Si no, puede ser otro equipo haciéndose pasar por este.")
    } else if s.contains("permission denied") {
        Some("El equipo rechazó la clave. Los agentes necesitan una clave SSH (no contraseña): `ssh-copy-id usuario@equipo` desde una terminal, o elegí el archivo de clave.")
    } else if s.contains("could not resolve hostname") || s.contains("name or service not known") {
        Some("No se encontró ese nombre. Probá con la IP, o revisá el alias en ~/.ssh/config.")
    } else if s.contains("connection refused") {
        Some("El equipo contesta pero no tiene un servidor SSH en ese puerto. Instalá/prendé OpenSSH Server allá.")
    } else if s.contains("timed out") || s.contains("no route to host") {
        Some("El equipo no contesta. ¿Está prendido y en la misma red? Fuera de tu red, algo como Tailscale los conecta sin abrir puertos.")
    } else {
        None
    }
}
