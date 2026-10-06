//! Lo que un teléfono emparejado puede pedir. Ver la tabla de métodos en
//! `docs/remote-protocol.md`.
//!
//! Casi todo va por el mismo camino que la CLI (`ipc::dispatch`): el teléfono es otra
//! forma de manejar la app desde afuera, y así nunca toma un camino distinto del de
//! `ccode`. Corre en un hilo de bloqueo: varias cosas esperan a la ventana.

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use super::{asks, devices, live, pairing};
use crate::database::DbConnection;

/// Cuánto scrollback se manda al engancharse a una tab. Es lo que llena la pantalla del
/// teléfono al abrirla; lo más viejo no hace falta, y tiene que entrar en un frame.
pub const ATTACH_SCROLLBACK: usize = 96 * 1024;

fn db(app: &AppHandle) -> Result<tauri::State<'_, DbConnection>, String> {
    app.try_state::<DbConnection>().ok_or_else(|| "la base no está lista".to_string())
}

fn str_arg<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("falta `{key}`"))
}

fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    let response = crate::ipc::dispatch(app, command, &args);
    if response.ok { Ok(response.data.unwrap_or(Value::Null)) } else { Err(response.error.unwrap_or_default()) }
}

/// El final de un texto, sin cortar un carácter.
pub fn tail(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Las tabs abiertas, como las ve el teléfono.
fn tabs(app: &AppHandle) -> Result<Value, String> {
    let list = dispatch(app, "tab.list", json!({}))?;
    let tabs: Vec<Value> = list
        .get("tabs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|t| {
            json!({
                "id": t["id"],
                "title": t["title"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| t["agentLabel"].as_str().unwrap_or("")),
                "agentId": t["agentId"],
                "agentLabel": t["agentLabel"],
                "cwd": t["cwd"],
            })
        })
        .collect();
    Ok(json!(tabs))
}

/// Carpetas donde lanzar un agente: las de las tabs abiertas y las de las sesiones
/// recientes, sin repetir.
fn folders(app: &AppHandle) -> Result<Vec<String>, String> {
    let db = db(app)?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT cwd FROM (
                 SELECT cwd, last_active AS at FROM tabs
                 UNION ALL
                 SELECT cwd, closed_at AS at FROM session_history
             ) GROUP BY cwd ORDER BY MAX(at) DESC LIMIT 30",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).filter(|c| !c.is_empty()).collect())
}

/// Guarda el teléfono que se acaba de emparejar. Devuelve el nombre de este equipo (para
/// mostrarlo en el teléfono) y las claves de todos los emparejados (para vigilar su
/// presencia).
///
/// El nombre se lee después de soltar la base: `config::load` la vuelve a bloquear, y
/// leerlo con el lock tomado colgaba el hilo para siempre (el teléfono veía "no contestó a
/// tiempo" y la base quedaba trabada para toda la app).
pub(super) fn register_device(db: &DbConnection, from: &str, p: &Value) -> Result<(String, Vec<String>), String> {
    let ids: Vec<String> = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        devices::upsert(
            &conn,
            from,
            p.get("name").and_then(Value::as_str).unwrap_or("Teléfono"),
            p.get("platform").and_then(Value::as_str),
            p.get("pushToken").and_then(Value::as_str),
        )?;
        devices::list(&conn)?.into_iter().map(|d| d.id).collect()
    };
    Ok((super::config::load(db).name, ids))
}

pub fn handle(app: &AppHandle, from: &str, method: &str, p: &Value) -> Result<Value, String> {
    match method {
        "pair" => {
            if !pairing::consume(str_arg(p, "secret")?) {
                return Err("El código venció o ya se usó. Generá uno nuevo en Control Code.".into());
            }
            let (name, ids) = register_device(db(app)?.inner(), from, p)?;
            super::client::rewatch(ids);
            let _ = app.emit("remote-devices", json!({}));
            let _ = app.emit("remote-paired", json!({ "id": from }));
            Ok(json!({ "name": name }))
        }
        "state" => {
            let name = super::config::load(db(app)?.inner()).name;
            Ok(json!({
                "name": name,
                "version": env!("CARGO_PKG_VERSION"),
                "tabs": tabs(app)?,
                "approvals": crate::runs::run_pending_approvals(),
                "asks": asks::list(),
            }))
        }
        "tab.attach" => {
            let tab_id = str_arg(p, "tabId")?;
            let pty = crate::ipc::pty_id_for_tab(app, tab_id, None)?;
            let scrollback = crate::terminal::scrollback_of(pty).map(|(s, _)| s).unwrap_or_default();
            let (cols, rows) = crate::terminal::size_of(pty).unwrap_or((80, 24));
            live::subscribe(pty, from, tab_id);
            Ok(json!({
                "scrollback": tail(&scrollback, ATTACH_SCROLLBACK),
                "running": true,
                "cols": cols,
                "rows": rows,
            }))
        }
        "tab.detach" => {
            live::unsubscribe(from, Some(str_arg(p, "tabId")?));
            Ok(json!({}))
        }
        "tab.send" => {
            let enter = p.get("enter").and_then(Value::as_bool).unwrap_or(true);
            dispatch(
                app,
                "tab.send",
                json!({ "tab": str_arg(p, "tabId")?, "text": str_arg(p, "text")?, "noEnter": !enter }),
            )?;
            Ok(json!({}))
        }
        "tab.keys" => {
            let pty = crate::ipc::pty_id_for_tab(app, str_arg(p, "tabId")?, None)?;
            crate::terminal::write_to_pty(pty, str_arg(p, "data")?)?;
            Ok(json!({}))
        }
        "tab.create" => {
            let mut args = json!({ "cwd": str_arg(p, "cwd")?, "agent": str_arg(p, "agent")? });
            if let Some(prompt) = p.get("prompt").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                args["initPrompt"] = json!(prompt);
            }
            let created = dispatch(app, "tab.create", args)?;
            Ok(json!({ "tabId": created.get("tabId") }))
        }
        "launch.options" => {
            let agents = dispatch(app, "agent.list", json!({}))?;
            let agents: Vec<Value> = agents
                .get("agents")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|a| a["available"].as_bool().unwrap_or(false))
                .map(|a| json!({ "id": a["id"], "label": a["label"] }))
                .collect();
            Ok(json!({ "agents": agents, "folders": folders(app)? }))
        }
        "approval.decide" => {
            let allow = p.get("allow").and_then(Value::as_bool).ok_or("falta `allow`")?;
            let remember = p.get("remember").and_then(Value::as_bool).unwrap_or(false);
            let db = db(app)?;
            let decided = crate::runs::decide_approval(app, &db, str_arg(p, "id")?, allow, remember)?;
            Ok(json!({ "decided": decided }))
        }
        "ask.answer" => {
            let answer = p.get("answer").and_then(Value::as_str).ok_or("falta `answer`")?;
            Ok(json!({ "answered": asks::answer(app, str_arg(p, "id")?, answer) }))
        }
        "push.register" => {
            let token = p.get("token").and_then(Value::as_str).filter(|t| !t.is_empty());
            let db = db(app)?;
            let conn = db.lock().map_err(|e| e.to_string())?;
            devices::set_push_token(&conn, from, token)?;
            Ok(json!({}))
        }
        "unpair" => {
            let db = db(app)?;
            let ids = {
                let conn = db.lock().map_err(|e| e.to_string())?;
                devices::remove(&conn, from)?;
                devices::list(&conn)?.into_iter().map(|d| d.id).collect()
            };
            live::unsubscribe(from, None);
            super::client::rewatch(ids);
            let _ = app.emit("remote-devices", json!({}));
            Ok(json!({}))
        }
        other => Err(format!("método desconocido: {other}")),
    }
}
