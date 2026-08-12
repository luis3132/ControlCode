//! Consultas del historial de sesiones: las tabs cerradas que la vista "Sesiones" muestra.
//!
//! El archivado (`archive_tab_row`) es el punto por el que pasan TODOS los cierres —
//! cerrar la tab, cerrar la ventana, salir de la app— así que lo que se resuelva acá vale
//! para todos.

use rusqlite::{Connection, OptionalExtension, Result as SqlResult};
use uuid::Uuid;

use crate::util::now_ts;
use crate::database::models::{
    ArchivedSkill, OpenTabLocation, SessionHistoryEntry, SiblingTab,
};
use crate::database::DbConnection;

/// Archiva el estado actual de una tab en `session_history` justo ANTES de que su fila
/// desaparezca de `tabs` (autosave que ya no la incluye, o borrado de su ventana). Si
/// `session_id` no es nulo y ya existe una entrada con ese mismo id (la misma
/// conversación real del agente, cerrada/reabierta varias veces), actualiza esa fila en
/// vez de duplicarla — el historial muestra "sesiones", no un log de cada cierre.
/// Margen hacia atrás al re-descubrir la sesión: los mtime tienen resolución de 1s y el
/// reloj del archivado no es el mismo instante que el de `pty_create` (mismo motivo que
/// `SESSION_DISCOVERY_LOOKBACK_S` en el frontend).
const REDISCOVERY_LOOKBACK_S: i64 = 3;

/// Lo caro del archivado, ya resuelto: contra qué sesión real corría la tab y con qué
/// título quedó.
///
/// Existe porque resolverlo implica leer el disco y, para algunas TUIs, **lanzar un
/// proceso** (`opencode session list`). Hacerlo dentro de `archive_tab_row` —que corre con
/// el mutex de SQLite tomado— dejaba la base entera bloqueada ~1s por tab cerrada, y para
/// siempre si ese proceso se colgaba: toda la app pasa por esa única conexión. Ahora se
/// resuelve ANTES de pedir el lock (ver [`resolve_for_archive`]) y el archivado solo
/// escribe.
#[derive(Default, Debug, Clone)]
pub struct ResolvedSession {
    /// `None` = no se resolvió nada mejor; se conserva lo que ya tenía la tab.
    pub session_id: Option<String>,
    pub title: Option<String>,
}

/// Datos de la tab necesarios para resolver su sesión, leídos de una sola vez.
struct ArchiveInput {
    agent_id: String,
    cwd: String,
    session_id: Option<String>,
    title: Option<String>,
    title_is_custom: bool,
    opened_at: i64,
    profile: Option<String>,
    custom: Option<crate::agents::CustomAgent>,
}

fn read_archive_input(conn: &Connection, tab_id: &str) -> Option<ArchiveInput> {
    let (agent_id, cwd, session_id, title, title_is_custom, opened_at, account_id): (
        String,
        String,
        Option<String>,
        Option<String>,
        bool,
        i64,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT agent_id, cwd, session_id, title, title_is_custom, opened_at, account_id
             FROM tabs WHERE id = ?1",
            [tab_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get::<_, i64>(4)? != 0,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()?;

    let profile = account_id.as_deref().and_then(|id| crate::accounts::dir_for_conn(conn, id));
    let custom = crate::agents::find(conn, &agent_id);
    Some(ArchiveInput {
        agent_id,
        cwd,
        session_id,
        title,
        title_is_custom,
        opened_at,
        profile,
        custom,
    })
}

/// Qué sesión estuvo usando REALMENTE esta tab y con qué título archivarla, mirando el
/// disco en el momento de cerrarla.
///
/// **Toma el lock de la base solo para leer, en tramos cortos, y lo suelta antes de tocar
/// el disco.** Llamarla con el lock ya tomado es un deadlock; ese es todo el punto de que
/// exista separada de `archive_tab_row`.
///
/// El id que trae la tab es el que se descubrió al ARRANCAR. Si el usuario retomó otra
/// conversación desde adentro de la TUI (`/resume` de Claude y equivalentes), la tab
/// estuvo trabajando sobre una sesión distinta, y archivar con el id viejo crea una
/// entrada nueva en vez de actualizar la conversación que de verdad se continuó.
pub fn resolve_for_archive(db: &DbConnection, tab_id: &str) -> ResolvedSession {
    let input = {
        let Ok(conn) = db.lock() else { return ResolvedSession::default() };
        read_archive_input(&conn, tab_id)
    };
    let Some(input) = input else { return ResolvedSession::default() };
    let profile = input.profile.as_deref().map(std::path::Path::new);

    // Sin el lock: acá se lee disco y, para algunas TUIs, se lanza un proceso.
    let found = crate::session::discover_session_id_sync(
        &input.agent_id,
        &input.cwd,
        input.opened_at - REDISCOVERY_LOOKBACK_S,
        profile,
        input.custom.as_ref(),
    );

    // Traza deliberada: este camino solo se puede observar con una TUI real retomando una
    // conversación real, algo que no se puede reproducir en un test. Sale por stderr, así
    // que en `tauri dev` aparece en la terminal desde donde se levantó la app.
    let current = input.session_id.clone();
    eprintln!(
        "[sesión] al cerrar {tab_id}: agente={} guardada={current:?} encontrada={found:?}",
        input.agent_id
    );

    let session_id = match found {
        // No encontrar nada significa "no sé", no "no tenía sesión": se conserva el previo.
        None => current,
        Some(found) if Some(&found) == current.as_ref() => current,
        Some(found) => {
            // Con dos tabs del mismo agente en la misma carpeta, "el archivo más nuevo"
            // puede ser el de la OTRA tab. Robarle su sesión sería peor que no reconciliar:
            // quedarían dos entradas del historial apuntando a la misma conversación.
            let taken = db
                .lock()
                .ok()
                .and_then(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM tabs WHERE id != ?1 AND session_id = ?2",
                        rusqlite::params![tab_id, found],
                        |r| r.get::<_, i64>(0),
                    )
                    .ok()
                })
                .unwrap_or(0);
            if taken > 0 {
                eprintln!("[sesión] {found} ya es de otra tab abierta — se conserva {current:?}");
                current
            } else {
                eprintln!("[sesión] la tab había cambiado de conversación: {current:?} → {found}");
                Some(found)
            }
        }
    };

    // El título se resuelve contra la sesión real y no se confía en el que traía la tab.
    // Dos motivos, los dos verificados sobre un historial de verdad:
    //
    // - Si la sesión resultó ser otra, el título de la tab es el de la conversación
    //   equivocada — y como el archivado ACTUALIZA la entrada existente, escribirlo le
    //   pisaría el título bueno a la conversación que se retomó.
    // - El refresco de título del frontend solo corre al cerrar la tab a mano; una tab que
    //   se va con la ventana o con la app se archivaba con el título de relleno
    //   ("Claude Code — carpeta"). En una base real eso era el 100% de las entradas.
    //
    // Un título puesto a mano por el usuario manda siempre y no se toca.
    let title = if input.title_is_custom {
        input.title
    } else {
        Some(
            crate::session::get_session_title_sync(
                &input.agent_id,
                &input.cwd,
                session_id.clone(),
                input.title.clone().unwrap_or_default(),
                profile,
                input.custom.as_ref(),
            )
            .title,
        )
        .filter(|t| !t.is_empty())
        .or(input.title)
    };

    ResolvedSession { session_id, title }
}

/// Escribe la tab en el historial. `resolved` viene de [`resolve_for_archive`], que hay
/// que llamar ANTES de tomar el lock que esta función necesita.
pub(crate) fn archive_tab_row(
    conn: &Connection,
    tab_id: &str,
    workspace_id: &str,
    resolved: &ResolvedSession,
) -> Result<(), String> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, String, i64)> = conn
        .query_row(
            "SELECT agent_id, agent_label, command, cwd, title, session_id, history_id, account_id, prelaunch, opened_at FROM tabs WHERE id = ?1",
            [tab_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((
        agent_id,
        agent_label,
        command,
        cwd,
        title,
        session_id,
        history_id,
        account_id,
        prelaunch,
        opened_at,
    )) = row
    else { return Ok(()) };

    // Lo resuelto fuera del lock manda; si no se resolvió nada, queda lo que traía la tab.
    let session_id = resolved.session_id.clone().or(session_id);
    let title = resolved.title.clone().or(title);

    // Skills activas para esta tab al momento de archivar: por-tab (scope='tab') o
    // por-workspace (scope='workspace'). Se "congelan" acá porque `project_skills.tab_id`
    // cascadea con `tabs` y desaparecería en el mismo borrado que dispara este archivo.
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT s.id, s.name, ps.scope FROM project_skills ps
             JOIN skills s ON s.id = ps.skill_id
             WHERE ps.enabled = 1 AND (
               (ps.scope = 'tab' AND ps.tab_id = ?1) OR
               (ps.scope = 'workspace' AND ps.workspace_id = ?2)
             )",
        )
        .map_err(|e| e.to_string())?;
    let archived: Vec<ArchivedSkill> = stmt
        .query_map(rusqlite::params![tab_id, workspace_id], |r| {
            Ok(ArchivedSkill { id: r.get(0)?, name: r.get(1)?, scope: r.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let skills_json = serde_json::to_string(&archived).unwrap_or_else(|_| "[]".to_string());

    // Con qué otras tabs del workspace convivía esta al cerrarse — el "junto a qué estaba
    // trabajando" que pide la vista de historial. Es una foto del momento del archivado:
    // si se cierran varias tabs a la vez, cada una registra las que todavía no se
    // archivaron, así que la última en cerrarse ve menos hermanas que la primera.
    let siblings: Vec<SiblingTab> = {
        let mut stmt = conn
            .prepare(
                "SELECT t.title, t.agent_label, t.cwd FROM tabs t
                 JOIN windows w ON w.id = t.window_id
                 WHERE w.workspace_id = ?1 AND t.id != ?2
                 ORDER BY t.tab_order ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_id, tab_id], |r| {
                Ok(SiblingTab { title: r.get(0)?, agent_label: r.get(1)?, cwd: r.get(2)? })
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let siblings_json = serde_json::to_string(&siblings).unwrap_or_else(|_| "[]".to_string());

    let now = now_ts();

    // A qué entrada del historial corresponde esta tab, en orden de confianza:
    //
    // 1. `history_id` — la tab se abrió DESDE el historial, así que sabemos exactamente
    //    cuál actualizar. Es el único camino que funciona para sesiones que nunca
    //    resolvieron un `session_id` (bash, o un agente cuyo id no se llegó a descubrir):
    //    sin esto, cada ciclo de abrir/cerrar insertaba una fila nueva.
    // 2. `session_id` — misma conversación real del agente, aunque la tab sea otra.
    // 3. Sin ninguno de los dos, y sin id de sesión que la distinga, una tab del mismo
    //    agente en la misma carpeta es indistinguible de la anterior: se actualiza esa
    //    entrada en vez de acumular copias.
    let existing_id: Option<String> = if let Some(hid) = &history_id {
        conn.query_row("SELECT id FROM session_history WHERE id = ?1", [hid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
    } else if let Some(sid) = &session_id {
        conn.query_row("SELECT id FROM session_history WHERE session_id = ?1", [sid], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
    } else {
        conn.query_row(
            "SELECT id FROM session_history
             WHERE workspace_id = ?1 AND agent_id = ?2 AND cwd = ?3 AND session_id IS NULL
             ORDER BY closed_at DESC LIMIT 1",
            rusqlite::params![workspace_id, agent_id, cwd],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };

    if let Some(hid) = existing_id {
        // opened_at NO se toca: representa cuándo se abrió esa conversación por
        // primera vez, no la última vez que se retomó/cerró.
        //
        // `session_id` sí se escribe: una sesión que se archivó sin id y lo resolvió al
        // reabrirse tiene que quedar identificada de acá en adelante.
        conn.execute(
            "UPDATE session_history SET agent_id=?1, agent_label=?2, command=?3, cwd=?4, title=?5, session_id=COALESCE(?6, session_id), skills=?7, sibling_tabs=?8, account_id=?9, prelaunch=?10, closed_at=?11 WHERE id=?12",
            rusqlite::params![agent_id, agent_label, command, cwd, title, session_id, skills_json, siblings_json, account_id, prelaunch, now, hid],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    conn.execute(
        "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            workspace_id,
            agent_id,
            agent_label,
            command,
            cwd,
            title,
            session_id,
            skills_json,
            siblings_json,
            account_id,
            prelaunch,
            opened_at,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Colapsa las entradas duplicadas que dejó la versión anterior: cada vez que se reabría
/// y volvía a cerrar una sesión SIN `session_id` resuelto se insertaba una fila nueva en
/// vez de actualizar la existente, así que el historial mostraba N copias de la misma
/// conversación.
///
/// Dos filas son la misma sesión si comparten workspace + agente + carpeta + `session_id`
/// (tratando NULL como "sin id"). De cada grupo sobrevive la cerrada más recientemente —
/// la que tiene el título y las skills más actuales — pero heredando el `opened_at` más
/// viejo del grupo, que es cuándo empezó realmente la conversación.
pub(crate) fn dedupe_session_history(conn: &Connection) -> SqlResult<()> {
    // El opened_at se normaliza ANTES de borrar: después ya no habría de dónde sacarlo.
    conn.execute(
        "UPDATE session_history SET
           opened_at = (SELECT MIN(h2.opened_at) FROM session_history h2
                        WHERE h2.workspace_id = session_history.workspace_id
                          AND h2.agent_id = session_history.agent_id
                          AND h2.cwd = session_history.cwd
                          AND COALESCE(h2.session_id, '') = COALESCE(session_history.session_id, ''))",
        [],
    )?;

    // `rowid` desempata para que el resultado sea determinista si dos filas del mismo
    // grupo comparten `closed_at`.
    conn.execute(
        "DELETE FROM session_history WHERE rowid NOT IN (
           SELECT (
             SELECT h2.rowid FROM session_history h2
             WHERE h2.workspace_id = h.workspace_id
               AND h2.agent_id = h.agent_id
               AND h2.cwd = h.cwd
               AND COALESCE(h2.session_id, '') = COALESCE(h.session_id, '')
             ORDER BY h2.closed_at DESC, h2.rowid DESC
             LIMIT 1
           )
           FROM session_history h
         )",
        [],
    )?;
    Ok(())
}

/// Skills archivadas de una entrada del historial, sobre una conexión ya lockeada.
pub fn archived_skills_of_session(
    conn: &Connection,
    history_id: &str,
) -> Result<Vec<ArchivedSkill>, String> {
    let json: Option<String> = conn
        .query_row("SELECT skills FROM session_history WHERE id = ?1", [history_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(json.as_deref().map(parse_archived_skills).unwrap_or_default())
}

/// Lee la columna `skills` de `session_history` tolerando el formato viejo, que era un
/// array plano de nombres (`["git-helper"]`) sin id ni scope. Esas entradas se leen como
/// skills sin id: se pueden mostrar y buscar por nombre, pero no reattachear directo.
fn parse_archived_skills(json: &str) -> Vec<ArchivedSkill> {
    if let Ok(v) = serde_json::from_str::<Vec<ArchivedSkill>>(json) {
        return v;
    }
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|name| ArchivedSkill { id: String::new(), name, scope: "tab".to_string() })
        .collect()
}

/// Historial de tabs cerradas de un workspace, más reciente primero. Filtrado
/// estrictamente por `workspace_id` — dos workspaces nunca comparten entradas.
#[tauri::command]
pub fn db_list_session_history(
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at
             FROM session_history WHERE workspace_id = ?1 ORDER BY closed_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map([&workspace_id], |row| {
            let skills_json: String = row.get(8)?;
            let skills = parse_archived_skills(&skills_json);
            let siblings_json: String = row.get(9)?;
            let sibling_tabs: Vec<SiblingTab> =
                serde_json::from_str(&siblings_json).unwrap_or_default();
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                agent_id: row.get(2)?,
                agent_label: row.get(3)?,
                command: row.get(4)?,
                cwd: row.get(5)?,
                title: row.get(6)?,
                session_id: row.get(7)?,
                skills,
                sibling_tabs,
                account_id: row.get(10)?,
                prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(11)?),
                opened_at: row.get(12)?,
                closed_at: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}


/// Borra una entrada del historial. No toca el archivo de sesión del agente en disco
/// (vive fuera de la app, en `~/.claude/projects` y equivalentes): esto solo saca la
/// sesión de la vista de Sesiones.
#[tauri::command]
pub fn db_delete_session_history(
    history_id: String,
    db: tauri::State<DbConnection>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM session_history WHERE id = ?1", [&history_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Una entrada puntual del historial, sobre una conexión ya lockeada — la usa el
/// exportador a markdown, que necesita toda la metadata de la sesión.
pub fn session_history_entry(
    conn: &Connection,
    history_id: &str,
) -> Result<Option<SessionHistoryEntry>, String> {
    conn.query_row(
        "SELECT id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, sibling_tabs, account_id, prelaunch, opened_at, closed_at
         FROM session_history WHERE id = ?1",
        [history_id],
        |row| {
            let skills_json: String = row.get(8)?;
            let siblings_json: String = row.get(9)?;
            Ok(SessionHistoryEntry {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                agent_id: row.get(2)?,
                agent_label: row.get(3)?,
                command: row.get(4)?,
                cwd: row.get(5)?,
                title: row.get(6)?,
                session_id: row.get(7)?,
                skills: parse_archived_skills(&skills_json),
                sibling_tabs: serde_json::from_str(&siblings_json).unwrap_or_default(),
                account_id: row.get(10)?,
                prelaunch: crate::prelaunch::steps_from_json(&row.get::<_, String>(11)?),
                opened_at: row.get(12)?,
                closed_at: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Nombre del workspace al que pertenece una sesión — para el encabezado del export.
pub fn workspace_name(conn: &Connection, workspace_id: &str) -> Option<String> {
    conn.query_row("SELECT name FROM workspaces WHERE id = ?1", [workspace_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Busca si esta conversación ya está abierta en alguna tab viva (ventana `is_open = 1`)
/// de ESE workspace — usado por "Reabrir" en Sesiones: si ya está abierta en algún lado,
/// hay que enfocar esa tab en vez de abrir un duplicado.
///
/// Se busca por DOS caminos, y hacen falta los dos:
///
/// - `session_id` es el identificador real de la conversación, pero **puede ser NULL**: hay
///   sesiones que nunca llegan a resolverlo (la TUI no escribió su transcript todavía, o no
///   expone uno). Con solo este criterio, esas sesiones se duplicaban en cada reapertura.
/// - `history_id` es la entrada del historial de la que salió la tab. Una tab reabierta
///   desde Sesiones lo lleva puesto, así que identifica el caso que importa acá incluso sin
///   id de sesión.
#[tauri::command]
pub fn find_open_tab_for_session(
    session_id: Option<String>,
    history_id: Option<String>,
    workspace_id: String,
    db: tauri::State<DbConnection>,
) -> Result<Option<OpenTabLocation>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    open_tab_for_session(&conn, session_id.as_deref(), history_id.as_deref(), &workspace_id)
        .map_err(|e| e.to_string())
}

/// La búsqueda en sí, separada del comando para poder probarla.
pub(crate) fn open_tab_for_session(
    conn: &Connection,
    session_id: Option<&str>,
    history_id: Option<&str>,
    workspace_id: &str,
) -> rusqlite::Result<Option<OpenTabLocation>> {
    if session_id.is_none() && history_id.is_none() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT w.label, t.id FROM tabs t
         JOIN windows w ON w.id = t.window_id
         WHERE w.workspace_id = ?3 AND w.is_open = 1
           AND ((?1 IS NOT NULL AND t.session_id = ?1)
             OR (?2 IS NOT NULL AND t.history_id = ?2))
         LIMIT 1",
        rusqlite::params![session_id, history_id, workspace_id],
        |row| Ok(OpenTabLocation { window_label: row.get(0)?, tab_id: row.get(1)? }),
    )
    .optional()
}
