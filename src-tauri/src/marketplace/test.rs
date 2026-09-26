//! Tests del marketplace: normalización de lo que pega el usuario, parseo de las
//! fuentes y el formato del cache.

use super::github::{normalize_github_location, parse_github_location};
use super::skillssh::{
    add_target, download_into, find_installed_skill, format_installs, install_into, normalize_owner_filter,
    parse_search_response, search, skillssh_entry, strip_ansi, write_download, SkillsShHit,
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

/// Respuesta real de `/api/search` (recortada): lo que devuelve es lo que la CLI muestra
/// con `npx skills find`, así que el resultado tiene que ser el mismo que antes daba el
/// parser de su salida — ordenado por instalaciones y con ellas abreviadas.
#[test]
fn la_busqueda_de_la_api_da_las_mismas_skills_que_la_cli() {
    let body = r#"{"query":"react","searchType":"fuzzy","skills":[
        {"id":"github/awesome-copilot/react19-test-patterns","source":"github/awesome-copilot","skillId":"react19-test-patterns","name":"react19-test-patterns","installs":1100},
        {"id":"callstack/react-native-testing-library/react-native-testing","source":"callstack/react-native-testing-library","skillId":"react-native-testing","name":"react-native-testing","installs":3312},
        {"id":"open.feishu.cn/lark-event","source":"open.feishu.cn","skillId":"lark-event","name":"lark-event","installs":726862},
        {"id":"someone/repo/nueva","source":"someone/repo","skillId":"nueva","name":"nueva","installs":0}
    ],"count":4}"#;

    let hits = parse_search_response(body).unwrap();
    // La de un dominio (dos partes) no sale de un repo de GitHub: `add` no sabría instalarla.
    assert_eq!(hits.len(), 3);
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
    // Sin instalaciones igual se lista, pero sin el número.
    assert_eq!(hits[2].installs, None);

    assert!(parse_search_response(r#"{"skills":[]}"#).unwrap().is_empty());
    assert!(parse_search_response("<html>error</html>").is_err());
}

#[test]
fn las_instalaciones_se_abrevian_como_en_la_web() {
    assert_eq!(format_installs(12), "12");
    assert_eq!(format_installs(1_000), "1K");
    assert_eq!(format_installs(968_596), "968.6K");
    assert_eq!(format_installs(1_260_000), "1.3M");
}

/// Los archivos de una descarga vienen de un servicio de terceros y se escriben en disco:
/// nada puede salirse de la carpeta de la skill.
#[test]
fn la_descarga_no_escribe_fuera_de_la_carpeta_de_la_skill() {
    let root = std::env::temp_dir().join(format!("cc-skillssh-dl-{}", uuid::Uuid::new_v4()));
    let dir = root.join("skill");
    let files = |list: &[(&str, &str)]| list.iter().map(|(p, c)| (p.to_string(), c.to_string())).collect::<Vec<_>>();

    write_download(&dir, &files(&[
        ("skill.md", "---\nname: x\n---\n"),
        ("refs/uno.md", "uno"),
        ("../fuera.md", "no"),
        ("/etc/fuera.md", "no"),
        ("refs\\dos.md", "dos"),
    ]))
    .unwrap();
    assert!(dir.join("SKILL.md").is_file(), "el SKILL.md queda con su nombre exacto");
    assert!(dir.join("refs/uno.md").is_file());
    assert!(dir.join("refs/dos.md").is_file(), "las barras de Windows también son carpetas");
    assert!(!root.join("fuera.md").exists());

    let err = write_download(&root.join("otra"), &files(&[("README.md", "sin skill")])).unwrap_err();
    assert!(err.contains("SKILL.md"), "{err}");
    let _ = std::fs::remove_dir_all(&root);
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
/// diferencia entre no hacer nada y salir a internet por cada tecla.
#[tokio::test]
async fn una_busqueda_demasiado_corta_no_llega_a_ejecutar_nada() {
    assert_eq!(search("a", None).await.unwrap(), Vec::new());
    assert_eq!(search("   ", None).await.unwrap(), Vec::new());
}

/// Con varias candidatas se elige la que coincide con el slug, y **solo** esa: `read_dir`
/// no tiene orden garantizado, así que caer a "la primera" instalaba una skill al azar
/// bajo el nombre de otra.
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
    assert!(
        find_installed_skill(&tmp, "inexistente").is_none(),
        "con varias candidatas no se adivina"
    );
    assert!(find_installed_skill(&tmp.join("nada"), "x").is_none());

    let _ = std::fs::remove_dir_all(&tmp);
}

/// La contracara: si la CLI nombró la carpeta distinto pero hay una sola, esa es.
#[test]
fn con_una_sola_candidata_se_acepta_aunque_no_coincida_el_nombre() {
    let tmp = std::env::temp_dir().join(format!("cc-skillssh-{}", uuid::Uuid::new_v4()));
    let dir = tmp.join("nombre-que-puso-la-cli");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();

    let found = find_installed_skill(&tmp, "el-slug-que-pedimos").unwrap();
    assert_eq!(found.file_name().unwrap(), "nombre-que-puso-la-cli");

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

/// Busca e instala de verdad. Va con `#[ignore]` porque necesita red (y Node para el
/// respaldo) — no puede correr en la suite normal. Es la única prueba que detecta que la
/// API de skills.sh o las flags de `npx skills` cambiaron, así que conviene correrla al
/// tocar este módulo:
///
/// ```text
/// cargo test --lib marketplace -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "necesita red y Node.js instalado"]
async fn e2e_la_api_y_la_cli_responden_como_se_espera() {
    let hits = search("react testing", None).await.expect("la búsqueda debe funcionar");
    assert!(!hits.is_empty(), "el directorio tiene que devolver algo para 'react testing'");
    for h in &hits {
        assert_eq!(h.id.split('/').count(), 3, "id mal parseado: {}", h.id);
        assert!(add_target(&h.id).is_some(), "id no instalable: {}", h.id);
    }

    // Un publicador que no existe no es un error: es una búsqueda sin resultados.
    assert!(search("react testing", Some("no-existe-este-publicador-xyz")).await.unwrap().is_empty());

    let tmp = std::env::temp_dir().join(format!("cc-skillssh-e2e-{}", uuid::Uuid::new_v4()));
    let dir = download_into(&tmp.join("api"), "anthropics/skills/webapp-testing").await.expect("debe descargar");
    assert!(dir.join("SKILL.md").is_file(), "la descarga necesita su SKILL.md");
    assert!(download_into(&tmp.join("nada"), "no-existe/nada/nada").await.is_err());

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
#[ignore = "necesita red"]
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
