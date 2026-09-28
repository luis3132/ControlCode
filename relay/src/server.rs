//! El servidor: autentica cada conexión por su clave y reenvía mensajes entre ellas.
//!
//! No guarda nada en disco ni encola: lo que llega para alguien que no está conectado se
//! descarta con un `undelivered`. Y no puede leer lo que reenvía (va cifrado de punta a
//! punta), así que un relay comprometido puede, a lo sumo, dejar de reenviar.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::crypto::{self, Keypair, b64, public_key, unb64};
use crate::protocol::{ClientFrame, MAX_FRAME_BYTES, ServerFrame};

/// Cuánto se espera el `hello` después del `challenge`.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(30);
/// Tope de mensajes por ventana, por conexión.
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_MAX: u32 = 400;
/// Conexiones simultáneas de una misma identidad (el PC y el móvil tienen una o dos).
const MAX_CONNS_PER_ID: usize = 16;
/// Ids que una conexión puede observar.
const MAX_WATCH: usize = 64;

#[derive(Clone, Debug, Default)]
pub struct Config {
    /// Si está, cada cliente tiene que mandarlo en su `hello`.
    pub token: Option<String>,
}

type Tx = mpsc::UnboundedSender<ServerFrame>;

#[derive(Default)]
struct Tables {
    /// Conexiones vivas de cada identidad.
    by_id: HashMap<String, HashMap<u64, Tx>>,
    /// Quién observa a quién: id observado → conexiones que lo observan.
    watchers: HashMap<String, HashSet<u64>>,
    /// Lo que observa cada conexión, y por dónde avisarle.
    watching: HashMap<u64, (Vec<String>, Tx)>,
}

struct Hub {
    keys: Keypair,
    config: Config,
    next_conn: AtomicU64,
    tables: Mutex<Tables>,
}

impl Hub {
    fn tables(&self) -> std::sync::MutexGuard<'_, Tables> {
        self.tables.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify_presence(t: &Tables, id: &str, online: bool) {
        for conn in t.watchers.get(id).into_iter().flatten() {
            if let Some((_, tx)) = t.watching.get(conn) {
                let _ = tx.send(ServerFrame::Presence { id: id.into(), online });
            }
        }
    }

    fn register(&self, id: &str, conn: u64, tx: Tx) -> Result<(), &'static str> {
        let mut t = self.tables();
        let conns = t.by_id.entry(id.to_string()).or_default();
        if conns.len() >= MAX_CONNS_PER_ID {
            return Err("demasiadas conexiones con esta identidad");
        }
        let first = conns.is_empty();
        conns.insert(conn, tx);
        if first {
            Self::notify_presence(&t, id, true);
        }
        Ok(())
    }

    fn unregister(&self, id: &str, conn: u64) {
        let mut t = self.tables();
        if let Some((ids, _)) = t.watching.remove(&conn) {
            for watched in ids {
                if let Some(set) = t.watchers.get_mut(&watched) {
                    set.remove(&conn);
                    if set.is_empty() {
                        t.watchers.remove(&watched);
                    }
                }
            }
        }
        let gone = match t.by_id.get_mut(id) {
            Some(conns) => {
                conns.remove(&conn);
                conns.is_empty()
            }
            None => false,
        };
        if gone {
            t.by_id.remove(id);
            Self::notify_presence(&t, id, false);
        }
    }

    /// Reenvía a todas las conexiones de `to`. `false` si no hay ninguna.
    fn deliver(&self, from: &str, to: &str, body: String) -> bool {
        let t = self.tables();
        let Some(conns) = t.by_id.get(to) else { return false };
        let mut any = false;
        for tx in conns.values() {
            any |= tx.send(ServerFrame::Msg { from: from.into(), body: body.clone() }).is_ok();
        }
        any
    }

    fn watch(&self, conn: u64, ids: Vec<String>, tx: Tx) {
        let mut t = self.tables();
        if let Some((old, _)) = t.watching.remove(&conn) {
            for watched in old {
                if let Some(set) = t.watchers.get_mut(&watched) {
                    set.remove(&conn);
                }
            }
        }
        for id in &ids {
            t.watchers.entry(id.clone()).or_default().insert(conn);
            let online = t.by_id.contains_key(id);
            let _ = tx.send(ServerFrame::Presence { id: id.clone(), online });
        }
        t.watching.insert(conn, (ids, tx));
    }
}

/// El router, para montarlo donde haga falta (los tests lo sirven en un puerto libre).
pub fn router(config: Config) -> Router {
    let hub = Arc::new(Hub {
        // Efímera: solo sirve para los desafíos de esta corrida del relay.
        keys: Keypair::generate(),
        config,
        next_conn: AtomicU64::new(1),
        tables: Mutex::new(Tables::default()),
    });
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/ws", get(upgrade))
        .with_state(hub)
}

/// Sirve en `listener` hasta que el proceso termine.
pub async fn serve(listener: tokio::net::TcpListener, config: Config) -> std::io::Result<()> {
    axum::serve(listener, router(config)).await
}

async fn upgrade(ws: WebSocketUpgrade, State(hub): State<Arc<Hub>>) -> impl IntoResponse {
    ws.max_message_size(MAX_FRAME_BYTES).max_frame_size(MAX_FRAME_BYTES).on_upgrade(move |socket| connection(socket, hub))
}

fn text(frame: &ServerFrame) -> Message {
    Message::Text(serde_json::to_string(frame).expect("frame serializable").into())
}

/// Verifica el `hello`. Devuelve la identidad.
fn authenticate(hub: &Hub, frame: ClientFrame, challenge: &[u8]) -> Result<String, ServerFrame> {
    let ClientFrame::Hello { key, proof, token, .. } = frame else {
        return Err(ServerFrame::error("proto", "se esperaba hello"));
    };
    if let Some(expected) = &hub.config.token {
        let given = token.unwrap_or_default();
        if !crypto::constant_time_eq(given.as_bytes(), expected.as_bytes()) {
            return Err(ServerFrame::error("token", "token del relay inválido"));
        }
    }
    let client_pk = public_key(&key).map_err(|e| ServerFrame::error("auth", e))?;
    let proof = unb64(&proof).map_err(|e| ServerFrame::error("auth", e))?;
    let opened = crypto::open(&proof, &client_pk, &hub.keys.secret)
        .map_err(|_| ServerFrame::error("auth", "la prueba no corresponde a esa clave"))?;
    if !crypto::constant_time_eq(&opened, challenge) {
        return Err(ServerFrame::error("auth", "la prueba no corresponde al desafío"));
    }
    Ok(key)
}

async fn connection(socket: WebSocket, hub: Arc<Hub>) {
    let (mut sink, mut stream) = socket.split();

    let challenge: [u8; 32] = crypto::random_bytes();
    let hello = ServerFrame::Challenge { relay: hub.keys.id(), challenge: b64(&challenge) };
    if sink.send(text(&hello)).await.is_err() {
        return;
    }

    let first = match tokio::time::timeout(HELLO_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<ClientFrame>(t.as_str()).ok(),
        _ => None,
    };
    let id = match first.ok_or_else(|| ServerFrame::error("proto", "se esperaba hello")).and_then(|f| authenticate(&hub, f, &challenge)) {
        Ok(id) => id,
        Err(error) => {
            let _ = sink.send(text(&error)).await;
            let _ = sink.close().await;
            return;
        }
    };

    let conn = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerFrame>();
    if let Err(message) = hub.register(&id, conn, tx.clone()) {
        let _ = sink.send(text(&ServerFrame::error("limit", message))).await;
        let _ = sink.close().await;
        return;
    }
    let _ = tx.send(ServerFrame::Ready { id: id.clone() });

    // Todo lo que sale va por un solo escritor: los frames de otras conexiones y los pings.
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                frame = rx.recv() => match frame {
                    Some(frame) => if sink.send(text(&frame)).await.is_err() { break },
                    None => break,
                },
                _ = ping.tick() => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break },
            }
        }
        let _ = sink.close().await;
    });

    let mut window = Instant::now();
    let mut count = 0u32;
    while let Some(Ok(message)) = stream.next().await {
        let raw = match message {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        if window.elapsed() > RATE_WINDOW {
            window = Instant::now();
            count = 0;
        }
        count += 1;
        if count > RATE_MAX {
            let _ = tx.send(ServerFrame::error("rate", "demasiados mensajes; esperá unos segundos"));
            continue;
        }
        match serde_json::from_str::<ClientFrame>(raw.as_str()) {
            Ok(ClientFrame::Send { to, body }) => {
                if !hub.deliver(&id, &to, body) {
                    let _ = tx.send(ServerFrame::Undelivered { to });
                }
            }
            Ok(ClientFrame::Watch { mut ids }) => {
                ids.truncate(MAX_WATCH);
                hub.watch(conn, ids, tx.clone());
            }
            Ok(ClientFrame::Hello { .. }) | Err(_) => {
                let _ = tx.send(ServerFrame::error("proto", "frame no válido"));
            }
        }
    }

    hub.unregister(&id, conn);
    drop(tx);
    writer.abort();
}
