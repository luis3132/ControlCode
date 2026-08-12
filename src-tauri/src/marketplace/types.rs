//! Los tipos del marketplace: lo que ve el frontend y lo que se guarda en el cache.

use serde::{Deserialize, Serialize};

/// Segundos desde epoch, igual que el resto de las columnas de tiempo de la base.
pub(super) fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySummary {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub location: String,
    pub priority: i32,
    pub enabled: bool,
    pub last_fetched: Option<i64>,
    pub skill_count: i64,
    pub error: Option<String>,
}

/// Una skill tal como la ve el marketplace, ya resuelta contra su registry de origen.
/// `files` solo se usa para fuentes `github` (lista de paths del árbol del repo bajo
/// `folder_path`, para poder descargarlos uno a uno al instalar sin volver a pedir el
/// árbol completo); para `local` queda vacío porque la carpeta ya está en disco.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSkillEntry {
    pub id: String,
    pub registry_id: String,
    pub registry_name: String,
    pub name: String,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub compatible_agents: Vec<String>,
    pub folder_path: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Instalaciones acumuladas, ya formateadas (`"3.3K"`). Solo lo informa `skillssh`; en
    /// las demás fuentes queda en `None` y la UI no muestra el dato. Va con `default` para
    /// que un `cache_json` escrito por una versión anterior siga leyéndose.
    #[serde(default)]
    pub installs: Option<String>,
}

/// Progreso de la resolución de un registry, emitido al frontend como evento
/// `cc-registry-progress`. `total` es `None` mientras la fase no sea contable (todavía no
/// sabemos cuántos archivos hay que mirar) — la UI muestra un spinner indeterminado en ese
/// caso y una barra con porcentaje cuando sí llega un total.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProgress {
    pub registry_id: String,
    /// "connecting" | "listing" | "scanning" | "saving" | "done" | "error"
    pub phase: String,
    pub current: u32,
    pub total: Option<u32>,
    /// Qué se está mirando ahora mismo (ej. el path de la skill), para dar sensación de
    /// avance real cuando el porcentaje se mueve lento.
    pub detail: Option<String>,
}

/// Emisor de progreso atado a un registry. Se pasa por las funciones de resolución para
/// que no tengan que conocer ni el nombre del evento ni el `AppHandle`.
pub(super) struct ProgressReporter {
    app: tauri::AppHandle,
    registry_id: String,
}

impl ProgressReporter {
    pub(super) fn new(app: tauri::AppHandle, registry_id: &str) -> Self {
        Self { app, registry_id: registry_id.to_string() }
    }

    pub(super) fn emit(&self, phase: &str, current: u32, total: Option<u32>, detail: Option<String>) {
        use tauri::Emitter;
        // Best-effort: que no se pueda notificar el progreso nunca debe hacer fallar la
        // operación que se está reportando.
        let _ = self.app.emit(
            "cc-registry-progress",
            RegistryProgress {
                registry_id: self.registry_id.clone(),
                phase: phase.to_string(),
                current,
                total,
                detail,
            },
        );
    }

    /// Fase sin porcentaje posible todavía (resolver la branch, pedir el árbol del repo).
    pub(super) fn phase(&self, phase: &str) {
        self.emit(phase, 0, None, None);
    }
}

#[derive(Deserialize)]
pub(super) struct RegistryManifest {
    #[serde(default)]
    #[allow(dead_code)]
    pub(super) name: Option<String>,
    pub(super) skills: Vec<RegistryManifestSkill>,
}

#[derive(Deserialize)]
pub(super) struct RegistryManifestSkill {
    #[serde(default)]
    pub(super) id: Option<String>,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
    pub(super) path: String,
    #[serde(default)]
    pub(super) categories: Vec<String>,
    #[serde(default, rename = "compatibleAgents")]
    pub(super) compatible_agents: Vec<String>,
}
