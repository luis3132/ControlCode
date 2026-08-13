//! Apertura de la base y el handle compartido que usa el resto de la app.
//!
//! Acá NO hay consultas: solo dónde vive el archivo, cómo se abre y en qué orden se deja
//! listo (migrar → sembrar → limpiar). El SQL vive en `queries`, el schema en `schema`.

use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// La conexión es única y compartida por toda la app: SQLite en modo por defecto no
/// admite escrituras concurrentes, así que el `Mutex` es el que serializa el acceso.
pub type DbConnection = Arc<Mutex<Connection>>;

fn db_path() -> PathBuf {
    let home = dirs::home_dir().expect("Cannot determine home directory");
    let dir = home.join(".controlcode");
    std::fs::create_dir_all(&dir).expect("Cannot create ~/.controlcode");
    dir.join("data.db")
}

/// Abre (o crea) la base del usuario y la deja lista para usar.
pub fn init_db() -> SqlResult<DbConnection> {
    let conn = Connection::open(db_path())?;

    // SQLite trae el enforcement de FK apagado por defecto en cada conexión — sin esto,
    // todos los `ON DELETE CASCADE` del schema (workspaces→windows→tabs→project_skills,
    // skills→project_skills, workspaces→session_history) son un no-op silencioso: borrar
    // un workspace/ventana/skill deja filas huérfanas en las tablas hijas para siempre
    // en vez de limpiarlas.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    super::schema::migrate(&conn)?;
    super::seeds::seed_defaults(&conn)?;
    super::queries::dedupe_session_history_once(&conn)?;

    Ok(Arc::new(Mutex::new(conn)))
}
