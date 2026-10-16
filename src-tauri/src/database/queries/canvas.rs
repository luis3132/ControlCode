//! Las páginas del canvas. El frontend es el dueño de su contenido (`data` es su JSON); acá
//! solo se guardan y se leen por workspace.

use serde::{Deserialize, Serialize};

use crate::database::DbConnection;
use crate::util::now_ts;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPageRow {
    pub id: String,
    pub workspace: String,
    pub name: String,
    pub position: i64,
    pub data: String,
}

pub(crate) fn load_canvas_pages(conn: &rusqlite::Connection, workspace: &str) -> rusqlite::Result<Vec<CanvasPageRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace, name, position, data FROM canvas_pages
         WHERE workspace = ?1 ORDER BY position, updated_at",
    )?;
    let rows = stmt.query_map([workspace], |r| {
        Ok(CanvasPageRow { id: r.get(0)?, workspace: r.get(1)?, name: r.get(2)?, position: r.get(3)?, data: r.get(4)? })
    })?;
    rows.collect()
}

pub(crate) fn save_canvas_page(conn: &rusqlite::Connection, page: &CanvasPageRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO canvas_pages (id, workspace, name, position, data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
             workspace  = excluded.workspace,
             name       = excluded.name,
             position   = excluded.position,
             data       = excluded.data,
             updated_at = excluded.updated_at",
        rusqlite::params![page.id, page.workspace, page.name, page.position, page.data, now_ts()],
    )?;
    Ok(())
}

#[tauri::command]
pub fn canvas_pages_load(workspace: String, db: tauri::State<DbConnection>) -> Result<Vec<CanvasPageRow>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    load_canvas_pages(&conn, &workspace).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_page_save(page: CanvasPageRow, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    save_canvas_page(&conn, &page).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_page_delete(id: String, db: tauri::State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM canvas_pages WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    fn page(id: &str, workspace: &str, position: i64) -> CanvasPageRow {
        CanvasPageRow { id: id.into(), workspace: workspace.into(), name: id.into(), position, data: "{}".into() }
    }

    #[test]
    fn cada_workspace_lee_solo_sus_paginas_en_orden() {
        let conn = crate::database::schema::in_memory();
        save_canvas_page(&conn, &page("b", "/p", 1)).unwrap();
        save_canvas_page(&conn, &page("a", "/p", 0)).unwrap();
        save_canvas_page(&conn, &page("x", "/otro", 0)).unwrap();
        let ids: Vec<String> = load_canvas_pages(&conn, "/p").unwrap().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn guardar_de_nuevo_reemplaza_la_pagina() {
        let conn = crate::database::schema::in_memory();
        save_canvas_page(&conn, &page("a", "/p", 0)).unwrap();
        let mut renamed = page("a", "/p", 0);
        renamed.name = "Arquitectura".into();
        renamed.data = r#"{"nodes":[]}"#.into();
        save_canvas_page(&conn, &renamed).unwrap();
        assert_eq!(load_canvas_pages(&conn, "/p").unwrap(), vec![renamed]);
    }
}
