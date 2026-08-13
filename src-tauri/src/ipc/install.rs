//! Instalación de la CLI `ccode` en el PATH del usuario.
//!
//! El binario viaja con la app (sale del mismo crate, así que `tauri build` ya lo
//! produce), pero eso no alcanza para poder escribir `ccode` en una terminal:
//!
//! - En **macOS** todo vive dentro de `ControlCode.app/Contents/`, que nunca está en el
//!   PATH, y un `.dmg` es arrastrar-y-soltar: no ejecuta ningún script de instalación.
//! - En **Windows** el instalador podría tocar el PATH, pero no en el caso portable.
//! - En **Linux** el `.deb`/`.rpm` sí puede dejarlo en `/usr/bin`, pero un AppImage no.
//!
//! Por eso existe este paso explícito, igual que el "Install 'code' command in PATH" de
//! VS Code. Nunca pide permisos de administrador: instala en un directorio del usuario.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const CLI_FILE: &str = "ccode.exe";
#[cfg(not(windows))]
const CLI_FILE: &str = "ccode";

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallStatus {
    /// `true` si en el destino ya hay algo que apunta al binario actual.
    pub installed: bool,
    /// Dónde quedaría (o quedó) instalado.
    pub target_path: String,
    /// El binario que trae esta instalación de la app. `None` si no se encontró.
    pub source_path: Option<String>,
    /// Si el directorio destino aparece en el PATH que ve la app.
    pub dir_in_path: bool,
    /// Directorio destino, para poder mostrarle al usuario qué agregar al PATH.
    pub target_dir: String,
    /// `symlink` en Unix, `copy` en Windows — cambia qué pasa al actualizar la app.
    pub method: &'static str,
}

/// El binario `ccode` que acompaña a este ejecutable. Sale del mismo crate, así que en
/// desarrollo (`target/debug/`) y en un bundle queda siempre al lado de la app.
fn source_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    let candidates = [
        dir.join(CLI_FILE),
        // macOS: `externalBin` deja los sidecars junto al ejecutable dentro de
        // `Contents/MacOS/`, pero `resources` los pone en `Contents/Resources/`.
        dir.join("../Resources").join(CLI_FILE),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Directorio donde se instala. Se elige uno del usuario a propósito: `/usr/local/bin`
/// pediría sudo en macOS moderno, y un botón de la UI no debería tener que escalar
/// privilegios para algo así.
pub(super) fn target_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(windows)]
    {
        // En Windows no hay una convención tipo `~/.local/bin`, así que se usa el
        // directorio de datos del usuario, que es donde va todo lo instalado sin admin.
        Some(home.join("AppData").join("Local").join("ControlCode").join("bin"))
    }
    #[cfg(not(windows))]
    {
        Some(home.join(".local").join("bin"))
    }
}

/// `true` si `dir` aparece en el PATH que ve este proceso.
///
/// Ojo con el falso negativo en macOS: una app lanzada desde Finder hereda un PATH
/// mínimo, no el de tu shell. Por eso la UI lo presenta como aviso ("puede que tengas que
/// agregarlo") y no como error.
fn dir_in_path(dir: &Path) -> bool {
    let Ok(path) = std::env::var("PATH") else { return false };
    std::env::split_paths(&path).any(|p| p == dir)
}

pub(super) fn is_installed(target: &Path, source: Option<&PathBuf>) -> bool {
    let Ok(meta) = target.symlink_metadata() else { return false };

    if meta.file_type().is_symlink() {
        // Un symlink que apunta a otro lado (una instalación vieja de la app) no cuenta
        // como instalado: hay que rehacerlo para que apunte al binario actual.
        return match (std::fs::read_link(target), source) {
            (Ok(dest), Some(src)) => dest == **src,
            (Ok(_), None) => true, // no sabemos cuál es el actual; hay algo puesto
            _ => false,
        };
    }
    // En Windows es una copia: alcanza con que el archivo exista.
    meta.is_file()
}

#[tauri::command]
pub fn cli_install_status() -> Result<CliInstallStatus, String> {
    let dir = target_dir().ok_or("No se pudo determinar el directorio del usuario")?;
    let target = dir.join(CLI_FILE);
    let source = source_binary();

    Ok(CliInstallStatus {
        installed: is_installed(&target, source.as_ref()),
        target_path: target.to_string_lossy().to_string(),
        source_path: source.map(|p| p.to_string_lossy().to_string()),
        dir_in_path: dir_in_path(&dir),
        target_dir: dir.to_string_lossy().to_string(),
        method: if cfg!(windows) { "copy" } else { "symlink" },
    })
}

#[tauri::command]
pub fn install_cli() -> Result<CliInstallStatus, String> {
    let source = source_binary().ok_or_else(|| {
        format!(
            "No se encontró el binario '{CLI_FILE}' junto a la app. \
             Si estás corriendo en desarrollo, compilalo con: cargo build --bin ccode"
        )
    })?;
    let dir = target_dir().ok_or("No se pudo determinar el directorio del usuario")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    let target = dir.join(CLI_FILE);

    // Se reemplaza lo que hubiera: típicamente un symlink de una versión anterior de la
    // app, que sin esto seguiría apuntando a un binario viejo o ya borrado.
    if target.symlink_metadata().is_ok() {
        let _ = symlink::remove_symlink_auto(&target);
        let _ = std::fs::remove_file(&target);
    }

    #[cfg(windows)]
    {
        // Copia y no symlink: en Windows los symlinks requieren privilegios de
        // administrador o el modo desarrollador activado. El costo es que hay que volver
        // a apretar el botón después de actualizar la app.
        std::fs::copy(&source, &target)
            .map_err(|e| format!("No se pudo copiar a {}: {e}", target.display()))?;
        add_to_user_path(&dir)?;
    }

    #[cfg(not(windows))]
    {
        // Symlink: al actualizar la app, `ccode` sigue apuntando al binario nuevo sin
        // tener que reinstalar nada.
        symlink::symlink_file(&source, &target)
            .map_err(|e| format!("No se pudo crear el symlink en {}: {e}", target.display()))?;
    }

    cli_install_status()
}

#[tauri::command]
pub fn uninstall_cli() -> Result<CliInstallStatus, String> {
    let dir = target_dir().ok_or("No se pudo determinar el directorio del usuario")?;
    let target = dir.join(CLI_FILE);

    if target.symlink_metadata().is_ok() {
        symlink::remove_symlink_auto(&target)
            .or_else(|_| std::fs::remove_file(&target))
            .map_err(|e| format!("No se pudo quitar {}: {e}", target.display()))?;
    }
    // El directorio no se toca al desinstalar, ni se saca del PATH: puede tener otras
    // cosas del usuario, y sacarlo del PATH sería mucho más invasivo que lo que se pidió.
    cli_install_status()
}

/// Agrega `dir` al PATH del usuario en Windows.
///
/// Se hace con PowerShell y no con `setx` porque `setx` trunca el valor a 1024 caracteres
/// — un PATH real lo supera fácil y quedaría corrupto. Solo se toca el PATH de USUARIO,
/// nunca el del sistema, así no hace falta ser administrador.
#[cfg(windows)]
fn add_to_user_path(dir: &Path) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();

    let script = format!(
        "$d = '{}'; \
         $p = [Environment]::GetEnvironmentVariable('Path','User'); \
         if ($p -eq $null) {{ $p = '' }} \
         if (-not ($p -split ';' | Where-Object {{ $_ -eq $d }})) {{ \
           $new = if ($p -eq '') {{ $d }} else {{ $p.TrimEnd(';') + ';' + $d }}; \
           [Environment]::SetEnvironmentVariable('Path', $new, 'User') \
         }}",
        dir_str.replace('\'', "''")
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("No se pudo actualizar el PATH: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "No se pudo actualizar el PATH: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}
