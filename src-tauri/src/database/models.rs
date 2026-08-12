//! Las filas de la base tal como las ve el resto de la app.
//!
//! Structs de datos y su traducción desde una fila de SQLite — nada de SQL ni de I/O.
//! Viven separados de `queries` porque los comparte todo el mundo: el frontend los recibe
//! serializados y varios módulos backend los construyen.

use serde::{Deserialize, Serialize};

/// Workspace implícito al que pertenece todo lo que el usuario todavía no guardó con
/// nombre propio. Existe siempre y no se puede borrar.
pub const DEFAULT_WORKSPACE_ID: &str = "default";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_active: i64,
}

/// Workspace + conteo de ventanas/tabs, para la lista de Home
/// (ej. "cliente — 2 ventanas (4+3 tabs)").
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub last_active: i64,
    pub window_count: i64,
    pub tab_count: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowRow {
    pub id: String,
    pub label: String,
    pub workspace_id: String,
    pub pos_x: Option<i32>,
    pub pos_y: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub monitor: Option<String>,
    pub is_open: bool,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabRow {
    pub id: String,
    pub window_id: String,
    pub title: Option<String>,
    pub title_is_custom: bool,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub tab_order: i32,
    pub session_id: Option<String>,
    pub scrollback: Option<String>,
    /// Entrada de `session_history` de la que salió esta tab (ver el schema de `tabs`).
    pub history_id: Option<String>,
    /// Cuenta de la TUI con la que corre esta tab; `None` = la del sistema.
    pub account_id: Option<String>,
    /// Cadena de comandos a ejecutar antes del agente (ver el módulo `prelaunch`).
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
    pub opened_at: i64,
    pub created_at: i64,
    pub last_active: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabStatePayload {
    pub id: String,
    pub title: String,
    pub title_is_custom: bool,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub tab_order: i32,
    pub session_id: Option<String>,
    pub scrollback: Option<String>,
    pub history_id: Option<String>,
    pub account_id: Option<String>,
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
    pub opened_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePayload {
    pub label: String,
    pub workspace_id: String,
    pub pos_x: Option<i32>,
    pub pos_y: Option<i32>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub monitor: Option<String>,
    pub tabs: Vec<TabStatePayload>,
    /// Si esta foto de tabs es AUTORITATIVA, o sea: la ventana ya cargó su estado desde la
    /// base y lo que manda es realmente todo lo que tiene.
    ///
    /// Solo con esto en `true` se interpreta que una tab ausente del payload es una tab que
    /// el usuario cerró (se archiva y se borra su fila). Una ventana que todavía no cargó su
    /// estado —o que falló al intentarlo— manda `false`: sus tabs se guardan igual, pero no
    /// se borra nada, porque no sabe lo suficiente como para afirmar que algo desapareció.
    ///
    /// El default es `false` a propósito: ante un payload viejo o incompleto, la opción
    /// segura es no destruir. Sin esto, una carga fallida marcaba la ventana como lista, el
    /// autosave mandaba una lista vacía y el backend archivaba y borraba todas sus tabs —
    /// llevándose por cascada (`project_skills.tab_id`) las skills de cada una, y dejando
    /// entradas de historial con `skills: []` imposibles de reanudar bien. Intermitente,
    /// porque dependía de que esa única carga fallara o llegara tarde.
    #[serde(default)]
    pub authoritative: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RestoredWindowState {
    pub window: WindowRow,
    pub tabs: Vec<TabRow>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryEntry {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub agent_label: String,
    pub command: String,
    pub cwd: String,
    pub title: Option<String>,
    pub session_id: Option<String>,
    pub skills: Vec<ArchivedSkill>,
    /// Otras tabs del workspace que estaban abiertas al cerrar esta.
    pub sibling_tabs: Vec<SiblingTab>,
    /// Cuenta de la TUI con la que corría; `None` = la del sistema.
    pub account_id: Option<String>,
    /// Cadena de pre-lanzamiento con la que se abrió, para poder reproducirla al reabrir.
    #[serde(default)]
    pub prelaunch: Vec<crate::prelaunch::PrelaunchStep>,
    pub opened_at: i64,
    pub closed_at: i64,
}

/// Tab que convivía con la sesión archivada, para poder mostrar con qué configuración de
/// tabs se estaba trabajando en ese momento.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiblingTab {
    pub title: Option<String>,
    pub agent_label: String,
    pub cwd: String,
}

/// Una skill tal como estaba activa en la tab en el momento de cerrarla. Se guarda el
/// `id` para poder reattachear exactamente la misma copia instalada, y el `name` para
/// poder reconocerla (o buscarla en el marketplace) si esa copia ya no existe.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSkill {
    pub id: String,
    pub name: String,
    /// 'tab' o 'workspace' — con qué alcance estaba attacheada.
    pub scope: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabLocation {
    pub window_label: String,
    pub tab_id: String,
}

pub(super) fn row_to_window(row: &rusqlite::Row) -> rusqlite::Result<WindowRow> {
    Ok(WindowRow {
        id: row.get(0)?,
        label: row.get(1)?,
        workspace_id: row.get(2)?,
        pos_x: row.get(3)?,
        pos_y: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        monitor: row.get(7)?,
        is_open: row.get::<_, i64>(8)? != 0,
        last_active: row.get(9)?,
    })
}

pub(super) fn row_to_tab(row: &rusqlite::Row) -> rusqlite::Result<TabRow> {
    Ok(TabRow {
        id: row.get(0)?,
        window_id: row.get(1)?,
        title: row.get(2)?,
        title_is_custom: row.get::<_, i64>(3)? != 0,
        agent_id: row.get(4)?,
        agent_label: row.get(5)?,
        command: row.get(6)?,
        cwd: row.get(7)?,
        tab_order: row.get(8)?,
        session_id: row.get(9)?,
        scrollback: row.get(10)?,
        history_id: row.get(11)?,
        account_id: row.get(12)?,
        prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(13)?),
        opened_at: row.get(14)?,
        created_at: row.get(15)?,
        last_active: row.get(16)?,
    })
}
