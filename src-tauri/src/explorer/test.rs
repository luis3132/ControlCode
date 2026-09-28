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

// ── Buscador ─────────────────────────────────────────────────────

use super::search::{build_regex, preview_of, search, SearchQuery};

fn query(root: &std::path::Path, text: &str) -> SearchQuery {
    SearchQuery {
        root: root.to_string_lossy().to_string(),
        query: text.to_string(),
        is_regex: false,
        case_sensitive: false,
        whole_word: false,
        include: String::new(),
        exclude: String::new(),
    }
}

fn fixture(label: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-search-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (rel, content) in files {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    dir
}

#[test]
fn encuentra_y_respeta_el_gitignore_aunque_no_sea_un_repo() {
    let dir = fixture("gitignore", &[
        (".gitignore", "dist/\n"),
        ("src/app.ts", "const token = leerToken();\n"),
        ("dist/app.js", "const token = 1;\n"),
        ("node_modules/lib/index.js", "token\n"),
    ]);
    let r = search(&query(&dir, "token"), || false).unwrap();
    let rels: Vec<_> = r.files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(rels, ["src/app.ts"]);
    assert_eq!(r.files[0].matches[0].line, 1);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn las_opciones_de_mayusculas_palabra_y_regex() {
    let dir = fixture("opciones", &[("a.txt", "Token\ntokens\ntoken\n")]);
    let mut q = query(&dir, "token");
    assert_eq!(search(&q, || false).unwrap().match_count, 3);

    q.case_sensitive = true;
    assert_eq!(search(&q, || false).unwrap().match_count, 2);

    q.whole_word = true;
    assert_eq!(search(&q, || false).unwrap().match_count, 1);

    let mut re = query(&dir, "^tok\\w+s$");
    re.is_regex = true;
    assert_eq!(search(&re, || false).unwrap().match_count, 1);

    // Un literal con caracteres de regex se busca tal cual.
    assert!(build_regex(&query(&dir, "a.b(")).is_ok());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn incluir_y_excluir_por_glob() {
    let dir = fixture("globs", &[("src/a.ts", "x\n"), ("src/b.test.ts", "x\n"), ("docs/c.md", "x\n")]);
    let mut q = query(&dir, "x");
    q.include = "src/**".into();
    q.exclude = "*.test.ts".into();
    let rels: Vec<_> = search(&q, || false).unwrap().files.into_iter().map(|f| f.rel).collect();
    assert_eq!(rels, ["src/a.ts"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn incluir_por_extension_baja_a_las_subcarpetas() {
    let dir = fixture("extension", &[("src/deep/a.ts", "x\n"), ("src/b.js", "x\n")]);
    let mut q = query(&dir, "x");
    q.include = "*.ts".into();
    let rels: Vec<_> = search(&q, || false).unwrap().files.into_iter().map(|f| f.rel).collect();
    assert_eq!(rels, ["src/deep/a.ts"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn una_busqueda_reemplazada_corta() {
    let dir = fixture("cancel", &[("a.txt", "x\n"), ("b.txt", "x\n")]);
    let r = search(&query(&dir, "x"), || true).unwrap();
    assert!(r.cancelled);
    assert!(r.files.is_empty());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn los_binarios_no_aparecen() {
    let dir = fixture("binario", &[("img.bin", "x\0\0\0x"), ("ok.txt", "x")]);
    let rels: Vec<_> = search(&query(&dir, "x"), || false).unwrap().files.into_iter().map(|f| f.rel).collect();
    assert_eq!(rels, ["ok.txt"]);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn la_vista_previa_resalta_en_utf16() {
    // "ñ" ocupa dos bytes pero una unidad UTF-16; el emoji, cuatro bytes y dos unidades.
    // En JS, `preview.slice(start, end)` tiene que dar exactamente la coincidencia.
    let line = "  const año = '😀' + valor;";
    let start = line.find("valor").unwrap();
    let (preview, s, e) = preview_of(line, start, start + "valor".len());
    let utf16: Vec<u16> = preview.encode_utf16().collect();
    assert_eq!(String::from_utf16(&utf16[s as usize..e as usize]).unwrap(), "valor");
}

#[test]
fn una_linea_enorme_se_recorta_alrededor_de_la_coincidencia() {
    let line = format!("{}AQUI{}", "a".repeat(5000), "b".repeat(5000));
    let start = line.find("AQUI").unwrap();
    let (preview, s, e) = preview_of(&line, start, start + 4);
    assert!(preview.len() < 300, "{}", preview.len());
    assert!(preview.starts_with('…') && preview.ends_with('…'));
    let utf16: Vec<u16> = preview.encode_utf16().collect();
    assert_eq!(String::from_utf16(&utf16[s as usize..e as usize]).unwrap(), "AQUI");
}

// ── Tabs de archivo ──────────────────────────────────────────────

use super::files::{explorer_read_file, explorer_write_file, FileContent, WriteOutcome};

#[test]
fn guardar_no_pisa_lo_que_otro_escribio_despues_de_abrir() {
    let dir = fixture("guardar", &[("nota.md", "uno")]);
    let path = dir.join("nota.md").to_string_lossy().to_string();

    let FileContent::Text { mtime, .. } = explorer_read_file(path.clone()).unwrap() else { panic!("texto") };

    // Un agente escribe mientras la tab está abierta.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&path, "lo del agente").unwrap();

    let outcome = explorer_write_file(path.clone(), "lo del usuario".into(), Some(mtime)).unwrap();
    assert!(matches!(outcome, WriteOutcome::Conflict { .. }));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "lo del agente");

    // Sin condición (el usuario eligió sobrescribir), se guarda.
    let outcome = explorer_write_file(path.clone(), "lo del usuario".into(), None).unwrap();
    assert!(matches!(outcome, WriteOutcome::Saved { .. }));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "lo del usuario");
    std::fs::remove_dir_all(dir).ok();
}

#[cfg(unix)]
#[test]
fn guardar_a_traves_de_un_symlink_no_rompe_el_enlace_ni_los_permisos() {
    use std::os::unix::fs::PermissionsExt;
    let dir = fixture("symlink", &[("real/run.sh", "echo uno\n")]);
    let real = dir.join("real/run.sh");
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
    let link = dir.join("link.sh");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    explorer_write_file(link.to_string_lossy().to_string(), "echo dos\n".into(), None).unwrap();

    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "sigue siendo un enlace");
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "echo dos\n");
    assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o755);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn un_binario_no_se_abre_como_texto() {
    let dir = fixture("bin", &[("datos.bin", "a\0b")]);
    let path = dir.join("datos.bin").to_string_lossy().to_string();
    assert!(matches!(explorer_read_file(path).unwrap(), FileContent::Binary { .. }));
    std::fs::remove_dir_all(dir).ok();
}

mod ops {
    use std::fs;

    use super::super::ops::*;

    /// Una carpeta propia por test, que se borra al soltarla.
    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tmp() -> Tmp {
        let p = std::env::temp_dir().join(format!("cc-ops-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }

    fn s(p: &std::path::Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn copiar_en_la_misma_carpeta_elige_un_nombre_libre() {
        let d = tmp();
        fs::write(d.path().join("a.ts"), "x").unwrap();
        let src = s(&d.path().join("a.ts"));
        let one = explorer_copy(src.clone(), s(d.path())).unwrap();
        let two = explorer_copy(src, s(d.path())).unwrap();
        assert!(one.ends_with("a copy.ts"), "{one}");
        assert!(two.ends_with("a copy 2.ts"), "{two}");
    }

    #[test]
    fn las_carpetas_y_los_ocultos_llevan_el_sufijo_al_final() {
        let d = tmp();
        fs::create_dir(d.path().join("v1.2")).unwrap();
        fs::write(d.path().join(".env"), "").unwrap();
        assert!(free_name(d.path(), "v1.2", true).ends_with("v1.2 copy"));
        assert!(free_name(d.path(), ".env", false).ends_with(".env copy"));
    }

    #[test]
    fn copia_carpetas_enteras_y_no_adentro_de_si_mismas() {
        let d = tmp();
        let src = d.path().join("src");
        fs::create_dir_all(src.join("deep")).unwrap();
        fs::write(src.join("deep/f.txt"), "hola").unwrap();
        let dst = d.path().join("dst");
        fs::create_dir(&dst).unwrap();

        let copied = explorer_copy(s(&src), s(&dst)).unwrap();
        assert_eq!(fs::read_to_string(std::path::Path::new(&copied).join("deep/f.txt")).unwrap(), "hola");
        assert!(explorer_copy(s(&src), s(&src.join("deep"))).is_err());
    }

    #[test]
    fn mover_no_pisa_y_no_se_mete_en_si_mismo() {
        let d = tmp();
        let a = d.path().join("a");
        let b = d.path().join("b");
        fs::create_dir_all(a.join("inner")).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(a.join("f.txt"), "1").unwrap();
        fs::write(b.join("f.txt"), "2").unwrap();

        assert!(explorer_move(s(&a.join("f.txt")), s(&b)).is_err());
        assert_eq!(fs::read_to_string(b.join("f.txt")).unwrap(), "2");
        assert!(explorer_move(s(&a), s(&a.join("inner"))).is_err());

        let moved = explorer_move(s(&a), s(&b)).unwrap();
        assert!(std::path::Path::new(&moved).join("f.txt").is_file());
        assert!(!a.exists());
    }

    #[test]
    fn crear_y_renombrar_no_pisan_ni_escapan() {
        let d = tmp();
        let dir = s(d.path());
        let f = explorer_create_file(dir.clone(), "x.md".into()).unwrap();
        assert!(explorer_create_file(dir.clone(), "x.md".into()).is_err());
        assert!(explorer_create_dir(dir.clone(), "../fuera".into()).is_err());
        explorer_create_dir(dir.clone(), "y".into()).unwrap();
        assert!(explorer_rename(f.clone(), "y".into()).is_err());
        let renamed = explorer_rename(f, "z.md".into()).unwrap();
        assert!(renamed.ends_with("z.md") && std::path::Path::new(&renamed).is_file());
    }
}
