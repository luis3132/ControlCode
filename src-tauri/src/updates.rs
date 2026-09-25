//! Actualizaciones desde las releases de GitHub.
//!
//! Dos niveles, según cómo se compiló la app:
//!
//! - **Siempre**: se consulta la última release del repo y, si es más nueva, se avisa con
//!   sus notas y el instalador exacto de este sistema y arquitectura.
//! - **Con llave pública** (`CC_UPDATER_PUBKEY` al compilar, ver el workflow de release):
//!   el plugin de Tauri baja la versión nueva de `latest.json`, verifica su firma con esa
//!   llave y la instala en el mismo formato en que se instaló la app — AppImage, NSIS, MSI,
//!   `.app`, y también `.deb` y `.rpm` (con `pkexec`: el sistema pide la contraseña).
//!
//! Sin la llave no se instala nada solo: nada que no se pueda verificar.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

const REPO: &str = "luis3132/ControlCode";

/// La llave PÚBLICA con la que se verifican las actualizaciones. No es secreta (va en el
/// binario), pero sin ella no hay actualización automática.
const PUBKEY: &str = match option_env!("CC_UPDATER_PUBKEY") {
    Some(k) => k,
    None => "",
};

/// El plugin de actualización. Se registra siempre, pero sin llave no instala nada:
/// `update_install` lo rechaza antes, y la verificación de firma fallaría de todos modos.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let builder = tauri_plugin_updater::Builder::new();
    if PUBKEY.trim().is_empty() { builder.build() } else { builder.pubkey(PUBKEY).build() }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub notes: Option<String>,
    pub page_url: String,
    pub published_at: Option<String>,
    /// `auto`: se instala desde la app. `download`: se ofrece el instalador.
    pub install: &'static str,
    pub download_url: Option<String>,
    pub asset_name: Option<String>,
}

/// `1.7.10` > `1.7.9`: por números, no por texto. Lo que no es número se ignora.
pub(crate) fn newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(['.', '-', '+'])
            .map_while(|p| p.parse().ok())
            .collect()
    };
    parse(latest) > parse(current)
}

/// Cómo se instaló esta app: `deb`, `rpm`, `appimage`, `nsis`, `msi`, `app`, o `None` en un
/// build de desarrollo. El bundler lo deja marcado en el binario.
fn bundle() -> Option<&'static str> {
    use tauri::utils::config::BundleType;
    Some(match tauri::utils::platform::bundle_type()? {
        BundleType::Deb => "deb",
        BundleType::Rpm => "rpm",
        BundleType::AppImage => "appimage",
        BundleType::Nsis => "nsis",
        BundleType::Msi => "msi",
        BundleType::App | BundleType::Dmg => "app",
    })
}

/// El nombre de instalador que le corresponde a este sistema y arquitectura, según cómo
/// nombra el bundler cada uno (ver las releases).
pub(crate) fn asset_matches(name: &str, os: &str, arch: &str, bundle: Option<&str>) -> bool {
    let arm = arch == "aarch64";
    match (os, bundle) {
        ("linux", Some("rpm")) => name.ends_with(if arm { ".aarch64.rpm" } else { ".x86_64.rpm" }),
        ("linux", Some("deb")) => name.ends_with(if arm { "_arm64.deb" } else { "_amd64.deb" }),
        // Sin saber cómo se instaló (desarrollo), el AppImage: corre en cualquier distro.
        ("linux", _) => name.ends_with(if arm { "_aarch64.AppImage" } else { "_amd64.AppImage" }),
        ("windows", Some("msi")) if !arm => name.ends_with(".msi"),
        ("windows", _) => name.ends_with(if arm { "_arm64-setup.exe" } else { "_x64-setup.exe" }),
        ("macos", _) => name.ends_with(if arm { "_aarch64.dmg" } else { "_x64.dmg" }),
        _ => false,
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ControlCode-App")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let release: Value = http()?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar GitHub: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub respondió con un error: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let str_of = |k: &str| release.get(k).and_then(Value::as_str).map(str::to_string);
    let tag = str_of("tag_name").ok_or("La release no tiene tag")?;
    let latest = tag.trim_start_matches('v').to_string();
    let bundle = bundle();
    let asset = release.get("assets").and_then(Value::as_array).and_then(|assets| {
        assets.iter().find(|a| {
            a.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| asset_matches(n, std::env::consts::OS, std::env::consts::ARCH, bundle))
        })
    });
    Ok(UpdateInfo {
        newer: newer(&latest, &current),
        current,
        latest,
        notes: str_of("body").filter(|b| !b.trim().is_empty()),
        page_url: str_of("html_url").unwrap_or_else(|| format!("https://github.com/{REPO}/releases/tag/{tag}")),
        published_at: str_of("published_at"),
        install: if !PUBKEY.trim().is_empty() && bundle.is_some() { "auto" } else { "download" },
        download_url: asset.and_then(|a| a.get("browser_download_url")).and_then(Value::as_str).map(str::to_string),
        asset_name: asset.and_then(|a| a.get("name")).and_then(Value::as_str).map(str::to_string),
    })
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Baja la versión nueva, verifica la firma e instala. No reinicia: eso lo decide la
/// persona, y antes se guarda todo (ver `closeWithSave` en el frontend).
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    if PUBKEY.trim().is_empty() {
        return Err("Esta versión no tiene actualización automática: bajá el instalador".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("No se pudo buscar la actualización: {e}"))?
        .ok_or("No hay una versión más nueva")?;
    let mut downloaded = 0u64;
    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("cc-update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("No se pudo instalar: {e}"))
}

/// Reinicia con la versión recién instalada. Lo llama el frontend DESPUÉS de guardar todo.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn las_versiones_se_comparan_por_numero() {
        assert!(newer("1.7.10", "1.7.9"));
        assert!(newer("v1.8.0", "1.7.3"));
        assert!(!newer("1.7.3", "1.7.3"));
        assert!(!newer("1.7.2", "1.7.3"));
        assert!(newer("2.0.0", "1.99.99"));
    }

    #[test]
    fn cada_sistema_elige_su_instalador() {
        let names = [
            "controlcode-1.7.3-1.aarch64.rpm", "controlcode-1.7.3-1.x86_64.rpm", "controlcode_1.7.3_aarch64.AppImage",
            "controlcode_1.7.3_aarch64.dmg", "controlcode_1.7.3_amd64.AppImage", "controlcode_1.7.3_amd64.deb",
            "controlcode_1.7.3_arm64-setup.exe", "controlcode_1.7.3_arm64.deb", "controlcode_1.7.3_x64-setup.exe",
            "controlcode_1.7.3_x64.dmg", "controlcode_1.7.3_x64_en-US.msi",
        ];
        let pick = |os: &str, arch: &str, bundle: Option<&str>| {
            names.iter().filter(|n| asset_matches(n, os, arch, bundle)).copied().collect::<Vec<_>>()
        };
        assert_eq!(pick("linux", "x86_64", Some("rpm")), vec!["controlcode-1.7.3-1.x86_64.rpm"]);
        assert_eq!(pick("linux", "aarch64", Some("deb")), vec!["controlcode_1.7.3_arm64.deb"]);
        assert_eq!(pick("linux", "x86_64", None), vec!["controlcode_1.7.3_amd64.AppImage"]);
        assert_eq!(pick("windows", "x86_64", Some("nsis")), vec!["controlcode_1.7.3_x64-setup.exe"]);
        assert_eq!(pick("windows", "x86_64", Some("msi")), vec!["controlcode_1.7.3_x64_en-US.msi"]);
        assert_eq!(pick("windows", "aarch64", Some("msi")), vec!["controlcode_1.7.3_arm64-setup.exe"]);
        assert_eq!(pick("macos", "aarch64", Some("app")), vec!["controlcode_1.7.3_aarch64.dmg"]);
    }
}
