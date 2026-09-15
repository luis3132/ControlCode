//! La foto de lo que está mostrando el webview de la app, píxel por píxel, con la API de
//! captura de cada motor: WebKitGTK en Linux, WebView2 en Windows, WKWebView en macOS.
//!
//! ## Por qué no desde la página
//!
//! Hay librerías que "sacan una foto" de una página redibujando su DOM en un canvas. Es otra
//! foto: no ve lo que dibuja un `<canvas>` o WebGL, ni un video, ni las imágenes de otro
//! origen, y cada CSS que no sabe imitar sale distinto. Lo que se le manda al agente es lo
//! que el usuario tiene delante, y eso solo lo sabe el motor que lo dibujó. Las tres APIs
//! son parte pública de cada webview y no piden permisos: no es una captura de pantalla.
//!
//! Sale el webview entero (la app completa); quien la pide recorta la parte de la página.
//! No depende de nada de la app para poder compilarse sola contra cada sistema.

/// Recibe el PNG o por qué no se pudo. Se llama una sola vez, en el hilo de la interfaz.
pub type Done = Box<dyn FnOnce(Result<Vec<u8>, String>) + Send + 'static>;

// ── Linux: WebKitGTK ─────────────────────────────────────────────────

#[cfg(target_os = "linux")]
pub fn capture(webview: &webkit2gtk::WebView, done: Done) {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    // `Visible`: lo que entra en la ventana, que es lo que el usuario está viendo; con
    // `FullDocument` saldría la app entera desplegada.
    webview.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| done(result.map_err(|e| e.to_string()).and_then(png_from_surface)),
    );
}

#[cfg(target_os = "linux")]
fn png_from_surface(surface: cairo::Surface) -> Result<Vec<u8>, String> {
    let image = cairo::ImageSurface::try_from(surface).map_err(|_| "WebKit no devolvió una imagen".to_string())?;
    let mut png = Vec::new();
    image.write_to_png(&mut png).map_err(|e| e.to_string())?;
    Ok(png)
}

// ── Windows: WebView2 ────────────────────────────────────────────────

#[cfg(windows)]
pub fn capture(controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller, done: Done) {
    use std::sync::{Arc, Mutex};

    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::UI::Shell::SHCreateMemStream;

    // Si `CapturePreview` falla al pedirla, el aviso de terminado nunca llega: el resultado
    // tiene que poder entregarse desde los dos lados, y una sola vez.
    let pending = Arc::new(Mutex::new(Some(done)));
    let finish = {
        let pending = pending.clone();
        move |result: Result<Vec<u8>, String>| {
            if let Some(done) = pending.lock().ok().and_then(|mut slot| slot.take()) {
                done(result);
            }
        }
    };
    let on_error = finish.clone();

    let started = (|| -> windows::core::Result<()> {
        let webview = unsafe { controller.CoreWebView2()? };
        let Some(stream) = (unsafe { SHCreateMemStream(None) }) else {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
        };
        let reader = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            finish(result.map_err(|e| e.message()).and_then(|()| read_stream(&reader)));
            Ok(())
        }));
        unsafe { webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }
    })();
    if let Err(e) = started {
        on_error(Err(e.message()));
    }
}

#[cfg(windows)]
fn read_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|e| e.message())?;
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(|e| e.message())?;
    let mut png = vec![0u8; stat.cbSize as usize];
    let mut read = 0u32;
    unsafe { stream.Read(png.as_mut_ptr().cast(), png.len() as u32, Some(&mut read)) }
        .ok()
        .map_err(|e| e.message())?;
    png.truncate(read as usize);
    Ok(png)
}

// ── macOS: WKWebView ─────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub fn capture(webview: *mut std::ffi::c_void, done: Done) {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let Some(view) = (unsafe { webview.cast::<WKWebView>().as_ref() }) else {
        return done(Err("no hay webview".into()));
    };
    // El bloque es `Fn` para Objective-C, pero se llama una vez.
    let pending = Cell::new(Some(done));
    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        let Some(done) = pending.take() else { return };
        let result = match unsafe { image.as_ref() } {
            Some(image) => png_from_image(image),
            None => Err(unsafe { error.as_ref() }
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "WebKit no devolvió la captura".into())),
        };
        done(result);
    });
    // Sin configuración: lo visible del webview, a la resolución de la pantalla.
    unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &block) };
}

#[cfg(target_os = "macos")]
fn png_from_image(image: &objc2_app_kit::NSImage) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let tiff = image.TIFFRepresentation().ok_or("la captura no tiene pixeles")?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("la captura no se pudo leer")?;
    let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        .ok_or("la captura no se pudo pasar a PNG")?;
    Ok(png.to_vec())
}
