//! Cómo dibuja el WebView en Linux.
//!
//! ## Composición por GPU, siempre
//!
//! WebKitGTK compone la ventana por GPU, y la app lo deja así. Apagarla
//! (`WEBKIT_DISABLE_COMPOSITING_MODE=1`) dejaba el texto más nítido (tauri-apps/wry#1727),
//! y por eso fue el valor por defecto un tiempo; pero con la ventana transparente
//! (`transparent(true)`, por las esquinas redondeadas) en Wayland, WebKitGTK sin composición
//! repinta solo lo que cambió y el resto queda vacío: se veía el fondo de pantalla y la app
//! aparecía a pedazos, donde pasaba el puntero (WebKitGTK 2.54 + Mesa 26.2, GNOME).
//!
//! Quien defina la variable por su cuenta la sigue teniendo: la app no la toca.

use std::sync::OnceLock;

use serde::Serialize;

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

/// Barras de scroll fijas en vez de overlay. Tiene que correr con el proceso todavía en un
/// solo hilo —escribir el entorno mientras otro hilo lo lee es comportamiento indefinido,
/// por eso `set_var` es `unsafe`—, antes de levantar GTK, y lo que haya definido el
/// usuario manda.
pub(super) fn configure_scrollbars() {
    let set = cfg!(target_os = "linux") && std::env::var_os(OVERLAY_SCROLLING_ENV).is_none();
    if set {
        // SAFETY: `run` llama a esto antes de instalar el hilo de señales y de levantar
        // Tauri: todavía no hay otro hilo que pueda leer el entorno.
        unsafe { std::env::set_var(OVERLAY_SCROLLING_ENV, "0") };
    }
    let _ = APP_SET_OVERLAY.set(set);
}

/// Las variables que la app puso para su propio WebKit y que no son del usuario: las
/// terminales las sacan, o un programa gráfico abierto desde ahí heredaría cómo dibuja
/// la app (con barras fijas).
pub fn app_only_env() -> Vec<&'static str> {
    let mut vars = Vec::new();
    if APP_SET_OVERLAY.get() == Some(&true) {
        vars.push(OVERLAY_SCROLLING_ENV);
    }
    vars
}

/// La app nunca la define: solo puede venir del entorno del usuario.
const WEBKIT_ENV: &str = "WEBKIT_DISABLE_COMPOSITING_MODE";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderingInfo {
    /// La ventana se compone por GPU en esta ejecución. Falso solo en Linux con
    /// `WEBKIT_DISABLE_COMPOSITING_MODE` definida por el usuario (y entonces no hay WebGL).
    pub active_now: bool,
}

#[tauri::command]
pub fn rendering_info() -> RenderingInfo {
    RenderingInfo {
        active_now: !cfg!(target_os = "linux") || std::env::var_os(WEBKIT_ENV).is_none(),
    }
}
