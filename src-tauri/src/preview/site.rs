//! Lo que el navegador de la app recuerda de cada sitio: sus cookies, su localStorage y su
//! sessionStorage, por origen — esquema, host y puerto.
//!
//! No se le puede dejar esto al motor del webview. La página vive en un iframe de
//! `http://localhost:<puerto del proxy>` adentro de la app (`tauri://localhost` en Linux y
//! macOS, `http://tauri.localhost` en Windows): para el motor es un sitio de terceros, y
//! así la trata. WebKitGTK guarda su localStorage solo en memoria y lo pierde al cerrar la
//! app (probado con la misma versión que usa la app, contra un localStorage de la página
//! principal que sí sobrevivía). WKWebView le bloquea las cookies, y WebView2 le deja de
//! mandar las `SameSite=Lax`, que es lo que vale una cookie sin atributo. Encima, las
//! cookies que sí guarda las guarda por host y no por puerto, así que el proyecto de
//! `:3000` y el de `:5173` se pisaban la sesión.
//!
//! Por eso el proxy es el frasco de cookies de cada origen, como la parte de red de un
//! navegador: guarda los `Set-Cookie` en vez de pasárselos al iframe, y arma el `Cookie`
//! de cada pedido. La página ve las suyas por `document.cookie`, que el runtime inyectado
//! resuelve acá (`src/features/browser/page/siteState.ts`). El storage sí vive en el
//! navegador; acá se guarda una copia que el runtime manda cuando cambia, y que repone la
//! primera página de cada origen después de arrancar la app si el motor la perdió.
//!
//! Todo va a un archivo por origen en la carpeta de datos de la app. Las cookies de sesión
//! (sin vencimiento) también se guardan: son las que usa un login de desarrollo típico, y
//! perderlas al cerrar la app es justo lo que esto viene a evitar.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::log::{parse_set_cookie, SetCookie};

/// Dónde van los archivos de cada sitio. Lo fija la app al arrancar; sin eso (los tests) el
/// estado vive solo en memoria.
static STATE_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_state_dir(dir: PathBuf) {
    if let Ok(mut current) = STATE_DIR.write() {
        *current = Some(dir);
    }
}

pub(crate) fn state_dir() -> Option<PathBuf> {
    STATE_DIR.read().ok().and_then(|d| d.clone())
}

/// Lo que el runtime de la página le pide al proxy (ver `proxy::site_request`).
pub(crate) const SITE_COOKIE_PATH: &str = "/__controlcode__/cookie";
pub(crate) const SITE_STORAGE_PATH: &str = "/__controlcode__/storage";

/// Con qué se identifica el runtime en esos pedidos. Otro sitio no puede ponerla sin un
/// preflight de CORS, y el proxy no aprueba ninguno.
pub(crate) const OWN_HEADER: &str = "x-controlcode";

/// Va en cada respuesta: la versión del frasco de cookies. La página la compara con la de
/// su copia de `document.cookie` para saber si una respuesta le cambió alguna.
pub(crate) const JAR_HEADER: &str = "x-controlcode-jar";

/// Una asignación a `document.cookie` más grande que esto no es una cookie (un navegador
/// no guarda más de 4 KB por cookie).
pub(crate) const MAX_SCRIPT_COOKIE_BYTES: usize = 16 * 1024;

/// Cuántas cookies se guardan por origen, como hacen los navegadores (Chrome, 180): una
/// página con un bug que invente nombres no puede hacer crecer el archivo sin techo.
const MAX_COOKIES: usize = 180;

/// Hasta cuánto storage se acepta guardar. Un navegador le da 5 MB por área a cada origen;
/// esto deja margen para las dos y el JSON, y corta lo que no puede venir de una página.
pub(crate) const MAX_STORAGE_BYTES: usize = 24 * 1024 * 1024;

/// Cuánto se espera después de un cambio para escribir el archivo: una página que guarda
/// en cada tecla no tiene que escribir el disco en cada tecla.
const SAVE_DELAY: Duration = Duration::from_millis(300);

/// Clave → valor, en el orden en que los devuelve el navegador.
pub type Entries = Vec<(String, String)>;

/// Lo que se guarda de un sitio.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Saved {
    /// Solo para quien abra el archivo: el nombre ya lo dice, pero a medias.
    pub origin: String,
    pub cookies: Vec<SetCookie>,
    /// `None` = nunca se vio el storage de este sitio (no es lo mismo que vacío).
    pub local: Option<Entries>,
    pub session: Option<Entries>,
}

/// Lo que contesta el proxy cuando la página lee o escribe `document.cookie`.
#[derive(Serialize)]
pub struct ScriptCookies {
    pub cookie: String,
    pub v: u64,
}

/// Lo que el runtime repone al cargar la primera página, y lo que manda cuando cambia.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageCopy {
    pub local: Option<Entries>,
    pub session: Option<Entries>,
}

struct Inner {
    saved: Saved,
    /// Sube con cada cambio de cookies: la página lo compara para saber si su copia de
    /// `document.cookie` quedó vieja.
    version: u64,
    /// La copia del storage todavía se puede reponer: nadie mandó el storage vivo en esta
    /// ejecución de la app. Después de eso el del navegador es el que vale, y reponer
    /// resucitaría lo que la página borró a propósito (un logout).
    restore_pending: bool,
    dirty: bool,
}

pub struct Site {
    inner: Mutex<Inner>,
    file: Option<PathBuf>,
    wake: tokio::sync::Notify,
}

/// `http://localhost:5173` → `http_localhost_5173-<hash>.json`. Legible para quien busque
/// el de un sitio, y con el hash para que `a-b` y `a_b` no terminen en el mismo archivo.
pub(crate) fn file_name(origin: &str) -> String {
    let readable: String = origin
        .replace("://", "_")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '_' })
        .collect();
    let hash = origin.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
    format!("{readable}-{hash:08x}.json")
}

/// El path por defecto de una cookie sin `Path`: el "directorio" de la URL que la puso
/// (RFC 6265 §5.1.4). `/app/login` → `/app`; `/login` → `/`.
pub(crate) fn default_path(request_path: &str) -> String {
    let path = request_path.split(['?', '#']).next().unwrap_or("");
    match path.rfind('/') {
        Some(i) if i > 0 && path.starts_with('/') => path[..i].to_string(),
        _ => "/".to_string(),
    }
}

/// Si una cookie con `cookie_path` va en un pedido a `request_path` (RFC 6265 §5.1.4):
/// `/app` va a `/app` y a `/app/x`, pero no a `/application`.
pub(crate) fn path_matches(request_path: &str, cookie_path: &str) -> bool {
    let path = request_path.split(['?', '#']).next().filter(|p| !p.is_empty()).unwrap_or("/");
    path == cookie_path
        || (path.starts_with(cookie_path)
            && (cookie_path.ends_with('/') || path.as_bytes().get(cookie_path.len()) == Some(&b'/')))
}

fn alive(cookie: &SetCookie, now_secs: i64) -> bool {
    cookie.expires_at.is_none_or(|at| at > now_secs)
}

/// Lo que distingue a una cookie de otra con el mismo nombre y path: si solo cambió cuándo
/// se puso, no cambió nada.
fn same_cookie(a: &SetCookie, b: &SetCookie) -> bool {
    (&a.value, a.http_only, a.secure, &a.same_site, a.expires_at) == (&b.value, b.http_only, b.secure, &b.same_site, b.expires_at)
}

/// Guarda (o borra, si viene vencida) una cookie en el frasco. Devuelve si cambió algo.
///
/// `from_script`: la puso `document.cookie`, que no puede crear una `HttpOnly` ni pisar una
/// que ya existe (RFC 6265 §5.3, paso 11) — si pudiera, un script leería la sesión.
pub(crate) fn store_cookie(jar: &mut Vec<SetCookie>, mut cookie: SetCookie, request_path: &str, from_script: bool, now_secs: i64) -> bool {
    let path = cookie.path.take().filter(|p| p.starts_with('/')).unwrap_or_else(|| default_path(request_path));
    cookie.path = Some(path);
    let existing = jar.iter().position(|c| c.name == cookie.name && c.path == cookie.path);
    if from_script {
        if existing.is_some_and(|i| jar[i].http_only) {
            return false;
        }
        cookie.http_only = false;
    }
    match existing {
        // Un `Set-Cookie` vencido es cómo se borra una cookie.
        Some(i) if !alive(&cookie, now_secs) => {
            jar.remove(i);
            true
        }
        None if !alive(&cookie, now_secs) => false,
        Some(i) if same_cookie(&jar[i], &cookie) => false,
        Some(i) => {
            jar[i] = cookie;
            true
        }
        None => {
            jar.push(cookie);
            if jar.len() > MAX_COOKIES {
                let oldest = jar.iter().enumerate().min_by_key(|(_, c)| c.at).map(|(i, _)| i).unwrap_or(0);
                jar.remove(oldest);
            }
            true
        }
    }
}

/// Las cookies que van a `path`, en el orden del RFC: path más largo primero, y entre
/// iguales la más vieja primero.
fn matching<'a>(jar: &'a [SetCookie], path: &str, now_secs: i64, script_only: bool) -> Vec<&'a SetCookie> {
    let mut found: Vec<&SetCookie> = jar
        .iter()
        .filter(|c| alive(c, now_secs) && !(script_only && c.http_only))
        .filter(|c| path_matches(path, c.path.as_deref().unwrap_or("/")))
        .collect();
    found.sort_by(|a, b| {
        let len = |c: &SetCookie| c.path.as_deref().map_or(0, str::len);
        len(b).cmp(&len(a)).then(a.at.cmp(&b.at))
    });
    found
}

fn join(cookies: &[&SetCookie]) -> String {
    cookies.iter().map(|c| format!("{}={}", c.name, c.value)).collect::<Vec<_>>().join("; ")
}

impl Site {
    /// El estado de `origin`, leído de su archivo si hay. Un archivo roto se ignora: se
    /// pierde la sesión guardada, pero el navegador arranca igual.
    pub fn open(origin: &str, dir: Option<&Path>) -> Arc<Self> {
        let file = dir.map(|d| d.join(file_name(origin)));
        let mut saved = file
            .as_deref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .unwrap_or_default();
        saved.origin = origin.to_string();
        let now = now_secs();
        saved.cookies.retain(|c| alive(c, now));
        let restore_pending = saved.local.is_some() || saved.session.is_some();
        Arc::new(Self {
            inner: Mutex::new(Inner { saved, version: 1, restore_pending, dirty: false }),
            file,
            wake: tokio::sync::Notify::new(),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> Option<T> {
        self.inner.lock().ok().map(|mut inner| f(&mut inner))
    }

    fn changed(&self, inner: &mut Inner) {
        inner.dirty = true;
        self.wake.notify_one();
    }

    /// El `Cookie` de un pedido a `path`. `None` si no va ninguna.
    pub fn cookie_header(&self, path: &str, now_secs: i64) -> Option<String> {
        self.with(|inner| join(&matching(&inner.saved.cookies, path, now_secs, false)))
            .filter(|h| !h.is_empty())
    }

    /// Lo que ve `document.cookie` en una página de `path`: las que no son `HttpOnly`.
    pub fn script_cookies(&self, path: &str, now_secs: i64) -> (String, u64) {
        self.with(|inner| (join(&matching(&inner.saved.cookies, path, now_secs, true)), inner.version))
            .unwrap_or_default()
    }

    /// Los `Set-Cookie` de una respuesta al pedido de `request_path`.
    pub fn store_from_server(&self, lines: &[String], request_path: &str, url: &str, now_ms: i64) {
        if lines.is_empty() {
            return;
        }
        self.with(|inner| {
            let mut any = false;
            for line in lines {
                let Some(mut cookie) = parse_set_cookie(line, now_ms / 1000) else { continue };
                cookie.url = url.to_string();
                cookie.at = now_ms;
                any |= store_cookie(&mut inner.saved.cookies, cookie, request_path, false, now_ms / 1000);
            }
            if any {
                inner.version += 1;
                self.changed(inner);
            }
        });
    }

    /// Una asignación a `document.cookie` desde una página de `doc_path`. Devuelve lo que
    /// esa página ve ahora, que es lo que le contesta el setter.
    pub fn store_from_script(&self, line: &str, doc_path: &str, url: &str, now_ms: i64) -> (String, u64) {
        self.with(|inner| {
            if let Some(mut cookie) = parse_set_cookie(line, now_ms / 1000) {
                cookie.url = url.to_string();
                cookie.at = now_ms;
                if store_cookie(&mut inner.saved.cookies, cookie, doc_path, true, now_ms / 1000) {
                    inner.version += 1;
                    self.changed(inner);
                }
            }
        });
        self.script_cookies(doc_path, now_ms / 1000)
    }

    /// Borra una cookie en todos sus paths, `HttpOnly` incluidas. Devuelve si había alguna.
    pub fn forget_cookie(&self, name: &str) -> bool {
        self.with(|inner| {
            let before = inner.saved.cookies.len();
            inner.saved.cookies.retain(|c| c.name != name);
            let removed = inner.saved.cookies.len() != before;
            if removed {
                inner.version += 1;
                self.changed(inner);
            }
            removed
        })
        .unwrap_or(false)
    }

    /// Borra todas las cookies y la copia del storage: el sitio vuelve a como si nunca se
    /// hubiera abierto. El storage vivo lo borra la página.
    pub fn forget_all(&self) {
        self.with(|inner| {
            inner.saved.cookies.clear();
            inner.saved.local = None;
            inner.saved.session = None;
            inner.restore_pending = false;
            inner.version += 1;
            self.changed(inner);
        });
    }

    /// Las cookies vigentes, con sus atributos.
    pub fn cookies(&self, now_secs: i64) -> Vec<SetCookie> {
        self.with(|inner| inner.saved.cookies.iter().filter(|c| alive(c, now_secs)).cloned().collect())
            .unwrap_or_default()
    }

    pub fn version(&self) -> u64 {
        self.with(|inner| inner.version).unwrap_or(0)
    }

    /// La copia del storage para reponer, una sola vez por ejecución de la app (ver
    /// `restore_pending`). Las siguientes veces contesta vacío.
    pub fn take_restore(&self) -> StorageCopy {
        self.with(|inner| {
            if !std::mem::take(&mut inner.restore_pending) {
                return StorageCopy::default();
            }
            StorageCopy { local: inner.saved.local.clone(), session: inner.saved.session.clone() }
        })
        .unwrap_or_default()
    }

    /// El storage vivo de la página. Desde acá ya no se repone nada en esta ejecución.
    pub fn save_storage(&self, copy: StorageCopy) {
        self.with(|inner| {
            inner.restore_pending = false;
            let mut any = false;
            if copy.local.is_some() && copy.local != inner.saved.local {
                inner.saved.local = copy.local;
                any = true;
            }
            if copy.session.is_some() && copy.session != inner.saved.session {
                inner.saved.session = copy.session;
                any = true;
            }
            if any {
                self.changed(inner);
            }
        });
    }

    /// Lo que hay que escribir, si cambió algo desde la última vez.
    fn pending_bytes(&self) -> Option<Vec<u8>> {
        self.with(|inner| {
            if !std::mem::take(&mut inner.dirty) {
                return None;
            }
            let now = now_secs();
            inner.saved.cookies.retain(|c| alive(c, now));
            serde_json::to_vec(&inner.saved).ok()
        })
        .flatten()
    }

    /// Escribe el archivo ya, si hay algo pendiente. Es lo que hace el guardador después de
    /// cada cambio; los tests lo llaman directo.
    pub fn save_now(&self) -> Result<(), String> {
        let (Some(file), Some(bytes)) = (self.file.as_deref(), self.pending_bytes()) else { return Ok(()) };
        write_private(file, &bytes)
    }

    /// Guarda en segundo plano lo que vaya cambiando, agrupando los cambios seguidos. Vive
    /// lo que vive la app, igual que el proxy dueño del sitio.
    pub fn spawn_saver(self: &Arc<Self>) {
        if self.file.is_none() {
            return;
        }
        let site = self.clone();
        tokio::spawn(async move {
            loop {
                // Un cambio mientras se escribía deja el aviso guardado: no se pierde.
                site.wake.notified().await;
                tokio::time::sleep(SAVE_DELAY).await;
                let current = site.clone();
                let result = tokio::task::spawn_blocking(move || current.save_now()).await;
                if let Ok(Err(e)) = result {
                    eprintln!("[preview] no se pudo guardar el estado del sitio: {e}");
                }
            }
        });
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Escribe entero o no escribe: a un archivo temporal y después se lo renombra encima. Un
/// corte a mitad de camino deja el anterior, no uno partido. Solo lo lee el usuario: tiene
/// sesiones iniciadas adentro.
fn write_private(file: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let dir = file.parent().ok_or("el archivo no tiene carpeta")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(&tmp).map_err(|e| e.to_string())?;
    out.write_all(bytes).and_then(|_| out.sync_all()).map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}
