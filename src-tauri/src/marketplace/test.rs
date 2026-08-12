//! Tests del marketplace: normalización de lo que pega el usuario, parseo de las
//! fuentes y el formato del cache.

use super::github::{normalize_github_location, parse_github_location};
use super::skillssh::{
    add_target, ensure_npx, find_installed_skill, install_into, normalize_owner_filter,
    parse_find_output, search, skillssh_entry, strip_ansi, SkillsShHit,
};
use super::types::MarketplaceSkillEntry;

// ── GitHub ──────────────────────────────────────────────────────

/// Pegar el link del repo tiene que dar exactamente lo mismo que escribirlo a mano en
/// la forma corta — incluyendo cuando el link viene de estar navegando una subcarpeta.
#[test]
fn los_links_de_github_se_normalizan_a_la_forma_corta() {
    let cases = [
        ("anthropics/skills", "anthropics/skills"),
        ("https://github.com/anthropics/skills", "anthropics/skills"),
        ("https://github.com/anthropics/skills/", "anthropics/skills"),
        ("https://github.com/anthropics/skills.git", "anthropics/skills"),
        ("http://github.com/anthropics/skills", "anthropics/skills"),
        ("https://www.github.com/anthropics/skills", "anthropics/skills"),
        ("github.com/anthropics/skills", "anthropics/skills"),
        ("git@github.com:anthropics/skills.git", "anthropics/skills"),
        ("ssh://git@github.com/anthropics/skills", "anthropics/skills"),
        ("  https://github.com/anthropics/skills  ", "anthropics/skills"),
        ("https://github.com/anthropics/skills?tab=readme", "anthropics/skills"),
        ("https://github.com/anthropics/skills#readme", "anthropics/skills"),
        // Navegando dentro del repo: branch y subcarpeta salen de la propia URL.
        ("https://github.com/anthropics/skills/tree/main", "anthropics/skills@main"),
        (
            "https://github.com/anthropics/skills/tree/main/document-skills",
            "anthropics/skills@main:document-skills",
        ),
        (
            "https://github.com/anthropics/skills/blob/v2/examples/nested",
            "anthropics/skills@v2:examples/nested",
        ),
        // La forma corta con branch/subpath se respeta tal cual.
        ("anthropics/skills@main:examples", "anthropics/skills@main:examples"),
    ];
    for (input, expected) in cases {
        assert_eq!(normalize_github_location(input), expected, "input: {input}");
    }
}

#[test]
fn el_parser_de_github_acepta_links_y_forma_corta_por_igual() {
    for input in ["anthropics/skills", "https://github.com/anthropics/skills.git"] {
        let (owner, repo, branch, subpath) = parse_github_location(input).unwrap();
        assert_eq!((owner.as_str(), repo.as_str()), ("anthropics", "skills"));
        assert_eq!(branch, None);
        assert_eq!(subpath, None);
    }

    let (owner, repo, branch, subpath) =
        parse_github_location("https://github.com/anthropics/skills/tree/main/document-skills")
            .unwrap();
    assert_eq!((owner.as_str(), repo.as_str()), ("anthropics", "skills"));
    assert_eq!(branch.as_deref(), Some("main"));
    assert_eq!(subpath.as_deref(), Some("document-skills"));
}

#[test]
fn lo_que_no_es_un_repo_se_rechaza() {
    for bad in ["", "   ", "anthropics", "/skills", "anthropics/", "https://example.com/foo/bar/baz"]
    {
        assert!(parse_github_location(bad).is_err(), "debería fallar: {bad:?}");
    }
}

// ── skills.sh ───────────────────────────────────────────────────

/// El filtro por publicador es opcional; vacío significa "todo el directorio" y tiene
/// que ser un caso válido, no un error.
#[test]
fn el_filtro_por_publicador_acepta_vacio_nombre_y_link() {
    for (input, expected) in [
        ("", ""),
        ("   ", ""),
        ("vercel-labs", "vercel-labs"),
        ("Vercel-Labs", "vercel-labs"),
        ("https://skills.sh/vercel-labs", "vercel-labs"),
        ("https://www.skills.sh/vercel-labs/", "vercel-labs"),
        ("https://skills.sh/", ""),
    ] {
        assert_eq!(normalize_owner_filter(input).unwrap(), expected, "input: {input:?}");
    }

    for bad in ["-malo", "malo-", "con espacio", "con_guion_bajo", "a".repeat(40).as_str()] {
        assert!(normalize_owner_filter(bad).is_err(), "debería fallar: {bad:?}");
    }
}

/// Salida textual real de `npx skills find`, con los colores que la CLI emite incluso
/// redirigida.
#[test]
fn el_parser_saca_las_skills_de_la_salida_real() {
    let raw = "\u{1b}[38;5;102mInstall with\u{1b}[0m npx skills add <owner/repo@skill>\n\n\
        \u{1b}[38;5;145mcallstack/react-native-testing-library@react-native-testing\u{1b}[0m \u{1b}[36m3.3K installs\u{1b}[0m\n\
        \u{1b}[38;5;102m└ https://skills.sh/callstack/react-native-testing-library/react-native-testing\u{1b}[0m\n\n\
        \u{1b}[38;5;145mgithub/awesome-copilot@react19-test-patterns\u{1b}[0m \u{1b}[36m1.1K installs\u{1b}[0m\n\
        \u{1b}[38;5;102m└ https://skills.sh/github/awesome-copilot/react19-test-patterns\u{1b}[0m\n";

    let hits = parse_find_output(raw);
    assert_eq!(hits.len(), 2);
    assert_eq!(
        hits[0],
        SkillsShHit {
            id: "callstack/react-native-testing-library/react-native-testing".into(),
            source: "callstack/react-native-testing-library".into(),
            slug: "react-native-testing".into(),
            installs: Some("3.3K".into()),
        }
    );
    assert_eq!(hits[1].source, "github/awesome-copilot");
    assert_eq!(hits[1].installs.as_deref(), Some("1.1K"));
}

/// La línea de encabezado del propio comando también contiene "skills.sh"; no debe
/// colarse como resultado. Lo mismo cualquier link que no sea de tres segmentos. Y una
/// skill sin instalaciones igual se lista.
#[test]
fn el_parser_distingue_una_skill_de_cualquier_otro_link() {
    let ruido = "Browse at https://skills.sh/\n\
        └ https://skills.sh/owner\n\
        └ https://skills.sh/owner/repo\n\
        └ https://skills.sh/a/b/c/d\n";
    assert!(parse_find_output(ruido).is_empty());

    let hits = parse_find_output("someone/repo@nueva\n└ https://skills.sh/someone/repo/nueva\n");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].installs, None);
}

#[test]
fn strip_ansi_deja_solo_el_texto() {
    assert_eq!(strip_ansi("\u{1b}[36mhola\u{1b}[0m"), "hola");
    assert_eq!(strip_ansi("a\u{1b}[1G\u{1b}[Jb"), "ab");
    assert_eq!(strip_ansi("sin escapes"), "sin escapes");
}

/// Lo que se le pasa a `add` es `owner/repo@slug`, no el id con barras. Un id incompleto
/// no puede convertirse en un comando: mejor fallar que ejecutar `npx skills add` con
/// algo que no identifica ninguna skill.
#[test]
fn el_id_se_traduce_al_target_que_espera_la_cli() {
    assert_eq!(
        add_target("callstack/react-native-testing-library/react-native-testing").as_deref(),
        Some("callstack/react-native-testing-library@react-native-testing")
    );
    for bad in ["", "solo-slug", "owner/repo", "owner/repo/"] {
        assert!(add_target(bad).is_none(), "debería fallar: {bad:?}");
    }
}

/// El servicio exige dos caracteres; devolver vacío sin lanzar el proceso es la
/// diferencia entre no hacer nada y arrancar un `npx` por cada tecla.
#[test]
fn una_busqueda_demasiado_corta_no_llega_a_ejecutar_nada() {
    assert_eq!(search("a", None).unwrap(), Vec::new());
    assert_eq!(search("   ", None).unwrap(), Vec::new());
}

#[test]
fn se_elige_la_carpeta_que_coincide_con_el_slug() {
    let tmp = std::env::temp_dir().join(format!("cc-skillssh-{}", uuid::Uuid::new_v4()));
    for name in ["otra", "buscada"] {
        let dir = tmp.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
    }
    // Sin SKILL.md no es una skill instalada, aunque la carpeta exista.
    std::fs::create_dir_all(tmp.join("vacia")).unwrap();

    let found = find_installed_skill(&tmp, "buscada").unwrap();
    assert_eq!(found.file_name().unwrap(), "buscada");
    assert!(find_installed_skill(&tmp, "inexistente").is_some(), "cae a la única/primera");
    assert!(find_installed_skill(&tmp.join("nada"), "x").is_none());

    let _ = std::fs::remove_dir_all(&tmp);
}

/// `folder_path` es lo único que sobrevive en el cache para poder reinstalar después,
/// así que tiene que quedar en la forma que la CLI entiende tras partirlo.
#[test]
fn una_skill_del_directorio_conserva_como_reinstalarse() {
    let hit = SkillsShHit {
        id: "vercel-labs/agent-skills/vercel-react-best-practices".into(),
        source: "vercel-labs/agent-skills".into(),
        slug: "vercel-react-best-practices".into(),
        installs: Some("626K".into()),
    };
    let entry = skillssh_entry(hit, "reg-1", "skills.sh");

    assert_eq!(entry.name, "vercel-react-best-practices");
    assert_eq!(entry.registry_id, "reg-1");
    assert_eq!(entry.installs.as_deref(), Some("626K"));
    assert_eq!(
        add_target(&entry.folder_path).as_deref(),
        Some("vercel-labs/agent-skills@vercel-react-best-practices")
    );
}

// ── Cache ───────────────────────────────────────────────────────

/// `installs` es un campo nuevo: un `cache_json` escrito por una versión anterior no lo
/// tiene y tiene que seguir leyéndose, o el marketplace aparecería vacío tras actualizar.
#[test]
fn el_cache_viejo_sin_installs_sigue_siendo_legible() {
    let viejo = r#"[{"id":"a","registryId":"r","registryName":"n","name":"A",
        "description":null,"categories":[],"compatibleAgents":[],"folderPath":"a","files":[]}]"#;
    let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(viejo).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].installs, None);
}

// ── Contrato real con la CLI de skills.sh ───────────────────────

/// Busca e instala de verdad. Va con `#[ignore]` porque necesita red y Node instalado —
/// no puede correr en la suite normal. Es la única prueba que detecta que `npx skills`
/// cambió el formato de su salida o el nombre de sus flags, así que conviene correrla al
/// tocar este módulo:
///
/// ```text
/// cargo test --lib marketplace -- --ignored --nocapture
/// ```
#[test]
#[ignore = "necesita red y Node.js instalado"]
fn e2e_la_cli_responde_como_espera_el_parser() {
    ensure_npx().expect("npx tiene que estar disponible para esta prueba");

    let hits = search("react testing", None).expect("la búsqueda debe funcionar");
    assert!(!hits.is_empty(), "el directorio tiene que devolver algo para 'react testing'");
    for h in &hits {
        assert_eq!(h.id.split('/').count(), 3, "id mal parseado: {}", h.id);
        assert!(add_target(&h.id).is_some(), "id no instalable: {}", h.id);
    }

    // Un publicador que no existe no es un error: es una búsqueda sin resultados.
    assert!(search("react testing", Some("no-existe-este-publicador-xyz")).unwrap().is_empty());

    let tmp = std::env::temp_dir().join(format!("cc-skillssh-e2e-{}", uuid::Uuid::new_v4()));
    let dir = install_into(&tmp, "anthropics/skills@webapp-testing").expect("debe instalar");
    assert!(dir.join("SKILL.md").is_file(), "la skill instalada necesita su SKILL.md");
    // `--copy` tiene que dejar archivos reales: la carpeta temporal se borra enseguida.
    assert!(!dir.join("SKILL.md").symlink_metadata().unwrap().file_type().is_symlink());
    let _ = std::fs::remove_dir_all(&tmp);
}

/// El camino completo de una búsqueda: consultar el directorio, guardar en el cache del
/// repositorio y poder volver de ahí a una skill instalable. Es lo que une los dos lados —
/// sin esto, el parser puede estar bien y el cache quedar con algo que
/// `install_marketplace_skill` no sabe reinstalar.
#[tokio::test]
#[ignore = "necesita red y Node.js instalado"]
async fn e2e_buscar_deja_el_cache_listo_para_instalar() {
    let conn = crate::database::test_db();
    conn.execute(
        "INSERT INTO registries (id, name, source_type, location, priority, enabled, created_at)
         VALUES ('r1', 'skills.sh', 'skillssh', '', 0, 1, 0)",
        [],
    )
    .unwrap();
    let db: crate::database::DbConnection = std::sync::Arc::new(std::sync::Mutex::new(conn));

    super::search_remote_conn(&db, "react testing").await.unwrap();

    let (json, error): (Option<String>, Option<String>) = {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT cache_json, cache_error FROM registries WHERE id = 'r1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    };
    assert_eq!(error, None, "la búsqueda no debería dejar error");

    let entries: Vec<MarketplaceSkillEntry> = serde_json::from_str(&json.unwrap()).unwrap();
    assert!(!entries.is_empty(), "tiene que haber guardado resultados");
    for e in &entries {
        assert_eq!(e.registry_id, "r1");
        // Lo que `install_marketplace_skill` necesita para poder reinstalarla después.
        assert!(add_target(&e.folder_path).is_some(), "no instalable: {}", e.id);
    }

    // Buscar otra cosa REEMPLAZA lo anterior en vez de acumularse: si no, la grilla
    // seguiría mostrando resultados de la búsqueda pasada mezclados con los nuevos.
    let antes: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
    super::search_remote_conn(&db, "postgres database migrations").await.unwrap();
    let json: Option<String> = {
        let conn = db.lock().unwrap();
        conn.query_row("SELECT cache_json FROM registries WHERE id = 'r1'", [], |r| r.get(0))
            .unwrap()
    };
    let despues: Vec<String> = serde_json::from_str::<Vec<MarketplaceSkillEntry>>(&json.unwrap())
        .unwrap()
        .iter()
        .map(|e| e.id.clone())
        .collect();
    assert_ne!(antes, despues, "el cache tiene que quedar con la búsqueda nueva");
}
