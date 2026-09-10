//! Leer un directorio, un nivel por vez.

use std::path::Path;

use serde::Serialize;

/// Una entrada del árbol. `path` es absoluta porque el frontend la usa como identidad
/// (para expandir, para cruzar contra el estado de git) y derivarla concatenando strings
/// se rompe en Windows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Empieza con punto. Se marca en vez de esconderse: el panel decide si atenuarla.
    pub is_hidden: bool,
}

/// Carpetas que no aportan nada al leer un proyecto y sí cuestan al recorrerlo. No se
/// ocultan, se ordenan al final y el panel las atenúa — esconderlas haría que un
/// `node_modules` que ocupa 2 GB sea invisible justo cuando se lo busca.
const NOISY: &[&str] = &["node_modules", "target", "dist", "build", ".git", ".next", "vendor"];

pub(crate) fn is_noisy(name: &str) -> bool {
    NOISY.contains(&name)
}

/// Ordena como lo hace cualquier explorador: carpetas primero, alfabético sin distinguir
/// mayúsculas, y el ruido al fondo de su grupo.
pub(crate) fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        let key = |e: &DirEntry| (!e.is_dir, is_noisy(&e.name), e.name.to_lowercase());
        key(a).cmp(&key(b))
    });
}

/// Un solo nivel de `path`. No recursa: el panel expande a demanda, y un proyecto con
/// `node_modules` haría que una lectura recursiva tarde segundos y devuelva megabytes.
#[tauri::command]
pub fn explorer_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{path} no es un directorio"));
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("no se pudo leer {path}: {e}"))? {
        // Una entrada ilegible (permisos, symlink roto) no puede tumbar el listado entero:
        // el árbol tiene que mostrar lo que sí se pudo leer.
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        // `file_type()` no sigue symlinks; para decidir si es expandible interesa el
        // destino, no el enlace — y las skills se materializan justamente como symlinks
        // a carpetas, así que sin esto no se podrían abrir desde el panel.
        let is_dir = entry.path().is_dir();
        out.push(DirEntry {
            is_hidden: name.starts_with('.'),
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }

    sort_entries(&mut out);
    Ok(out)
}
