//! Filas que la app siembra sola la primera vez, para que nada arranque vacío.
//!
//! Todo lo de acá es idempotente y NUNCA pisa una decisión del usuario: si borró un
//! repositorio o eligió otra carpeta de skills, el próximo arranque lo respeta.

use rusqlite::{Connection, Result as SqlResult};
use uuid::Uuid;

use crate::util::now_ts;
use super::models::DEFAULT_WORKSPACE_ID;

/// Corre todas las siembras. La llama `connection::init_db` justo después de migrar.
pub(super) fn seed_defaults(conn: &Connection) -> SqlResult<()> {
    ensure_default_workspace(conn)?;
    ensure_default_settings(conn)?;
    ensure_default_registries(conn)?;
    ensure_skillssh_registry(conn)?;
    Ok(())
}

/// Toda ventana debe pertenecer a un workspace. Si la app arranca sin ningún
/// workspace guardado todavía, se crea uno por defecto ("Sin guardar") al que
/// pertenecen las ventanas hasta que el usuario las guarde con un nombre propio.
fn ensure_default_workspace(conn: &Connection) -> SqlResult<()> {
    let has_any: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    if has_any == 0 {
        let now = now_ts();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![DEFAULT_WORKSPACE_ID, "Sin guardar", now],
        )?;
    }
    Ok(())
}

/// Siembra el registry público de ejemplo listado en plan.md (Fase 6) la primera vez que
/// arranca la app, para que el marketplace no se vea vacío antes de que el usuario agregue
/// el suyo. Sin `cache_json` todavía — se resuelve recién cuando el usuario visita la
/// página de Marketplace y dispara el primer refresh (evita pegarle a la red en cada
/// arranque). Solo se siembra si la tabla está vacía, nunca pisa registries que el usuario
/// ya haya agregado o borrado a propósito.
fn ensure_default_registries(conn: &Connection) -> SqlResult<()> {
    let has_any: i64 = conn.query_row("SELECT COUNT(*) FROM registries", [], |r| r.get(0))?;
    if has_any == 0 {
        let now = now_ts();
        // `priority` define el orden en que se agregan las skills en el marketplace:
        // autoskills va primero por ser el repo oficial de la app.
        for &(priority, name, location) in DEFAULT_REGISTRIES {
            conn.execute(
                "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
                 VALUES (?1, ?2, 'github', ?3, ?4, 1, ?5)",
                rusqlite::params![Uuid::new_v4().to_string(), name, location, priority, now],
            )?;
        }
    }
    Ok(())
}

/// Agrega el directorio de skills.sh como fuente, una única vez.
///
/// No va en `DEFAULT_REGISTRIES` porque esa siembra solo corre con la tabla vacía, y quien
/// ya venía usando la app se quedaría sin la fuente nueva para siempre. Acá el candado es
/// un flag propio en `settings`: se agrega una vez y nunca más, así borrarlo es una
/// decisión que se respeta en vez de deshacerse en el próximo arranque.
pub(crate) fn ensure_skillssh_registry(conn: &Connection) -> SqlResult<()> {
    const FLAG: &str = "skillssh_registry_seeded";
    let ya: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = ?1",
        [FLAG],
        |r| r.get(0),
    )?;
    if ya > 0 {
        return Ok(());
    }

    // `location` vacío = todo el directorio, sin filtrar por publicador.
    // Queda último en prioridad: es el único que no aporta nada hasta que se busque algo,
    // así que arriba estorbaría a los repos que sí listan solos.
    let next: i32 = conn.query_row("SELECT COALESCE(MAX(priority), -1) + 1 FROM registries", [], |r| {
        r.get(0)
    })?;
    conn.execute(
        "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
         VALUES (?1, 'skills.sh', 'skillssh', '', ?2, 1, ?3)",
        rusqlite::params![Uuid::new_v4().to_string(), next, now_ts()],
    )?;
    conn.execute("INSERT INTO settings (key, value) VALUES (?1, '1')", [FLAG])?;
    Ok(())
}

/// Repos preconfigurados al primer arranque (`priority`, nombre visible, `owner/repo`).
/// Solo se siembran si la tabla está vacía — quitarlos después es decisión del usuario y
/// no se vuelven a insertar.
const DEFAULT_REGISTRIES: &[(i32, &str, &str)] = &[
    (0, "autoskills (midudev)", "midudev/autoskills"),
    (1, "anthropics/skills", "anthropics/skills"),
];

/// Siembra los valores por defecto de `settings` que el backend necesita leer de forma
/// autónoma (sin que el frontend se los pase en cada llamada), como el directorio global
/// de skills. Solo inserta si la key todavía no existe — no pisa un valor ya elegido.
fn ensure_default_settings(conn: &Connection) -> SqlResult<()> {
    let has_skills_dir: i64 = conn.query_row(
        "SELECT COUNT(*) FROM settings WHERE key = 'skills_dir'",
        [],
        |r| r.get(0),
    )?;
    if has_skills_dir == 0 {
        let home = dirs::home_dir().expect("Cannot determine home directory");
        let default_dir = home.join(".controlcode").join("skills");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
            [default_dir.to_string_lossy().to_string()],
        )?;
    }
    Ok(())
}
