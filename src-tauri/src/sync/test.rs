use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::export::{export, Pending, PRELAUNCH_DOC, PREFS_DOC};
use super::import::{apply_db, apply_skills, Applied};
use super::repo;
use super::tree::{doc, groups, json_bytes, merge3, Tree, Winner};

fn t(entries: &[(&str, &str)]) -> Tree {
    entries.iter().map(|(p, c)| (p.to_string(), c.as_bytes().to_vec())).collect()
}

fn j(v: Value) -> Vec<u8> {
    json_bytes(&v)
}

// ── la mezcla ────────────────────────────────────────────────────────────────────

#[test]
fn lo_que_cambio_un_solo_lado_gana() {
    let base = t(&[("skills/a/SKILL.md", "v1"), ("skills/b/SKILL.md", "b")]);
    let local = t(&[("skills/a/SKILL.md", "v2"), ("skills/b/SKILL.md", "b")]);
    let remote = t(&[("skills/a/SKILL.md", "v1")]); // otra máquina borró b
    let (merged, conflicts) = merge3(&base, &local, &remote, Winner::Local);
    assert_eq!(merged, t(&[("skills/a/SKILL.md", "v2")]));
    assert!(conflicts.is_empty());
}

#[test]
fn los_json_se_mezclan_por_clave() {
    let base = [(PRELAUNCH_DOC.to_string(), j(json!({ "conda": "conda activate ml" })))].into();
    let local = [(PRELAUNCH_DOC.to_string(), j(json!({ "conda": "conda activate ml", "nvm": "nvm use 22" })))].into();
    let remote = [(PRELAUNCH_DOC.to_string(), j(json!({ "conda": "conda activate ml", "venv": ". .venv/bin/activate" })))].into();
    let (merged, conflicts) = merge3(&base, &local, &remote, Winner::Local);
    let got = doc(&merged, PRELAUNCH_DOC);
    assert_eq!(got.len(), 3, "las dos máquinas agregaron algo distinto: quedan las dos cosas");
    assert!(conflicts.is_empty());
}

#[test]
fn un_conflicto_lo_gana_esta_maquina_salvo_la_primera_vez() {
    let base: Tree = [(PREFS_DOC.to_string(), j(json!({ "theme": "dark" })))].into();
    let local: Tree = [(PREFS_DOC.to_string(), j(json!({ "theme": "light" })))].into();
    let remote: Tree = [(PREFS_DOC.to_string(), j(json!({ "theme": "system" })))].into();

    let (merged, conflicts) = merge3(&base, &local, &remote, Winner::Local);
    assert_eq!(doc(&merged, PREFS_DOC)["theme"], "light");
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].path, "config/preferences.json#theme");

    // Primera vez: no hay base, y la configuración de fábrica de la máquina nueva no puede
    // pisar la del usuario.
    let (merged, _) = merge3(&Tree::new(), &local, &remote, Winner::Remote);
    assert_eq!(doc(&merged, PREFS_DOC)["theme"], "system");
}

#[test]
fn modificar_le_gana_a_borrar() {
    let base = t(&[("skills/a/SKILL.md", "v1")]);
    let local = t(&[]); // acá se borró
    let remote = t(&[("skills/a/SKILL.md", "v2")]); // allá se editó
    let (merged, conflicts) = merge3(&base, &local, &remote, Winner::Local);
    assert_eq!(merged, remote);
    assert!(conflicts.is_empty());
}

// ── dos máquinas contra un repo de verdad ──────────────────────────────────────────

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

struct Machine {
    db: crate::database::DbConnection,
    data: PathBuf,
}

impl Machine {
    fn new(root: &Path, name: &str) -> Machine {
        let data = root.join(name);
        std::fs::create_dir_all(data.join("skills")).unwrap();
        let conn = crate::database::test_db();
        conn.execute("INSERT INTO settings (key, value) VALUES ('skills_dir', ?1)", [data.join("skills").to_string_lossy().to_string()])
            .unwrap();
        Machine { db: std::sync::Arc::new(std::sync::Mutex::new(conn)), data }
    }

    fn preset(&self, name: &str, command: &str) {
        self.db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO prelaunch_presets (id, name, command, created_at) VALUES (?1, ?2, ?3, 0)",
                [name, name, command],
            )
            .unwrap();
    }

    fn presets(&self) -> Vec<(String, String)> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT name, command FROM prelaunch_presets ORDER BY name").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect()
    }

    fn skill(&self, folder: &str, body: &str) {
        let dir = self.data.join("skills").join("local").join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), format!("---\nname: {folder}\ndescription: test\n---\n{body}\n")).unwrap();
        self.db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO skills (id, name, source_path, installed_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)",
                [folder, folder, dir.to_string_lossy().as_ref()],
            )
            .unwrap();
    }

    fn skill_names(&self) -> Vec<String> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT name FROM skills ORDER BY name").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().flatten().collect()
    }

    /// Lo mismo que hace `sync_now`, sin la parte de la app (marketplace, AppHandle).
    fn sync(&self, base: Option<String>) -> (Applied, String, bool) {
        let dir = repo::repo_dir(&self.data);
        repo::fetch(&dir, &[]).unwrap();
        let remote_rev = repo::remote_head(&dir);
        let base_tree = repo::read_tree(&dir, base.as_deref()).unwrap();
        let remote = repo::read_tree(&dir, remote_rev.as_deref()).unwrap();
        let local = export(&self.db.lock().unwrap(), &Map::new(), &base_tree, &Pending::default()).unwrap();
        let first = base.is_none() && remote_rev.is_some();
        let (merged, _) = merge3(&base_tree, &local.tree, &remote, if first { Winner::Remote } else { Winner::Local });
        repo::reset_to(&dir, remote_rev.as_deref()).unwrap();
        repo::write_tree(&dir, &merged).unwrap();
        if repo::commit_all(&dir, "test").unwrap().is_some() {
            assert!(matches!(repo::push(&dir, &[]).unwrap(), repo::Push::Done));
        }
        let mut applied = Applied::default();
        apply_db(&self.db.lock().unwrap(), &merged, &local.tree, &mut applied).unwrap();
        apply_skills(&self.db, &self.data, &merged, &local, &mut applied);
        (applied, repo::head(&dir).unwrap(), first)
    }
}

#[test]
fn dos_maquinas_se_pasan_skills_y_configuracion_por_el_repo() {
    let root = std::env::temp_dir().join(format!("cc-sync-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let origin = root.join("origin.git");
    git(&root, &["init", "-q", "--bare", "-b", "main", &origin.to_string_lossy()]);
    let url = origin.to_string_lossy().to_string();

    // La máquina A arranca con cosas propias y es la primera en subir.
    let a = Machine::new(&root, "a");
    a.preset("conda", "conda activate ml");
    a.skill("mi-skill", "hola");
    repo::clone(&a.data.join("sync"), &url, &[]).unwrap();
    let (_, a_base, a_first) = a.sync(None);
    assert!(!a_first, "el repo estaba vacío: no es 'recién llega'");

    // La máquina B es nueva: tiene su propio preset de fábrica y se conecta al repo.
    let b = Machine::new(&root, "b");
    b.preset("nvm", "nvm use 22");
    repo::clone(&b.data.join("sync"), &url, &[]).unwrap();
    let (applied, b_base, b_first) = b.sync(None);
    assert!(b_first);
    assert!(applied.failures.is_empty(), "{:?}", applied.failures);
    assert_eq!(b.presets(), vec![("conda".into(), "conda activate ml".into()), ("nvm".into(), "nvm use 22".into())]);
    assert_eq!(b.skill_names(), vec!["mi-skill"]);
    let installed = b.data.join("skills").join("local").join("mi-skill").join("SKILL.md");
    assert!(std::fs::read_to_string(&installed).unwrap().contains("hola"), "se instala con su nombre de carpeta");

    // A trae lo de B, después borra su skill; el borrado llega a B.
    let (_, a_base, _) = a.sync(Some(a_base));
    assert_eq!(a.presets().len(), 2);
    let id: String = a.db.lock().unwrap().query_row("SELECT id FROM skills", [], |r| r.get(0)).unwrap();
    crate::skills::delete_skill_internal(&id, &a.db).unwrap();
    let _ = a.sync(Some(a_base));
    let (applied, _, _) = b.sync(Some(b_base));
    assert!(b.skill_names().is_empty(), "{:?}", applied);
    let repo_tree = repo::read_tree(&repo::repo_dir(&b.data), Some("HEAD")).unwrap();
    assert!(groups(&repo_tree, "skills/").is_empty());
    // Y nada de esta máquina que no deba viajar.
    let flat: String = repo_tree.keys().cloned().collect::<Vec<_>>().join(" ");
    assert!(!flat.contains("git-secrets") && !flat.contains("accounts"), "{flat}");

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn las_variables_de_entorno_de_una_tui_propia_no_se_suben() {
    let conn = crate::database::test_db();
    conn.execute(
        "INSERT INTO custom_agents (id, label, command, env_json, created_at) VALUES ('x', 'Mi TUI', 'mitui', '{\"API_KEY\":\"sk-secreto\"}', 0)",
        [],
    )
    .unwrap();
    let local = export(&conn, &Map::new(), &Tree::new(), &Pending::default()).unwrap();
    let everything: Vec<u8> = local.tree.values().flatten().copied().collect();
    let text = String::from_utf8_lossy(&everything);
    assert!(text.contains("Mi TUI"));
    assert!(!text.contains("sk-secreto") && !text.contains("API_KEY"), "{text}");
}

/// Una skill de un repositorio que esta máquina no pudo instalar (skills.sh sin Node) sigue
/// en el repo: si no, la próxima sincronización la vería borrada y la borraría para todas.
#[test]
fn lo_que_no_se_pudo_instalar_aca_sigue_en_el_repo() {
    let conn = crate::database::test_db();
    let key = "skillssh:#owner/repo/tauri-v2";
    let base: Tree = [(
        super::export::MARKET_DOC.to_string(),
        j(json!({ "registries": {}, "skills": { key: { "name": "tauri-v2", "registry": "skillssh:", "entryId": "owner/repo/tauri-v2" } } })),
    )]
    .into();
    let pending = Pending { marketplace: [key.to_string()].into(), ..Default::default() };
    let local = export(&conn, &Map::new(), &base, &pending).unwrap();
    assert!(doc(&local.tree, super::export::MARKET_DOC)["skills"].get(key).is_some());
    let without = export(&conn, &Map::new(), &base, &Pending::default()).unwrap();
    assert!(doc(&without.tree, super::export::MARKET_DOC)["skills"].get(key).is_none());
}
