//! Avisarle al panel cuando algo cambia en las carpetas que está mostrando.
//!
//! Antes no había nada: lo que creaba, borraba o renombraba un agente no aparecía en el
//! árbol hasta que el usuario tocaba Actualizar o cambiaba de tab.
//!
//! Se vigilan solo las carpetas que el panel tiene abiertas, cada una **sin recursión**.
//! Vigilar el workspace entero en forma recursiva pondría un watch por cada subcarpeta de
//! `node_modules` y `target` (en Linux, inotify tiene un tope por usuario que se agota), y
//! avisaría de miles de cambios que nadie está mirando. Lo abierto es justo lo visible.
//!
//! Además se vigila el directorio de git (sin recursión: `index` y `HEAD` viven ahí), para
//! que las marcas se refresquen cuando alguien hace `add`, `commit` o cambia de rama.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Cuánto se juntan los avisos antes de mandarlos. Un `git checkout` o un `npm install`
/// tocan cientos de archivos seguidos: sin juntar, el panel releería la carpeta cientos
/// de veces. Corto igual: el usuario espera ver su archivo nuevo "ya".
const DEBOUNCE: Duration = Duration::from_millis(150);

/// Lo que cambió en una tanda.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    /// Carpetas vigiladas cuyo contenido cambió (algo se creó, borró o renombró adentro),
    /// o que desaparecieron ellas mismas.
    pub dirs: Vec<String>,
    /// Cambió algo que puede mover las marcas de git: el índice, HEAD, o el contenido de
    /// un archivo en una carpeta vigilada.
    pub git: bool,
}

/// El evento que va al frontend: la tanda, y de qué ventana es.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerChanged {
    window: String,
    #[serde(flatten)]
    changed: Changed,
}

struct State {
    dirs: HashSet<PathBuf>,
    git_dir: Option<PathBuf>,
}

/// Un conjunto de carpetas vigiladas que llama a `on_change` con cada tanda de cambios.
pub struct DirWatcher {
    watcher: RecommendedWatcher,
    state: Arc<Mutex<State>>,
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

/// Lo que importa de un evento: qué carpetas vigiladas tocó y si mueve las marcas.
fn classify(state: &State, kind: &EventKind, paths: &[PathBuf], out: &mut Changed) {
    for path in paths {
        if let Some(git_dir) = &state.git_dir
            && path.starts_with(git_dir)
        {
            // `index.lock` aparece y desaparece en cada operación: solo cuenta el resultado.
            let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
            if !name.ends_with(".lock") {
                out.git = true;
            }
            continue;
        }
        let parent = path.parent().map(Path::to_path_buf);
        let structural = matches!(kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) | EventKind::Any | EventKind::Other);
        if structural {
            if let Some(parent) = parent.filter(|p| state.dirs.contains(p)) {
                push_unique(&mut out.dirs, &parent);
            }
            // La carpeta vigilada misma se borró o se renombró: el panel tiene que dejar de
            // mostrarla (y su padre, si está abierto, ya entró arriba).
            if state.dirs.contains(path) {
                push_unique(&mut out.dirs, path);
            }
            out.git = true;
        } else if matches!(kind, EventKind::Modify(_)) {
            // Contenido o metadatos: el árbol no cambia, pero un archivo editado pasa a "M".
            out.git = true;
        }
    }
}

fn push_unique(dirs: &mut Vec<String>, path: &Path) {
    let s = path.to_string_lossy().to_string();
    if !dirs.contains(&s) {
        dirs.push(s);
    }
}

impl DirWatcher {
    pub fn new(on_change: impl Fn(Changed) + Send + 'static) -> notify::Result<Self> {
        let state = Arc::new(Mutex::new(State { dirs: HashSet::new(), git_dir: None }));
        let (tx, rx) = mpsc::channel::<notify::Event>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })?;

        // El hilo que junta: espera el primer evento, sigue juntando mientras lleguen más
        // dentro de `DEBOUNCE`, y recién ahí avisa. Termina solo cuando se suelta el
        // watcher (el canal se cierra).
        let shared = state.clone();
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut changed = Changed::default();
                classify(&lock(&shared), &first.kind, &first.paths, &mut changed);
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(event) => classify(&lock(&shared), &event.kind, &event.paths, &mut changed),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !changed.dirs.is_empty() || changed.git {
                    on_change(changed);
                }
            }
        });
        Ok(DirWatcher { watcher, state })
    }

    /// Reemplaza lo vigilado. Solo agrega y saca la diferencia: el panel lo llama cada vez
    /// que se abre o cierra una carpeta, y volver a armar todo perdería eventos.
    pub fn set(&mut self, dirs: &[String], git_dir: Option<&str>) {
        let wanted: HashSet<PathBuf> = dirs.iter().map(PathBuf::from).collect();
        let wanted_git = git_dir.map(PathBuf::from);
        let (old_dirs, old_git) = {
            let st = lock(&self.state);
            (st.dirs.clone(), st.git_dir.clone())
        };

        let mut watching: HashSet<PathBuf> = HashSet::new();
        for dir in old_dirs.difference(&wanted) {
            let _ = self.watcher.unwatch(dir);
        }
        for dir in &wanted {
            // Una carpeta que ya no existe (o sin permiso) no puede tumbar a las demás.
            if old_dirs.contains(dir) || self.watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                watching.insert(dir.clone());
            }
        }
        if old_git != wanted_git {
            if let Some(old) = &old_git
                && !wanted.contains(old)
            {
                let _ = self.watcher.unwatch(old);
            }
            if let Some(new) = &wanted_git
                && !watching.contains(new)
            {
                let _ = self.watcher.watch(new, RecursiveMode::NonRecursive);
            }
        }

        let mut st = lock(&self.state);
        st.dirs = watching;
        st.git_dir = wanted_git;
    }
}

lazy_static::lazy_static! {
    /// Un watcher por ventana: cada una muestra su propio workspace.
    static ref WATCHERS: Mutex<HashMap<String, DirWatcher>> = Mutex::new(HashMap::new());
}

/// Suelta el watcher de una ventana que se cerró.
pub fn forget_window(label: &str) {
    WATCHERS.lock().unwrap_or_else(|e| e.into_inner()).remove(label);
}

/// Lo que vigila el panel de esta ventana: las carpetas abiertas del árbol y el
/// directorio de git del repo. Con `dirs` vacío deja de vigilar.
#[tauri::command]
pub async fn explorer_watch(
    app: AppHandle,
    window: tauri::Window,
    dirs: Vec<String>,
    git_dir: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut all = WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
        if dirs.is_empty() && git_dir.is_none() {
            all.remove(&label);
            return Ok(());
        }
        if !all.contains_key(&label) {
            // A todas las ventanas con la etiqueta adentro, y cada una se queda con la suya:
            // lo mismo que hace el puente de la CLI con `targetLabel`.
            let target = label.clone();
            let watcher = DirWatcher::new(move |changed| {
                let _ = app.emit("explorer-changed", ExplorerChanged { window: target.clone(), changed });
            })
            .map_err(|e| e.to_string())?;
            all.insert(label.clone(), watcher);
        }
        if let Some(watcher) = all.get_mut(&label) {
            watcher.set(&dirs, git_dir.as_deref());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
