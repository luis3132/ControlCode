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
    init_db_at(&db_path())
}

/// Lo mismo sobre un archivo dado: es lo que se prueba con varias "instancias" a la vez.
pub(crate) fn init_db_at(path: &std::path::Path) -> SqlResult<DbConnection> {
    let conn = Connection::open(path)?;

    // SQLite trae el enforcement de FK apagado por defecto en cada conexión — sin esto,
    // todos los `ON DELETE CASCADE` del schema (workspaces→windows→tabs→project_skills,
    // skills→project_skills, workspaces→session_history) son un no-op silencioso: borrar
    // un workspace/ventana/skill deja filas huérfanas en las tablas hijas para siempre
    // en vez de limpiarlas.
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;

    // Varias Control Code abiertas a la vez (la instalada y un `tauri dev`, o la misma dos
    // veces) comparten este archivo. Con el journal por defecto y sin espera, la segunda que
    // escribía mientras la otra tenía el lock fallaba en el acto con "database is locked":
    // un autosave de tabs perdido, una tarea de la flota que no arranca. WAL deja leer
    // mientras otro escribe, y `busy_timeout` hace que una escritura espere su turno en vez
    // de fallar. Se pide desde la primera conexión: el modo WAL queda en el archivo.
    //
    // Pasar a WAL no espera: SQLite no lo permite con otra conexión abierta y contesta
    // "busy" en el acto. Se intenta y, si otra instancia la tiene abierta, se sigue igual —
    // la espera ya alcanza para no fallar, y WAL queda en el archivo para la próxima.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");

    // Todo el arranque de la base en una transacción que toma el lock de escritura de
    // entrada: si dos instancias arrancan a la vez (la que se reinicia tras actualizar con
    // otra abierta), la segunda espera a que la primera migre y después ve la versión nueva,
    // en vez de aplicar la misma migración dos veces y no arrancar ("duplicate column").
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let ready = super::schema::migrate(&conn)
        .and_then(|_| super::seeds::seed_defaults(&conn))
        .and_then(|_| super::queries::dedupe_session_history_once(&conn));
    match ready {
        Ok(()) => conn.execute_batch("COMMIT")?,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    // Las ventanas cerradas que no guardan tabs no representan nada y se acumulan: una por
    // cierre, y una por intento cuando un arranque falla en bucle.
    let purgadas = super::queries::purge_empty_closed_windows(&conn)?;
    if purgadas > 0 {
        eprintln!("se limpiaron {purgadas} filas de ventanas cerradas y vacías");
    }

    Ok(Arc::new(Mutex::new(conn)))
}
