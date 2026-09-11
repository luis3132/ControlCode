use std::collections::HashMap;

use super::git::{mark_from_xy, parse_status_z, FileMark};
use super::tree::{is_noisy, sort_entries, DirEntry};

fn entry(name: &str, is_dir: bool) -> DirEntry {
    DirEntry {
        name: name.to_string(),
        path: format!("/tmp/{name}"),
        is_dir,
        is_hidden: name.starts_with('.'),
    }
}

#[test]
fn las_carpetas_van_antes_que_los_archivos() {
    let mut v = vec![entry("zeta.rs", false), entry("alpha", true), entry("beta.rs", false)];
    sort_entries(&mut v);
    let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["alpha", "beta.rs", "zeta.rs"]);
}

#[test]
fn el_ruido_se_va_al_fondo_de_su_grupo_sin_esconderse() {
    let mut v = vec![entry("node_modules", true), entry("src", true), entry("target", true)];
    sort_entries(&mut v);
    let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
    // `src` primero aunque alfabéticamente vaya después: es lo que se busca al abrir.
    assert_eq!(names, ["src", "node_modules", "target"]);
    assert!(is_noisy("node_modules") && !is_noisy("src"));
}

#[test]
fn ordena_sin_distinguir_mayusculas() {
    let mut v = vec![entry("README.md", false), entry("app.tsx", false), entry("Cargo.toml", false)];
    sort_entries(&mut v);
    let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["app.tsx", "Cargo.toml", "README.md"]);
}

#[test]
fn el_conflicto_gana_sobre_cualquier_otra_marca() {
    for xy in ["UU", "AU", "UD", "AA", "DD"] {
        assert_eq!(mark_from_xy(xy), Some(FileMark::Conflict), "{xy}");
    }
}

#[test]
fn el_indice_manda_sobre_el_arbol() {
    // Agregado al índice y después editado: interesa que es nuevo, no que se tocó.
    assert_eq!(mark_from_xy("AM"), Some(FileMark::Added));
    assert_eq!(mark_from_xy(" M"), Some(FileMark::Modified));
    assert_eq!(mark_from_xy("M "), Some(FileMark::Modified));
    assert_eq!(mark_from_xy("??"), Some(FileMark::Untracked));
    assert_eq!(mark_from_xy("  "), None);
}

#[test]
fn un_rename_consume_su_ruta_de_origen() {
    // Sin consumir la segunda ruta del rename, "viejo.rs" se leería como un registro
    // propio y todo lo que viene después quedaría corrido.
    let raw = "R  nuevo.rs\0viejo.rs\0 M src/app.tsx\0?? nota.md\0";
    let got = parse_status_z(raw);

    let want: HashMap<String, String> = [
        ("nuevo.rs", "A"),
        ("src/app.tsx", "M"),
        ("nota.md", "?"),
    ].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();

    assert_eq!(got, want, "el rename desincronizó el parseo");
}

#[test]
fn las_rutas_con_espacios_sobreviven() {
    let raw = " M src/mi carpeta/App.tsx\0";
    let got = parse_status_z(raw);
    assert_eq!(got.get("src/mi carpeta/App.tsx").map(String::as_str), Some("M"));
}

#[test]
fn una_salida_vacia_no_es_un_error() {
    assert!(parse_status_z("").is_empty());
}
