//! La conexión al relay.
//!
//! Una sola tarea async por app: se conecta, se presenta con la clave del equipo, observa
//! la presencia de los teléfonos emparejados y atiende lo que piden. Si se corta, vuelve a
//! intentar con espera creciente (1 s → 30 s). Cambiar la configuración la reinicia.
//!
//! Lo que depende de la app (qué teléfonos hay, qué hacer con cada pedido) entra por el
//! trait [`Host`]: así la conexión se prueba contra un relay de verdad sin levantar Tauri.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use controlcode_relay::crypto::Keypair;
use controlcode_relay::protocol::{self, ClientFrame, Inner, ReplayGuard, Role, ServerFrame};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::database::DbConnection;

/// Lo que la conexión necesita de la app.
pub trait Host: Send + Sync + 'static {
    /// Los teléfonos emparejados (sus claves públicas).
    fn paired(&self) -> Vec<String>;
    /// Atiende un pedido de un teléfono. Corre en un hilo de bloqueo.
    fn handle(&self, from: &str, method: &str, params: Value) -> Result<Value, String>;
    fn presence_changed(&self, _id: &str, _online: bool) {}
    fn status_changed(&self, _status: &Status) {}
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `off` | `connecting` | `connected` | `error`
    pub state: &'static str,
    pub error: Option<String>,
    /// La identidad de este equipo (su clave pública), cuando ya se cargó.
    pub desktop_id: Option<String>,
}

impl Status {
    fn new(state: &'static str, error: Option<String>) -> Self {
        let desktop_id = keys().map(|k| k.id());
        Status { state, error, desktop_id }
    }
}

lazy_static::lazy_static! {
    static ref OUTBOX: Mutex<Option<mpsc::UnboundedSender<ClientFrame>>> = Mutex::new(None);
    static ref KEYS: Mutex<Option<Keypair>> = Mutex::new(None);
    static ref ONLINE: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    static ref STATUS: Mutex<Status> = Mutex::new(Status { state: "off", error: None, desktop_id: None });
    static ref TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
    /// Los permisos que ya se avisaron: una notificación por pedido nuevo, no por cada
    /// cambio de la cola.
    static ref NOTIFIED: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    /// Los mensajes ya vistos. Vive fuera de la sesión a propósito: si se reiniciara en cada
    /// reconexión, un relay malicioso podría cortar la conexión y reenviar enseguida un
    /// `tab.send` que ya se ejecutó (escribir dos veces un comando en una terminal).
    static ref GUARD: Mutex<ReplayGuard> = Mutex::new(ReplayGuard::default());
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn keys() -> Option<Keypair> {
    lock(&KEYS).clone()
}

pub fn status() -> Status {
    lock(&STATUS).clone()
}

pub fn online_ids() -> HashSet<String> {
    lock(&ONLINE).clone()
}

fn set_status(host: &dyn Host, state: &'static str, error: Option<String>) {
    let status = Status::new(state, error);
    *lock(&STATUS) = status.clone();
    host.status_changed(&status);
}

/// Manda un mensaje cifrado a un teléfono. Sin conexión, se pierde: el teléfono pide el
/// estado entero al reconectarse.
pub fn send_inner(to: &str, msg: &Inner) {
    let (Some(keys), Some(tx)) = (keys(), lock(&OUTBOX).clone()) else { return };
    let Ok(body) = msg.seal(to, &keys) else { return };
    if body.len() > protocol::MAX_FRAME_BYTES - 1024 {
        // Una respuesta que no entra en un frame no llegaría nunca: mejor un error que la
        // explique que un teléfono esperando.
        if let Inner::Res { id, .. } = msg {
            send_inner(to, &Inner::err(id, "la respuesta es demasiado grande para enviarla"));
        }
        return;
    }
    let _ = tx.send(ClientFrame::Send { to: to.into(), body });
}

pub fn send_event(to: &str, name: &str, data: Value) {
    send_inner(to, &Inner::evt(name, data));
}

/// Un evento a todos los teléfonos conectados.
pub fn broadcast(name: &str, data: Value) {
    for id in online_ids() {
        send_event(&id, name, data.clone());
    }
}

/// Vuelve a pedir la presencia de los emparejados (tras emparejar o desemparejar uno).
pub fn rewatch(ids: Vec<String>) {
    lock(&ONLINE).retain(|id| ids.contains(id));
    if let Some(tx) = lock(&OUTBOX).clone() {
        let _ = tx.send(ClientFrame::Watch { ids });
    }
}

// ── La sesión ────────────────────────────────────────────────────

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const PING_EVERY: Duration = Duration::from_secs(25);

async fn next_frame(ws: &mut Ws) -> Result<ServerFrame, String> {
    loop {
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, ws.next()).await {
            Err(_) => return Err("el relay no contestó".into()),
            Ok(None) => return Err("el relay cerró la conexión".into()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(Message::Text(t)))) => {
                return serde_json::from_str(t.as_str()).map_err(|e| format!("respuesta del relay ilegible: {e}"));
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
}

fn text(frame: &ClientFrame) -> Message {
    Message::Text(serde_json::to_string(frame).expect("frame serializable").into())
}

/// Una conexión, de principio a fin. `Ok(true)` si llegó a estar lista (para reiniciar la
/// espera entre intentos); el `Err` es por qué se cortó.
async fn session(url: &str, token: Option<String>, keys: &Keypair, host: &Arc<dyn Host>) -> Result<bool, (bool, String)> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| (false, format!("no se pudo conectar a {url}: {e}")))?;

    let ServerFrame::Challenge { relay, challenge } = next_frame(&mut ws).await.map_err(|e| (false, e))? else {
        return Err((false, "el relay no mandó el desafío".into()));
    };
    let hello = protocol::hello(keys, Role::Desktop, &relay, &challenge, token).map_err(|e| (false, e))?;
    ws.send(text(&hello)).await.map_err(|e| (false, e.to_string()))?;
    match next_frame(&mut ws).await.map_err(|e| (false, e))? {
        ServerFrame::Ready { .. } => {}
        ServerFrame::Error { code, message } if code == "token" => {
            return Err((false, format!("el relay rechazó el token: {message}")));
        }
        ServerFrame::Error { message, .. } => return Err((false, message)),
        other => return Err((false, format!("respuesta inesperada del relay: {other:?}"))),
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<ClientFrame>();
    *lock(&OUTBOX) = Some(tx.clone());
    set_status(host.as_ref(), "connected", None);
    let _ = tx.send(ClientFrame::Watch { ids: host.paired() });

    let (mut sink, mut stream) = ws.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut flush = tokio::time::interval(super::live::FLUSH_EVERY);

    let reason = loop {
        tokio::select! {
            frame = rx.recv() => {
                let Some(frame) = frame else { break "canal cerrado".to_string() };
                if let Err(e) = sink.send(text(&frame)).await { break e.to_string() }
            }
            _ = ping.tick() => {
                if let Err(e) = sink.send(Message::Ping(Vec::new().into())).await { break e.to_string() }
            }
            _ = flush.tick() => {
                super::live::flush();
                #[cfg(test)]
                if FORCE_DROP.swap(false, std::sync::atomic::Ordering::SeqCst) { break "cortada por el test".to_string() }
            }
            incoming = stream.next() => {
                let raw = match incoming {
                    None => break "el relay cerró la conexión".to_string(),
                    Some(Err(e)) => break e.to_string(),
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) => break "el relay cerró la conexión".to_string(),
                    Some(Ok(_)) => continue,
                };
                match serde_json::from_str::<ServerFrame>(raw.as_str()) {
                    Ok(ServerFrame::Msg { from, body }) => incoming_message(host, keys, from, &body),
                    Ok(ServerFrame::Presence { id, online }) => {
                        if online { lock(&ONLINE).insert(id.clone()); } else { lock(&ONLINE).remove(&id); }
                        if !online { super::live::unsubscribe(&id, None); }
                        host.presence_changed(&id, online);
                    }
                    Ok(ServerFrame::Undelivered { to }) => {
                        if lock(&ONLINE).remove(&to) {
                            super::live::unsubscribe(&to, None);
                            host.presence_changed(&to, false);
                        }
                    }
                    Ok(ServerFrame::Error { code, message }) => eprintln!("[remote] el relay avisa {code}: {message}"),
                    _ => {}
                }
            }
        }
    };
    Err((true, reason))
}

/// Un mensaje de un teléfono: se abre, se descarta si es viejo o repetido, y si es un
/// pedido se atiende en un hilo de bloqueo (varios handlers esperan a la ventana).
fn incoming_message(host: &Arc<dyn Host>, keys: &Keypair, from: String, body: &str) {
    let Ok(msg) = Inner::open(body, &from, keys) else { return };
    if lock(&GUARD).check(&msg, protocol::now_ms()).is_err() {
        return;
    }
    let Inner::Req { id, m, p, .. } = msg else { return };
    // De una clave que no está emparejada solo se atiende el pedido de emparejarse; el
    // resto se descarta sin contestar, para no confirmarle a nadie que este equipo existe.
    if m != "pair" && !host.paired().contains(&from) {
        return;
    }
    let host = host.clone();
    tokio::task::spawn_blocking(move || {
        let reply = match host.handle(&from, &m, p) {
            Ok(result) => Inner::ok(&id, result),
            Err(e) => Inner::err(&id, e),
        };
        send_inner(&from, &reply);
    });
}

/// Corta la sesión actual como lo haría el relay, para probar la reconexión.
#[cfg(test)]
pub fn drop_session_for_tests() {
    *lock(&OUTBOX) = None;
    FORCE_DROP.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(test)]
static FORCE_DROP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Se conecta y reconecta hasta que la tarea se aborte.
pub async fn run_forever(url: String, token: Option<String>, keys: Keypair, host: Arc<dyn Host>) {
    *lock(&KEYS) = Some(keys.clone());
    let mut wait = Duration::from_secs(1);
    loop {
        set_status(host.as_ref(), "connecting", None);
        let (was_ready, reason) = match session(&url, token.clone(), &keys, &host).await {
            Ok(_) => (true, "desconectado".to_string()),
            Err(e) => e,
        };
        *lock(&OUTBOX) = None;
        let dropped: Vec<String> = lock(&ONLINE).drain().collect();
        super::live::clear();
        for id in dropped {
            host.presence_changed(&id, false);
        }
        if was_ready {
            wait = Duration::from_secs(1);
        }
        set_status(host.as_ref(), "error", Some(reason));
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(30));
    }
}

// ── La app ───────────────────────────────────────────────────────

/// El `Host` de verdad: la app.
pub struct AppHost {
    pub app: AppHandle,
}

impl AppHost {
    fn db(&self) -> Option<tauri::State<'_, DbConnection>> {
        self.app.try_state::<DbConnection>()
    }
}

impl Host for AppHost {
    fn paired(&self) -> Vec<String> {
        let Some(db) = self.db() else { return Vec::new() };
        let Ok(conn) = db.lock() else { return Vec::new() };
        super::devices::list(&conn).unwrap_or_default().into_iter().map(|d| d.id).collect()
    }

    fn handle(&self, from: &str, method: &str, params: Value) -> Result<Value, String> {
        super::handlers::handle(&self.app, from, method, &params)
    }

    fn presence_changed(&self, id: &str, online: bool) {
        if online && let Some(db) = self.db() && let Ok(conn) = db.lock() {
            let _ = super::devices::touch(&conn, id);
        }
        let _ = self.app.emit("remote-devices", json!({}));
    }

    fn status_changed(&self, status: &Status) {
        let _ = self.app.emit("remote-status", status);
    }
}

/// (Re)arranca la conexión con la configuración guardada. Apagado, solo corta.
pub fn start(app: &AppHandle) {
    if let Some(task) = lock(&TASK).take() {
        task.abort();
    }
    *lock(&OUTBOX) = None;
    lock(&ONLINE).clear();
    super::live::clear();

    let app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let host: Arc<dyn Host> = Arc::new(AppHost { app: app.clone() });
        let Some(db) = app.try_state::<DbConnection>() else { return };
        let config = super::config::load(&db);
        if !config.enabled {
            set_status(host.as_ref(), "off", None);
            return;
        }
        let url = match super::config::ws_url(&config.relay_url) {
            Ok(url) => url,
            Err(e) => return set_status(host.as_ref(), "error", Some(e)),
        };
        let Ok(data_dir) = app.path().app_data_dir() else { return };
        let keys = match tokio::task::spawn_blocking(move || super::config::load_or_create_keys(&data_dir)).await {
            Ok(Ok(keys)) => keys,
            Ok(Err(e)) => return set_status(host.as_ref(), "error", Some(e)),
            Err(e) => return set_status(host.as_ref(), "error", Some(e.to_string())),
        };
        run_forever(url, config.token, keys, host).await;
    });
    *lock(&TASK) = Some(task);
}

/// La cola de permisos cambió: se la manda a los teléfonos conectados, y a los que no
/// están, una notificación por cada pedido nuevo.
pub fn on_approvals_changed(app: &AppHandle, pending: &[crate::runs::PendingApproval]) {
    broadcast("approvals", json!({ "list": pending }));
    let fresh = {
        let mut seen = lock(&NOTIFIED);
        let ids: HashSet<String> = pending.iter().map(|p| p.id.clone()).collect();
        seen.retain(|id| ids.contains(id));
        let fresh = ids.iter().any(|id| !seen.contains(id));
        seen.extend(ids);
        fresh
    };
    if fresh {
        super::push::notify_offline(app, "Un agente espera tu permiso", "Abrí Control Code para permitirlo o denegarlo.");
    }
}
