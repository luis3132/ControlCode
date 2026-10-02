//! La tab de terminal pelada: con qué shell se abre en cada sistema, y en qué carpeta está
//! parado ahora (para volver ahí al reabrir la app).

use base64::Engine;

/// El comando con que el catálogo nombra a la terminal pelada (ver `agents::registry`).
/// Es también lo que queda guardado en cada tab: por eso el shell real se resuelve al
/// lanzar, y una tab guardada antes de este cambio también abre PowerShell en Windows.
pub const SHELL_COMMAND: &str = "bash";

/// Lo que se lanza de verdad para `command`. Solo cambia la terminal pelada en Windows: ahí
/// `bash` es el lanzador de WSL (`System32\bash.exe`), que abre WSL si está y si no falla.
pub fn resolve(command: &str) -> String {
    if command.trim() != SHELL_COMMAND {
        return command.to_string();
    }
    platform_shell()
}

#[cfg(not(windows))]
fn platform_shell() -> String {
    SHELL_COMMAND.to_string()
}

/// PowerShell 7 (`pwsh`) si está instalado; si no, Windows PowerShell, que viene siempre.
/// Con `-NoExit -EncodedCommand`: después de cargar el perfil del usuario corre
/// [`POWERSHELL_INTEGRATION`] y queda abierto para escribir.
#[cfg(windows)]
fn platform_shell() -> String {
    let program = if crate::util::find_program("pwsh").is_some() { "pwsh" } else { "powershell.exe" };
    format!("{program} -NoLogo -NoExit -EncodedCommand {}", encoded_command(POWERSHELL_INTEGRATION))
}

/// Envuelve el `prompt` del usuario (el suyo, el de oh-my-posh, el de fábrica) para que
/// antes de dibujarlo avise en qué carpeta quedó, con la secuencia OSC 9;9 que usa Windows
/// Terminal: `ESC ] 9 ; 9 ; "C:\ruta" ESC \`. Es la forma de saber la carpeta en Windows,
/// donde no se le puede preguntar al proceso desde afuera.
///
/// `[char]27` y no `` `e ``: Windows PowerShell 5.1 no conoce `` `e ``.
#[cfg_attr(not(windows), allow(dead_code))]
pub const POWERSHELL_INTEGRATION: &str = r#"
$global:__ccPrompt = $function:prompt
function global:prompt {
  $out = & $global:__ccPrompt
  $loc = $executionContext.SessionState.Path.CurrentLocation
  if ($loc.Provider.Name -eq 'FileSystem') {
    [Console]::Write("$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\")
  }
  $out
}
"#;

/// Lo que espera `-EncodedCommand`: el script en UTF-16LE, en base64. Así no hay comillas
/// que escapar en la línea de comandos.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// La carpeta donde está parado ahora el proceso `pid`. `None` = no se puede saber desde
/// afuera (Windows: ahí la informa el propio shell, ver [`POWERSHELL_INTEGRATION`]).
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<String> {
    use std::ffi::CStr;
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if read != size {
        return None;
    }
    let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char) };
    Some(path.to_string_lossy().into_owned()).filter(|p| !p.is_empty())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_cwd(_pid: u32) -> Option<String> {
    None
}
