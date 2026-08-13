//! Tests de skills.
//!
//! Casi todos son de integración: ejercitan el módulo real contra SQLite y el filesystem,
//! sin tocar la base del usuario. Usan `tauri::test::mock_app` para obtener un
//! `tauri::State<DbConnection>` legítimo (no se puede construir a mano, el campo es
//! privado) y así llamar los comandos tal cual los llamaría el frontend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::Manager;
use uuid::Uuid;

use crate::database::{db_mark_window_closed, DbConnection};

use super::bundled::{decide, ensure_one, Action, Provisioned, BUNDLED};
use super::files::{scan_skill_file, slug_from_source_path};
use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-skills-test-{}-{}", label, Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Arma una DB de prueba con un workspace + una tab (agent_id='claude-code') cuyo
/// cwd es una carpeta temporal real, más el setting skills_dir apuntando a otra
/// carpeta temporal — replica el estado mínimo que attach_skill necesita.
fn setup() -> (DbConnection, String, String, PathBuf, PathBuf) {
    let conn = crate::database::test_db();

    let workspace_id = "ws-test".to_string();
    let window_id = "win-test".to_string();
    let tab_id = "tab-test".to_string();
    let tab_cwd = temp_dir("tabcwd");
    let skills_dir = temp_dir("skillsdir");

    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES (?1, 'Test WS', 0, 0)",
        [&workspace_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES (?1, 'win', ?2, 1, 0)",
        rusqlite::params![window_id, workspace_id],
    ).unwrap();
    conn.execute(
        "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
         VALUES (?1, ?2, 'Test tab', 'claude-code', 'Claude Code', 'claude', ?3, 0, 0, 0)",
        rusqlite::params![tab_id, window_id, tab_cwd.to_string_lossy()],
    ).unwrap();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
        [skills_dir.to_string_lossy().to_string()],
    )
    .unwrap();

    (
        std::sync::Arc::new(std::sync::Mutex::new(conn)),
        workspace_id,
        tab_id,
        tab_cwd,
        skills_dir,
    )
}

fn write_source_skill(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\n\
         name: git-commit-helper\n\
         description: Genera mensajes de commit siguiendo conventional commits.\n\
         version: 1.2.0\n\
         categories: [git, productivity]\n\
         compatible_agents: [claude-code, gemini-cli]\n\
         compatible_versions:\n  claude-code: \">=1.5.0\"\n\
         author: luis3132\n\
         license: MIT\n\
         homepage: https://example.com/skill\n\
         ---\n\
         Cuerpo de la skill de prueba.\n",
    )
    .unwrap();
}

/// Escribe una skill fuente con un nombre puntual, para simular dos repos que traen
/// una skill que se llama igual pero hace cosas distintas.
fn write_named_skill(dir: &Path, name: &str, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {body}\n---\n{body}\n"),
    )
    .unwrap();
}

/// El caso que motivó los buckets por repositorio: dos repos distintos traen una skill
/// llamada igual. Las dos tienen que poder convivir instaladas, cada una en la carpeta
/// de su repo, y con symlinks que no se pisen dentro del proyecto.
#[test]
fn same_named_skills_from_two_registries_coexist() {
    let (db, workspace_id, tab_id, tab_cwd, skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let src_a = temp_dir("repo-a");
    let src_b = temp_dir("repo-b");
    write_named_skill(&src_a, "testing", "la version del repo A");
    write_named_skill(&src_b, "testing", "la version del repo B");

    let a = install_skill_internal(
        &src_a.join("SKILL.md").to_string_lossy(),
        None,
        Some(SkillOrigin {
            registry_id: "reg-a",
            registry_name: "anthropics/skills",
            skill_id: "testing",
        }),
        &state,
    )
    .expect("instalar desde el repo A");
    let b = install_skill_internal(
        &src_b.join("SKILL.md").to_string_lossy(),
        None,
        Some(SkillOrigin {
            registry_id: "reg-b",
            registry_name: "autoskills (midudev)",
            skill_id: "testing",
        }),
        &state,
    )
    .expect("instalar desde el repo B");

    // Cada copia global vive bajo la carpeta de SU repo.
    assert_eq!(
        Path::new(&a.source_path).parent().unwrap(),
        skills_dir.join("anthropics-skills")
    );
    assert_eq!(
        Path::new(&b.source_path).parent().unwrap(),
        skills_dir.join("autoskills-midudev")
    );
    assert_eq!(a.registry_name.as_deref(), Some("anthropics/skills"));
    assert_eq!(b.registry_name.as_deref(), Some("autoskills (midudev)"));

    // Las dos existen en disco y no se pisaron.
    assert!(Path::new(&a.source_path).join("SKILL.md").exists());
    assert!(Path::new(&b.source_path).join("SKILL.md").exists());
    assert_ne!(a.source_path, b.source_path);

    // El slug (= nombre del symlink en el proyecto) se desambigua, porque las dos
    // pueden terminar attacheadas a la misma tab y competirían por el mismo path.
    let slug_a = slug_from_source_path(&a.source_path);
    let slug_b = slug_from_source_path(&b.source_path);
    assert_eq!(slug_a, "testing");
    assert_eq!(slug_b, "testing-2");

    // Y attacheadas juntas conviven de verdad, cada symlink a su copia.
    for skill in [&a, &b] {
        attach_skill(
            skill.id.clone(),
            workspace_id.clone(),
            "tab".to_string(),
            Some(tab_id.clone()),
            state.clone(),
        )
        .expect("attach");
    }
    let links = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code").unwrap();
    assert_eq!(
        std::fs::read_link(links.join(&slug_a)).unwrap(),
        Path::new(&a.source_path)
    );
    assert_eq!(
        std::fs::read_link(links.join(&slug_b)).unwrap(),
        Path::new(&b.source_path)
    );
}

/// Instala `n` skills distintas y devuelve sus filas.
fn install_n_skills(state: &tauri::State<DbConnection>, n: usize) -> Vec<SkillInfo> {
    (0..n)
        .map(|i| {
            let src = temp_dir(&format!("multi-{i}"));
            write_named_skill(&src, &format!("skill-{i}"), "cuerpo");
            install_skill_internal(&src.join("SKILL.md").to_string_lossy(), None, None, state)
                .expect("instalar")
        })
        .collect()
}

fn linked_slugs(tab_cwd: &Path) -> Vec<String> {
    let Some(dir) = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code") else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    out.sort();
    out
}

/// El caso reportado: una tab con VARIAS skills tiene que abrirse con todas.
#[test]
fn una_tab_con_varias_skills_las_monta_a_todas() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let skills = install_n_skills(&state, 4);
    for s in &skills {
        attach_skill(
            s.id.clone(),
            workspace_id.clone(),
            "tab".to_string(),
            Some(tab_id.clone()),
            state.clone(),
        )
        .expect("attach");
    }

    assert_eq!(
        linked_slugs(&tab_cwd),
        vec!["skill-0", "skill-1", "skill-2", "skill-3"],
        "las cuatro skills tienen que quedar montadas"
    );

    // Y lo que corre justo antes de lanzar el agente no puede desmontarlas.
    reconcile_tab_skills(tab_id.clone(), state.clone()).expect("reconcile");
    assert_eq!(
        linked_slugs(&tab_cwd).len(),
        4,
        "reconciliar no debe quitar skills"
    );
}

/// Una ventana marcada como cerrada hace que sus tabs dejen de reclamar sus skills —
/// eso es DELIBERADO (un workspace cerrado no debe dejar symlinks en las carpetas del
/// usuario). Lo que no puede pasar es quedarse ahí: al volver a estar abierta, las
/// skills tienen que volver, sin que el usuario tenga que reattachear nada.
///
/// Este es el modo de fallo que dejaba la base perfecta y el disco vacío.
#[test]
fn una_ventana_que_vuelve_a_abrirse_recupera_las_skills_de_sus_tabs() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let skills = install_n_skills(&state, 3);
    for s in &skills {
        attach_skill(
            s.id.clone(),
            workspace_id.clone(),
            "tab".to_string(),
            Some(tab_id.clone()),
            state.clone(),
        )
        .expect("attach");
    }
    assert_eq!(linked_slugs(&tab_cwd).len(), 3);

    // Ventana cerrada: las skills se retiran del proyecto.
    {
        let conn = state.lock().unwrap();
        conn.execute("UPDATE windows SET is_open = 0", []).unwrap();
        reconcile_link_dir(&conn, &tab_cwd.to_string_lossy(), "claude-code").unwrap();
    }
    assert!(
        linked_slugs(&tab_cwd).is_empty(),
        "cerrada, no deja symlinks"
    );

    // Y abierta de nuevo, vuelven solas.
    {
        let conn = state.lock().unwrap();
        conn.execute("UPDATE windows SET is_open = 1", []).unwrap();
    }
    reconcile_tab_skills(tab_id, state.clone()).expect("reconcile");
    assert_eq!(
        linked_slugs(&tab_cwd),
        vec!["skill-0", "skill-1", "skill-2"],
        "al reabrirse, las skills tienen que volver"
    );
}

/// El otro caso reportado: reanudar una sesión tiene que devolverle sus skills.
///
/// Recorre el ciclo completo — attachear, archivar al cerrar, y restaurar sobre una
/// tab nueva — porque el fallo no está en ninguno de los pasos por separado.
#[test]
fn reanudar_una_sesion_recupera_sus_skills() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let skills = install_n_skills(&state, 3);
    for s in &skills {
        attach_skill(
            s.id.clone(),
            workspace_id.clone(),
            "tab".to_string(),
            Some(tab_id.clone()),
            state.clone(),
        )
        .expect("attach");
    }
    assert_eq!(linked_slugs(&tab_cwd).len(), 3);

    // Cerrar la tab: se archiva y su fila desaparece (con ella, por cascada, sus
    // attachments).
    let resolved = crate::database::resolve_for_archive(&state, &tab_id);
    let history_id = {
        let conn = state.lock().unwrap();
        crate::database::archive_tab_row(&conn, &tab_id, &workspace_id, &resolved)
            .expect("archivar");
        conn.execute("DELETE FROM tabs WHERE id = ?1", [&tab_id])
            .unwrap();
        conn.query_row("SELECT id FROM session_history", [], |r| {
            r.get::<_, String>(0)
        })
        .expect("tiene que haber quedado una entrada de historial")
    };

    // Lo archivado tiene que incluir las tres, o no hay nada que restaurar después.
    {
        let conn = state.lock().unwrap();
        let archived = crate::database::archived_skills_of_session(&conn, &history_id).unwrap();
        assert_eq!(
            archived.len(),
            3,
            "el historial debe conservar las 3 skills"
        );
    }

    // Reanudar: tab nueva, mismo cwd (es la misma sesión que se reabre).
    let nueva_tab = "tab-reanudada".to_string();
    {
        let conn = state.lock().unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, history_id, opened_at, created_at, last_active)
             VALUES (?1, 'win-test', 'Reanudada', 'claude-code', 'Claude Code', 'claude', ?2, ?3, 0, 0, 0)",
            rusqlite::params![nueva_tab, tab_cwd.to_string_lossy(), history_id],
        )
        .unwrap();
    }

    let missing = restore_session_skills(
        history_id,
        workspace_id.clone(),
        nueva_tab.clone(),
        state.clone(),
    )
    .expect("restore_session_skills");
    assert!(missing.is_empty(), "las 3 siguen instaladas: {missing:?}");

    assert_eq!(
        linked_slugs(&tab_cwd),
        vec!["skill-0", "skill-1", "skill-2"],
        "reanudar tiene que devolver las skills de la sesión"
    );

    // Y el reconcile previo al lanzamiento del agente tampoco puede quitarlas.
    reconcile_tab_skills(nueva_tab, state.clone()).expect("reconcile");
    assert_eq!(
        linked_slugs(&tab_cwd).len(),
        3,
        "reconciliar no debe quitar skills"
    );
}

/// Una skill elegida a mano desde el disco no viene de ningún repo: va al bucket
/// `local` y sin badge.
#[test]
fn manually_installed_skills_land_in_the_local_bucket() {
    let (db, _workspace_id, _tab_id, _tab_cwd, skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let source = temp_dir("source-manual");
    write_source_skill(&source);
    let info = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .expect("install_skill");

    assert_eq!(
        Path::new(&info.source_path).parent().unwrap(),
        skills_dir.join("local")
    );
    assert_eq!(info.registry_id, None);
    assert_eq!(info.registry_name, None);
}

#[test]
fn full_lifecycle_install_attach_edit_detach_delete() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    // 1) install_skill: copia real de carpeta + parseo de frontmatter enriquecido.
    let source = temp_dir("source-skill");
    write_source_skill(&source);
    let info = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .expect("install_skill debería funcionar");
    assert_eq!(info.name, "git-commit-helper");
    assert_eq!(info.version, "1.2.0");
    assert_eq!(info.categories, vec!["git", "productivity"]);
    assert_eq!(info.compatible_agents, vec!["claude-code", "gemini-cli"]);
    assert_eq!(
        info.compatible_versions.get("claude-code"),
        Some(&">=1.5.0".to_string())
    );
    assert_eq!(info.author.as_deref(), Some("luis3132"));
    assert_eq!(info.license.as_deref(), Some("MIT"));
    assert!(
        Path::new(&info.source_path).join("SKILL.md").exists(),
        "la copia global debe existir en disco"
    );

    // 2) list_skills: aparece, sin usage todavía.
    let listed = list_skills(state.clone()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].used_by.len(), 0);

    // 3) attach_skill (scope='tab'): debe crear un symlink REAL en el cwd de la tab.
    attach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id.clone()),
        state.clone(),
    )
    .expect("attach_skill debería funcionar");

    let expected_link = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code")
        .unwrap()
        .join(slug_from_source_path(&info.source_path));
    let link_meta =
        std::fs::symlink_metadata(&expected_link).expect("el symlink debe existir en disco");
    assert!(
        link_meta.file_type().is_symlink(),
        "debe ser un symlink, no una copia"
    );
    let target = std::fs::read_link(&expected_link).unwrap();
    assert_eq!(
        target,
        Path::new(&info.source_path),
        "el symlink debe apuntar a la copia global"
    );

    // Idempotencia: attachear de nuevo no debe fallar ni duplicar el link.
    attach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id.clone()),
        state.clone(),
    )
    .expect("attach_skill debe ser idempotente");

    // 4) used_by ahora refleja el attachment.
    let listed = list_skills(state.clone()).unwrap();
    assert_eq!(listed[0].used_by.len(), 1);
    assert_eq!(listed[0].used_by[0].workspace_id, workspace_id);
    assert_eq!(
        listed[0].used_by[0].tab_id.as_deref(),
        Some(tab_id.as_str())
    );

    // 5) health check: todo sano.
    let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
    assert!(
        health.is_empty(),
        "no debería haber problemas de symlink recién attacheado"
    );

    // 6) edit: update_skill_content reescribe SKILL.md y re-parsea metadata (version bump).
    let detail = get_skill_detail(info.id.clone(), state.clone()).unwrap();
    assert!(detail.content.contains("git-commit-helper"));
    let new_content = detail.content.replace("version: 1.2.0", "version: 1.3.0");
    update_skill_content(info.id.clone(), new_content, state.clone()).unwrap();
    let detail = get_skill_detail(info.id.clone(), state.clone()).unwrap();
    assert_eq!(
        detail.skill.version, "1.3.0",
        "la versión debe reflejar el nuevo frontmatter"
    );

    // 7) simular un symlink roto borrándolo a mano por fuera de la app.
    std::fs::remove_file(&expected_link).unwrap();
    let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
    assert_eq!(health.len(), 1);
    assert_eq!(health[0].issue, "missing");

    // Reparar: volver a attachear debe recrear el symlink.
    attach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id.clone()),
        state.clone(),
    )
    .unwrap();
    assert!(std::fs::symlink_metadata(&expected_link).is_ok());
    let health = check_symlinks_health(workspace_id.clone(), state.clone()).unwrap();
    assert!(health.is_empty());

    // 8) detach_skill: el symlink debe desaparecer y el attachment también.
    detach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id.clone()),
        state.clone(),
    )
    .unwrap();
    assert!(
        std::fs::symlink_metadata(&expected_link).is_err(),
        "el symlink debe haberse removido"
    );
    let listed = list_skills(state.clone()).unwrap();
    assert_eq!(listed[0].used_by.len(), 0);

    // 9) delete_skill: borra la fila y la copia global del disco.
    delete_skill(info.id.clone(), state.clone()).unwrap();
    let listed = list_skills(state.clone()).unwrap();
    assert!(listed.is_empty());
    assert!(
        !Path::new(&info.source_path).exists(),
        "la copia global debe haberse borrado"
    );
}

/// Dos workspaces distintos trabajando sobre LA MISMA carpeta no deben verse las
/// skills entre sí: al abrir el segundo, la carpeta queda solo con las suyas.
#[test]
fn skills_do_not_leak_between_workspaces_sharing_a_folder() {
    let (db, ws_a, tab_a, shared_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    // Segundo workspace + ventana + tab, apuntando al MISMO cwd que el primero.
    // Arranca con la ventana cerrada: recién se "abre" más abajo.
    {
        let conn = state.lock().unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('ws-b', 'WS B', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO windows (id, label, workspace_id, is_open, last_active) VALUES ('win-b', 'win-b', 'ws-b', 0, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
             VALUES ('tab-b', 'win-b', 'Tab B', 'claude-code', 'Claude Code', 'claude', ?1, 0, 0, 0)",
            [shared_cwd.to_string_lossy().to_string()],
        ).unwrap();
    }

    let source_a = temp_dir("skill-a");
    write_source_skill(&source_a);
    let skill_a = install_skill(
        source_a.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    let source_b = temp_dir("skill-b");
    std::fs::create_dir_all(&source_b).unwrap();
    std::fs::write(
        source_b.join("SKILL.md"),
        "---\nname: solo-de-ws-b\ncompatible_agents: [claude-code]\n---\nCuerpo.\n",
    )
    .unwrap();
    let skill_b = install_skill(
        source_b.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    let link_a = links_dir_for(&shared_cwd.to_string_lossy(), "claude-code")
        .unwrap()
        .join(slug_from_source_path(&skill_a.source_path));
    let link_b = links_dir_for(&shared_cwd.to_string_lossy(), "claude-code")
        .unwrap()
        .join(slug_from_source_path(&skill_b.source_path));

    // Workspace A (abierto) attachea su skill a nivel workspace.
    attach_skill(
        skill_a.id.clone(),
        ws_a.clone(),
        "workspace".to_string(),
        None,
        state.clone(),
    )
    .unwrap();
    assert!(
        link_a.symlink_metadata().is_ok(),
        "la skill del workspace A debe estar en la carpeta"
    );

    // Attachear la skill de B mientras su ventana está cerrada no toca la carpeta:
    // las skills se materializan cuando el workspace está abierto, no antes.
    attach_skill(
        skill_b.id.clone(),
        "ws-b".to_string(),
        "tab".to_string(),
        Some("tab-b".to_string()),
        state.clone(),
    )
    .unwrap();
    assert!(
        link_b.symlink_metadata().is_err(),
        "un workspace cerrado no debe dejar skills en disco"
    );

    // Se cierra A y se abre B — el cambio de workspace que reportaba el bug.
    db_mark_window_closed("win".to_string(), state.clone()).unwrap();
    assert!(
        link_a.symlink_metadata().is_err(),
        "al cerrar A su skill debe salir de la carpeta"
    );

    {
        let conn = state.lock().unwrap();
        conn.execute("UPDATE windows SET is_open = 1 WHERE id = 'win-b'", [])
            .unwrap();
    }
    reconcile_tab_skills("tab-b".to_string(), state.clone()).unwrap();

    assert!(
        link_b.symlink_metadata().is_ok(),
        "la tab de B debe tener su propia skill"
    );
    assert!(
        link_a.symlink_metadata().is_err(),
        "y NINGUNA del workspace anterior"
    );

    // Volver a A restaura lo suyo y se lleva lo de B.
    {
        let conn = state.lock().unwrap();
        conn.execute("UPDATE windows SET is_open = 0 WHERE id = 'win-b'", [])
            .unwrap();
        conn.execute("UPDATE windows SET is_open = 1 WHERE label = 'win'", [])
            .unwrap();
    }
    reconcile_tab_skills(tab_a, state.clone()).unwrap();
    assert!(link_a.symlink_metadata().is_ok());
    assert!(link_b.symlink_metadata().is_err());
}

/// Un symlink que el usuario puso a mano en `.claude/skills/` (o una carpeta real)
/// no lo gestiona Control Code y la reconciliación no debe borrarlo.
#[test]
fn reconcile_leaves_user_owned_entries_alone() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let links_dir = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code").unwrap();
    std::fs::create_dir_all(&links_dir).unwrap();

    // Carpeta real con una skill propia del proyecto.
    let own = links_dir.join("skill-propia");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("SKILL.md"), "---\nname: propia\n---\nCuerpo.\n").unwrap();

    // Symlink a un destino fuera del directorio global de skills.
    let elsewhere = temp_dir("fuera-del-dir-global");
    let foreign_link = links_dir.join("skill-externa");
    symlink::symlink_dir(&elsewhere, &foreign_link).unwrap();

    let source = temp_dir("source-skill");
    write_source_skill(&source);
    let info = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();
    attach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id.clone()),
        state.clone(),
    )
    .unwrap();
    reconcile_tab_skills(tab_id.clone(), state.clone()).unwrap();

    assert!(
        own.join("SKILL.md").exists(),
        "la skill propia del proyecto debe sobrevivir"
    );
    assert!(
        foreign_link.symlink_metadata().is_ok(),
        "un symlink ajeno debe sobrevivir"
    );

    // Detachear se lleva SOLO la gestionada por Control Code.
    detach_skill(
        info.id.clone(),
        workspace_id,
        "tab".to_string(),
        Some(tab_id),
        state.clone(),
    )
    .unwrap();
    let managed = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code")
        .unwrap()
        .join(slug_from_source_path(&info.source_path));
    assert!(managed.symlink_metadata().is_err());
    assert!(own.join("SKILL.md").exists());
    assert!(foreign_link.symlink_metadata().is_ok());
}

/// Una TUI custom recibe skills en la carpeta que el usuario le declaró — y una que
/// no declaró ninguna simplemente se saltea, sin ensuciar el proyecto.
#[test]
fn custom_agents_get_skills_in_their_declared_folder() {
    let (db, workspace_id, _tab_id, _tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let configured_cwd = temp_dir("custom-configured");
    let bare_cwd = temp_dir("custom-bare");
    {
        let conn = state.lock().unwrap();
        conn.execute(
            "INSERT INTO custom_agents (id, label, command, skills_dir, session_id_from, env_json, created_at)
             VALUES ('mitui', 'Mi TUI', 'mitui', '.mitui/skills', 'filename', '{}', 0)",
            [],
        ).unwrap();
        // Misma TUI custom pero sin carpeta de skills declarada.
        conn.execute(
            "INSERT INTO custom_agents (id, label, command, session_id_from, env_json, created_at)
             VALUES ('sintui', 'Sin skills', 'sintui', 'filename', '{}', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
             VALUES ('tab-custom', 'win-test', 'Custom', 'mitui', 'Mi TUI', 'mitui', ?1, 0, 0, 0)",
            [configured_cwd.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute(
            "INSERT INTO tabs (id, window_id, title, agent_id, agent_label, command, cwd, opened_at, created_at, last_active)
             VALUES ('tab-bare', 'win-test', 'Bare', 'sintui', 'Sin skills', 'sintui', ?1, 0, 0, 0)",
            [bare_cwd.to_string_lossy().to_string()],
        ).unwrap();
    }

    let source = temp_dir("source-skill");
    write_source_skill(&source);
    let info = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();
    // La skill de prueba declara compatible_agents [claude-code, gemini-cli]; para que
    // aplique a una TUI custom hay que sacarle esa restricción (una skill sin agentes
    // declarados vale para cualquiera).
    {
        let conn = state.lock().unwrap();
        conn.execute(
            "UPDATE skills SET compatible_agents = '[]' WHERE id = ?1",
            [&info.id],
        )
        .unwrap();
    }

    // Attach a nivel workspace: aplica a las dos tabs.
    attach_skill(
        info.id.clone(),
        workspace_id.clone(),
        "workspace".to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    let slug = slug_from_source_path(&info.source_path);
    let custom_link = configured_cwd.join(".mitui").join("skills").join(&slug);
    assert!(
        custom_link.symlink_metadata().is_ok(),
        "la TUI custom debe recibir la skill en su carpeta declarada"
    );
    assert_eq!(
        std::fs::read_link(&custom_link).unwrap(),
        Path::new(&info.source_path)
    );

    // La que no declaró carpeta no debe haber recibido nada en ningún lado.
    assert!(
        std::fs::read_dir(&bare_cwd).unwrap().next().is_none(),
        "una TUI sin carpeta de skills declarada no debe dejar nada en el proyecto"
    );

    // Y el ciclo completo también funciona: detachear se lleva el symlink.
    detach_skill(
        info.id.clone(),
        workspace_id,
        "workspace".to_string(),
        None,
        state.clone(),
    )
    .unwrap();
    assert!(custom_link.symlink_metadata().is_err());
}

/// Ciclo del pedido: una sesión se cierra con dos skills, una se desinstala, y al
/// reabrirla la app sabe cuál falta, de dónde bajarla, y restaura las que sí están.
#[test]
fn archived_session_skills_are_checked_and_restored() {
    let (db, workspace_id, tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let source_a = temp_dir("kept-skill");
    write_source_skill(&source_a);
    let kept = install_skill(
        source_a.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    let source_b = temp_dir("gone-skill");
    std::fs::create_dir_all(&source_b).unwrap();
    std::fs::write(
        source_b.join("SKILL.md"),
        "---\nname: la-que-falta\ncompatible_agents: [claude-code]\n---\nCuerpo.\n",
    )
    .unwrap();
    let gone = install_skill(
        source_b.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    // La sesión archivada guarda id + nombre + scope de cada skill que tenía.
    {
        let conn = state.lock().unwrap();
        let archived = serde_json::json!([
            { "id": kept.id, "name": kept.name, "scope": "tab" },
            { "id": gone.id, "name": gone.name, "scope": "workspace" },
        ])
        .to_string();
        conn.execute(
            "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
             VALUES ('hist-1', ?1, 'claude-code', 'Claude Code', 'claude', ?2, 'Sesión vieja', 'sess-1', ?3, 0, 0)",
            rusqlite::params![workspace_id, tab_cwd.to_string_lossy(), archived],
        ).unwrap();
        // Un repo habilitado que SÍ ofrece la que se va a borrar.
        let cache = serde_json::json!([{
            "id": "la-que-falta", "registryId": "reg-1", "registryName": "Mi repo",
            "name": "la-que-falta", "description": null, "categories": [],
            "compatibleAgents": [], "folderPath": "la-que-falta", "files": []
        }])
        .to_string();
        conn.execute(
            "INSERT INTO registries (id, name, source_type, location, priority, enabled, cache_json, created_at)
             VALUES ('reg-1', 'Mi repo', 'github', 'alguien/repo', 0, 1, ?1, 0)",
            [cache],
        ).unwrap();
    }

    // Con las dos instaladas no falta nada.
    let statuses = check_session_skills("hist-1".to_string(), state.clone()).unwrap();
    assert_eq!(statuses.len(), 2);
    assert!(
        statuses.iter().all(|s| !s.is_missing()),
        "con ambas instaladas no debe faltar ninguna"
    );

    // Se desinstala una: ahora la app tiene que saber cuál falta y de dónde bajarla.
    delete_skill(gone.id.clone(), state.clone()).unwrap();
    let statuses = check_session_skills("hist-1".to_string(), state.clone()).unwrap();
    let missing: Vec<&SessionSkillStatus> = statuses.iter().filter(|s| s.is_missing()).collect();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].name, "la-que-falta");
    assert_eq!(
        missing[0]
            .available_from
            .as_ref()
            .map(|a| a.registry_name.as_str()),
        Some("Mi repo"),
        "debe decir en qué repositorio está para poder reinstalarla"
    );

    // Restaurar sobre la tab: se reattachea la que está y se reporta la que no.
    let still_missing =
        restore_session_skills("hist-1".to_string(), workspace_id, tab_id, state.clone()).unwrap();
    assert_eq!(still_missing, vec!["la-que-falta".to_string()]);

    let kept_link = links_dir_for(&tab_cwd.to_string_lossy(), "claude-code")
        .unwrap()
        .join(slug_from_source_path(&kept.source_path));
    assert!(
        kept_link.symlink_metadata().is_ok(),
        "la skill que sigue instalada debe quedar activa en la tab"
    );
}

/// El formato viejo del historial (array plano de nombres) se sigue leyendo: esas
/// entradas no tienen id, así que se resuelven por nombre contra lo instalado.
#[test]
fn legacy_archived_skill_names_still_resolve() {
    let (db, workspace_id, _tab_id, tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let source = temp_dir("legacy-skill");
    write_source_skill(&source);
    let info = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .unwrap();

    {
        let conn = state.lock().unwrap();
        conn.execute(
            "INSERT INTO session_history (id, workspace_id, agent_id, agent_label, command, cwd, title, session_id, skills, opened_at, closed_at)
             VALUES ('hist-legacy', ?1, 'claude-code', 'Claude Code', 'claude', ?2, NULL, NULL, '[\"git-commit-helper\"]', 0, 0)",
            rusqlite::params![workspace_id, tab_cwd.to_string_lossy()],
        ).unwrap();
    }

    let statuses = check_session_skills("hist-legacy".to_string(), state.clone()).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].name, "git-commit-helper");
    assert_eq!(
        statuses[0].installed_skill_id.as_deref(),
        Some(info.id.as_str())
    );
}

#[test]
fn preview_detects_missing_metadata_and_install_persists_overrides() {
    let (db, _workspace_id, _tab_id, _tab_cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    // SKILL.md sin ninguna metadata más allá del name — todo lo demás debe salir
    // como "missing" para que el frontend ofrezca completarlo (opcional).
    let source = temp_dir("bare-skill");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("SKILL.md"),
        "---\nname: bare-skill\n---\nCuerpo sin metadata.\n",
    )
    .unwrap();

    let preview =
        preview_skill_metadata(source.join("SKILL.md").to_string_lossy().to_string()).unwrap();
    assert!(preview.folder_name.starts_with("cc-skills-test-bare-skill"));
    for field in [
        "description",
        "version",
        "categories",
        "compatibleAgents",
        "author",
        "license",
        "homepage",
    ] {
        assert!(
            preview.missing.iter().any(|m| m == field),
            "{field} debería estar marcado como faltante"
        );
    }

    // Instalar SIN completar nada (opcional/skip): no debe fallar, y los campos
    // quedan vacíos tal cual — completar metadata nunca es obligatorio.
    let installed_bare = install_skill(
        source.join("SKILL.md").to_string_lossy().to_string(),
        None,
        state.clone(),
    )
    .expect("instalar sin completar metadata debe funcionar igual");
    assert_eq!(installed_bare.version, "0.1.0");
    assert!(installed_bare.categories.is_empty());

    // Instalar completando algunos campos sugeridos (el resto queda vacío/omitido).
    let source2 = temp_dir("bare-skill-2");
    std::fs::create_dir_all(&source2).unwrap();
    std::fs::write(
        source2.join("SKILL.md"),
        "---\nname: bare-skill-2\n---\nCuerpo sin metadata.\n",
    )
    .unwrap();
    let overrides = SkillFrontmatterInput {
        name: None,
        description: Some("Completada a mano por el usuario".to_string()),
        version: Some("2.0.0".to_string()),
        categories: vec!["testing".to_string()],
        compatible_agents: vec![],
        compatible_versions: HashMap::new(),
        author: None,
        license: None,
        homepage: None,
    };
    let installed = install_skill(
        source2.join("SKILL.md").to_string_lossy().to_string(),
        Some(overrides),
        state.clone(),
    )
    .expect("instalar con overrides parciales debe funcionar");
    assert_eq!(
        installed.description.as_deref(),
        Some("Completada a mano por el usuario")
    );
    assert_eq!(installed.version, "2.0.0");
    assert_eq!(installed.categories, vec!["testing"]);

    // El archivo instalado (la copia global) debe reflejar en disco lo completado.
    let written =
        std::fs::read_to_string(Path::new(&installed.source_path).join("SKILL.md")).unwrap();
    assert!(written.contains("version: 2.0.0"));
    assert!(written.contains("Completada a mano por el usuario"));
    assert!(
        written.contains("Cuerpo sin metadata."),
        "el body original debe preservarse"
    );
}

// ── Skills que viajan con la app ────────────────────────────────

fn record(version: &str) -> Provisioned {
    Provisioned {
        version: version.into(),
        path: "/skills/control-code/orq".into(),
    }
}

/// El arranque normal: ya está instalada y al día. Tiene que ser un no-op — si no,
/// cada apertura de la app reescribiría archivos por gusto.
#[test]
fn an_up_to_date_skill_is_left_alone() {
    assert_eq!(
        decide(Some(&record("1.1.0")), Some("1.1.0"), "1.1.0"),
        Action::Skip
    );
}

#[test]
fn a_first_run_installs_it() {
    assert_eq!(decide(None, None, "1.1.0"), Action::Install);
}

/// Lo que motivó todo esto: la app pasó a traer 1.1.0 y en disco quedó la 1.0.0
/// describiendo comandos que ya no existen.
#[test]
fn a_new_version_replaces_the_installed_copy() {
    assert_eq!(
        decide(Some(&record("1.0.0")), Some("1.0.0"), "1.1.0"),
        Action::Update
    );
}

/// Si el usuario la borra, borrada se queda. Reinstalarla en cada arranque haría que
/// el botón de borrar no sirviera para nada.
#[test]
fn a_skill_the_user_deleted_does_not_come_back() {
    assert_eq!(decide(Some(&record("1.1.0")), None, "1.1.0"), Action::Skip);
}

/// …pero una versión nueva sí se vuelve a ofrecer: es contenido distinto del que el
/// usuario descartó, y es la única forma de que una app actualizada lo entregue.
#[test]
fn a_new_version_is_offered_again_even_after_a_deletion() {
    assert_eq!(
        decide(Some(&record("1.0.0")), None, "1.1.0"),
        Action::Install
    );
}

/// Skill de mentira en una carpeta temporal, para no depender de la real.
fn fake_skill(version: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("cc-bundled-src-{}", uuid::Uuid::new_v4()))
        .join("mi-skill");
    std::fs::create_dir_all(&dir).unwrap();
    write_version(&dir, version);
    dir
}

fn write_version(dir: &Path, version: &str) {
    std::fs::write(
        dir.join("SKILL.md"),
        format!(
            "---\nname: mi-skill\ndescription: prueba\nversion: {version}\n\
             compatible_agents: [claude-code]\n---\n\n# Cuerpo v{version}\n"
        ),
    )
    .unwrap();
}

fn bundled_db() -> (DbConnection, PathBuf) {
    let conn = crate::database::test_db();
    let store = std::env::temp_dir().join(format!("cc-bundled-store-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&store).unwrap();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)",
        [store.to_string_lossy()],
    )
    .unwrap();
    (std::sync::Arc::new(std::sync::Mutex::new(conn)), store)
}

fn installed_rows(db: &DbConnection) -> Vec<(String, String, String)> {
    let conn = db.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT name, version, source_path FROM skills ORDER BY name")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    rows.filter_map(|r| r.ok()).collect()
}

/// El ciclo completo contra disco y base: instalar, no duplicar, actualizar y respetar
/// el borrado. Es el comportamiento que ve el usuario cada vez que abre la app.
#[test]
fn the_provisioning_lifecycle() {
    let source = fake_skill("1.0.0");
    let (db, store) = bundled_db();

    // 1. Primer arranque: se instala.
    ensure_one(&db, "mi-skill", &source).unwrap();
    let rows = installed_rows(&db);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "1.0.0");
    let dest = PathBuf::from(&rows[0].2);
    assert!(
        dest.join("SKILL.md").is_file(),
        "la copia global tiene que existir"
    );
    assert!(
        dest.starts_with(&store),
        "tiene que quedar dentro del store configurado"
    );
    assert!(std::fs::read_to_string(dest.join("SKILL.md"))
        .unwrap()
        .contains("Cuerpo v1.0.0"));

    // 2. Arranques siguientes: no se duplica ni se reescribe.
    ensure_one(&db, "mi-skill", &source).unwrap();
    ensure_one(&db, "mi-skill", &source).unwrap();
    assert_eq!(
        installed_rows(&db).len(),
        1,
        "no puede instalarse de nuevo en cada arranque"
    );

    // 3. La app trae una versión nueva: se pisa la copia y se actualiza la fila.
    write_version(&source, "2.0.0");
    ensure_one(&db, "mi-skill", &source).unwrap();
    let rows = installed_rows(&db);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "2.0.0");
    assert_eq!(
        rows[0].2,
        dest.to_string_lossy(),
        "la ruta no debería moverse"
    );
    assert!(
        std::fs::read_to_string(dest.join("SKILL.md"))
            .unwrap()
            .contains("Cuerpo v2.0.0"),
        "los archivos tienen que quedar los de la versión nueva"
    );

    // 4. El usuario la borra: no vuelve sola.
    db.lock()
        .unwrap()
        .execute("DELETE FROM skills", [])
        .unwrap();
    std::fs::remove_dir_all(&dest).ok();
    ensure_one(&db, "mi-skill", &source).unwrap();
    assert!(
        installed_rows(&db).is_empty(),
        "borrada por el usuario, borrada se queda"
    );

    // 5. …pero una versión nueva sí se vuelve a ofrecer.
    write_version(&source, "3.0.0");
    ensure_one(&db, "mi-skill", &source).unwrap();
    assert_eq!(installed_rows(&db).len(), 1);
    assert_eq!(installed_rows(&db)[0].1, "3.0.0");
}

/// Los archivos que la versión nueva ya no trae no deben sobrevivir en la copia global:
/// si no, lo instalado deja de ser igual a lo que trae la app.
#[test]
fn an_update_removes_files_the_new_version_dropped() {
    let source = fake_skill("1.0.0");
    let (db, _store) = bundled_db();
    std::fs::write(source.join("viejo.md"), "sobra").unwrap();

    ensure_one(&db, "mi-skill", &source).unwrap();
    let dest = PathBuf::from(&installed_rows(&db)[0].2);
    assert!(dest.join("viejo.md").is_file());

    std::fs::remove_file(source.join("viejo.md")).unwrap();
    write_version(&source, "2.0.0");
    ensure_one(&db, "mi-skill", &source).unwrap();
    assert!(!dest.join("viejo.md").exists());
}

/// La skill del repo tiene que ser instalable: frontmatter parseable y con versión.
/// Si alguien la edita y rompe el YAML, esto lo dice antes de que se note en runtime
/// (donde el fallo es silencioso a propósito).
#[test]
fn the_bundled_skill_in_the_repo_is_valid() {
    for name in BUNDLED {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../skills")
            .join(name);
        let skill_md = dir.join("SKILL.md");
        assert!(skill_md.is_file(), "falta {}", skill_md.display());

        let (meta, _) = scan_skill_file(&skill_md).expect("SKILL.md ilegible");
        assert_eq!(
            meta.name.as_deref(),
            Some(*name),
            "el name del frontmatter tiene que coincidir con la carpeta"
        );
        assert!(
            meta.version.is_some(),
            "sin version no se puede detectar una actualización"
        );
        assert!(
            meta.description.is_some(),
            "la description es lo que lee el agente para decidir usarla"
        );
        assert!(!meta.compatible_agents.is_empty());
    }
}

// ── Identidad: el nombre NO identifica ───────────────────────────

/// EL bug: dos skills homónimas de repos (o autores) distintos son cosas distintas.
/// Instalar una no puede contar como tener la otra, ni pisarla al reinstalar.
#[test]
fn dos_homonimas_de_repos_distintos_conviven_con_su_origen_registrado() {
    let (db, _ws, _tab, _cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let src_a = temp_dir("autor-a");
    let src_b = temp_dir("autor-b");
    write_named_skill(&src_a, "testing", "la de anthropics");
    write_named_skill(&src_b, "testing", "la de midudev");

    let a = install_skill_internal(
        &src_a.join("SKILL.md").to_string_lossy(),
        None,
        Some(SkillOrigin {
            registry_id: "reg-a",
            registry_name: "anthropics/skills",
            skill_id: "document-skills/testing",
        }),
        &state,
    )
    .expect("instalar la primera");
    let b = install_skill_internal(
        &src_b.join("SKILL.md").to_string_lossy(),
        None,
        Some(SkillOrigin {
            registry_id: "reg-b",
            registry_name: "autoskills",
            skill_id: "midudev/skills/testing",
        }),
        &state,
    )
    .expect("instalar la segunda");

    assert_ne!(a.id, b.id, "son dos skills distintas");
    assert_eq!(a.origin_skill_id.as_deref(), Some("document-skills/testing"));
    assert_eq!(b.origin_skill_id.as_deref(), Some("midudev/skills/testing"));
    assert_eq!(count_skills(&state), 2, "ninguna pisó a la otra");
}

/// Reinstalar la MISMA entrada del MISMO repo actualiza en vez de acumular copias — y
/// conserva el id, así que los attachments que cuelgan de él sobreviven.
#[test]
fn reinstalar_la_misma_entrada_actualiza_en_vez_de_duplicar() {
    let (db, workspace_id, tab_id, _cwd, _skills_dir) = setup();
    let app = tauri::test::mock_app();
    app.manage(db);
    let state = app.state::<DbConnection>();

    let src = temp_dir("repetida");
    write_named_skill(&src, "testing", "version uno");
    let origin = SkillOrigin {
        registry_id: "reg-a",
        registry_name: "anthropics/skills",
        skill_id: "testing",
    };

    let primera = install_skill_internal(
        &src.join("SKILL.md").to_string_lossy(),
        None,
        Some(origin),
        &state,
    )
    .expect("instalar");
    attach_skill(
        primera.id.clone(),
        workspace_id.clone(),
        "tab".to_string(),
        Some(tab_id),
        state.clone(),
    )
    .expect("attach");

    write_named_skill(&src, "testing", "version dos");
    let segunda = install_skill_internal(
        &src.join("SKILL.md").to_string_lossy(),
        None,
        Some(origin),
        &state,
    )
    .expect("reinstalar");

    assert_eq!(segunda.id, primera.id, "conserva el id: los attachments cuelgan de él");
    assert_eq!(count_skills(&state), 1, "no quedó una segunda copia");
    assert_eq!(
        count(&state, "SELECT COUNT(*) FROM project_skills"),
        1,
        "el attachment sobrevive a la actualización"
    );
    let contenido =
        std::fs::read_to_string(Path::new(&segunda.source_path).join("SKILL.md")).unwrap();
    assert!(contenido.contains("version dos"), "quedó el contenido nuevo: {contenido}");
}

fn count(db: &DbConnection, sql: &str) -> i64 {
    db.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

fn count_skills(db: &DbConnection) -> i64 {
    count(db, "SELECT COUNT(*) FROM skills")
}
