//! Cómo dibuja el WebView en Linux: con o sin la composición por GPU de WebKitGTK.
//!
//! ## Por qué no se deja en el valor por defecto
//!
//! WebKitGTK compone la ventana por GPU, y en ese camino ubica las teselas donde rasteriza
//! el texto en coordenadas fraccionarias; al pintarlas, el filtrado bilineal las promedia y
//! el texto sale borroso — nítido lo demás, borroso solo el texto, y peor después de
//! redimensionar. Está documentado en tauri-apps/wry#1727: ni las pistas de CSS
//! (`text-rendering`, `-webkit-font-smoothing`) ni cambiar el antialiasing lo arreglan; lo
//! único que lo resuelve es no componer por GPU.
//!
//! El costo es rendimiento (la ventana se compone en CPU, y sin composición tampoco hay
//! WebGL), así que queda como opción: apagada por defecto, que es lo que se ve bien, y
//! encendible desde Configuración si en alguna máquina la app se siente lenta.
//!
//! Solo se puede decidir ANTES de crear la primera ventana: WebKitGTK lee la variable al
//! inicializarse. Por eso vive en el arranque y cambiarla pide reiniciar.

use std::sync::OnceLock;

use serde::Serialize;

use crate::database::{get_setting, DbConnection};

/// `"1"` = componer por GPU. Cualquier otra cosa (o nada) = texto nítido.
pub(crate) const GPU_COMPOSITING_KEY: &str = "render.gpu_compositing";

const WEBKIT_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

/// Si la variable ya venía definida por el usuario antes de que la app la tocara.
static USER_ENV: OnceLock<bool> = OnceLock::new();

pub(super) fn gpu_compositing_enabled(db: &DbConnection) -> bool {
    get_setting(db, GPU_COMPOSITING_KEY).ok().flatten().as_deref() == Some("1")
}

/// Aplica la preferencia.
///
/// Tiene que correr con el proceso todavía en un solo hilo: antes de construir Tauri y
/// antes de `cleanup_on_signals`, que es el primero en crear uno (ver `run`). Escribir el
/// entorno mientras otro hilo lo lee —cualquier `getenv`, o lanzar un proceso— es
/// comportamiento indefinido, y por eso `set_var` es `unsafe` desde la edición 2024.
pub(super) fn configure(db: &DbConnection) {
    let user_defined = std::env::var_os(WEBKIT_ENV).is_some();
    let _ = USER_ENV.set(user_defined);
    // Quien la definió a mano sabe lo que quiere: su valor manda sobre el de la app.
    if cfg!(target_os = "linux") && !user_defined && !gpu_compositing_enabled(db) {
        // SAFETY: todavía no hay otro hilo que pueda leer el entorno — `run` llama a esto
        // antes de instalar el hilo de señales y de levantar Tauri, y abrir la base de
        // SQLite no crea hilos.
        unsafe { std::env::set_var(WEBKIT_ENV, "1") };
    }
}

/// Las barras de scroll overlay de GTK (las de GNOME: una raya que aparece solo al pasar el
/// mouse por el borde). WebKitGTK las usa también para las páginas, y en el navegador de
/// las tabs eso era no ver ninguna barra. Una página con `scrollbar-width: thin` —lo
/// común en proyectos con Tailwind— quedaba igual aunque se le inyectara otra barra: en
/// WebKit la propiedad estándar le gana a `::-webkit-scrollbar`. Sin overlay, WebKitGTK
/// dibuja la barra de siempre, con los colores y el grosor que pida la página, como en
/// Chrome. Probado con WebKitGTK 2.52.
const OVERLAY_SCROLLING_ENV: &str = "GTK_OVERLAY_SCROLLING";

/// Si fue la app la que puso `GTK_OVERLAY_SCROLLING` (y no el usuario).
static APP_SET_OVERLAY: OnceLock<bool> = OnceLock::new();

/// Barras de scroll fijas en vez de overlay. Mismas condiciones que `configure`: un solo
/// hilo, antes de levantar GTK, y lo que haya definido el usuario manda.
pub(super) fn configure_scrollbars() {
    let set = cfg!(target_os = "linux") && std::env::var_os(OVERLAY_SCROLLING_ENV).is_none();
    if set {
        // SAFETY: igual que en `configure`, todavía no hay otro hilo.
        unsafe { std::env::set_var(OVERLAY_SCROLLING_ENV, "0") };
    }
    let _ = APP_SET_OVERLAY.set(set);
}

/// Las variables que la app puso para su propio WebKit y que no son del usuario: las
/// terminales las sacan, o un programa gráfico abierto desde ahí heredaría cómo dibuja
/// la app (sin composición por GPU, con barras fijas).
pub fn app_only_env() -> Vec<&'static str> {
    let mut vars = Vec::new();
    if USER_ENV.get() == Some(&false) && std::env::var_os(WEBKIT_ENV).is_some() {
        vars.push(WEBKIT_ENV);
    }
    if APP_SET_OVERLAY.get() == Some(&true) {
        vars.push(OVERLAY_SCROLLING_ENV);
    }
    vars
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderingInfo {
    /// La opción solo existe en Linux: en macOS y Windows el WebView es otro motor.
    pub applies: bool,
    /// Lo que está guardado (lo que va a valer en el próximo arranque).
    pub gpu_compositing: bool,
    /// Lo que vale AHORA en esta ejecución: la composición está activa.
    pub active_now: bool,
    /// El usuario definió `WEBKIT_DISABLE_COMPOSITING_MODE` por su cuenta y eso manda.
    pub forced_by_env: bool,
}

#[tauri::command]
pub fn rendering_info(db: tauri::State<'_, DbConnection>) -> RenderingInfo {
    let applies = cfg!(target_os = "linux");
    RenderingInfo {
        applies,
        gpu_compositing: gpu_compositing_enabled(&db),
        active_now: !applies || std::env::var_os(WEBKIT_ENV).is_none(),
        forced_by_env: USER_ENV.get().copied().unwrap_or(false),
    }
}
