use super::git::{classify_failure, ScmError};
use super::parse::{
    parse_branches, parse_log, parse_name_status, parse_refs, parse_status_v2, RefKind, ScmEntry, BRANCH_FORMAT,
    LOG_FORMAT,
};
use super::remote::{host_and_path, parse_remotes, provider_of, remote_from, Provider};

fn entry(path: &str, status: &str) -> ScmEntry {
    ScmEntry { path: path.to_string(), orig_path: None, status: status.to_string() }
}

// ── git status --porcelain=v2 ────────────────────────────────────

#[test]
fn lee_rama_upstream_y_adelanto() {
    let raw = "# branch.oid 4f2a9c1e8b7d6a5f\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -5\0";
    let s = parse_status_v2(raw);
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert_eq!(s.head.as_deref(), Some("4f2a9c1"));
    assert_eq!(s.upstream.as_deref(), Some("origin/main"));
    assert_eq!((s.ahead, s.behind), (2, 5));
    assert!(!s.initial && !s.detached);
}

#[test]
fn un_repo_sin_commits_y_un_head_desprendido_se_distinguen() {
    let s = parse_status_v2("# branch.oid (initial)\0# branch.head main\0");
    assert!(s.initial);
    assert_eq!(s.head, None);

    let s = parse_status_v2("# branch.oid abcdef1234\0# branch.head (detached)\0");
    assert!(s.detached);
    assert_eq!(s.branch, None);
}

#[test]
fn un_archivo_puede_estar_preparado_y_modificado_a_la_vez() {
    // `MM`: preparado con un cambio y vuelto a tocar después. Tiene que aparecer en los dos
    // grupos, como en cualquier cliente de git.
    let raw = "1 MM N... 100644 100644 100644 aaa bbb src/app.ts\0";
    let s = parse_status_v2(raw);
    assert_eq!(s.staged, vec![entry("src/app.ts", "M")]);
    assert_eq!(s.unstaged, vec![entry("src/app.ts", "M")]);
}

#[test]
fn las_rutas_con_espacios_llegan_enteras() {
    let raw = "1 .M N... 100644 100644 100644 aaa bbb docs/mi archivo final.md\0? notas de hoy.txt\0";
    let s = parse_status_v2(raw);
    assert_eq!(s.unstaged, vec![entry("docs/mi archivo final.md", "M")]);
    assert_eq!(s.untracked, vec![entry("notas de hoy.txt", "?")]);
    assert!(s.staged.is_empty());
}

#[test]
fn un_renombre_trae_su_origen_sin_desincronizar_lo_que_sigue() {
    // Con `-z` la ruta vieja viene como registro aparte; si no se consume, se leería como
    // otra entrada y todo lo de después quedaría corrido.
    let raw = "2 R. N... 100644 100644 100644 aaa bbb R100 src/nuevo.ts\0src/viejo.ts\0? suelto.txt\0";
    let s = parse_status_v2(raw);
    assert_eq!(s.staged.len(), 1);
    assert_eq!(s.staged[0].path, "src/nuevo.ts");
    assert_eq!(s.staged[0].orig_path.as_deref(), Some("src/viejo.ts"));
    assert_eq!(s.staged[0].status, "R");
    assert_eq!(s.untracked, vec![entry("suelto.txt", "?")]);
}

#[test]
fn los_conflictos_van_aparte() {
    let raw = "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/choque.rs\0";
    let s = parse_status_v2(raw);
    assert_eq!(s.conflicted, vec![entry("src/choque.rs", "U")]);
    assert!(s.staged.is_empty() && s.unstaged.is_empty());
}

#[test]
fn un_borrado_preparado_es_d_en_preparados() {
    let s = parse_status_v2("1 D. N... 100644 000000 000000 aaa 000 viejo.txt\0");
    assert_eq!(s.staged, vec![entry("viejo.txt", "D")]);
}

// ── ramas y log ──────────────────────────────────────────────────

#[test]
fn las_ramas_locales_van_primero_y_origin_head_no_aparece() {
    let sep = '\u{1f}';
    let raw = [
        format!("refs/remotes/origin/HEAD{sep}origin/HEAD{sep}{sep}100{sep} "),
        format!("refs/remotes/origin/feat{sep}origin/feat{sep}{sep}300{sep} "),
        format!("refs/heads/vieja{sep}vieja{sep}{sep}50{sep} "),
        format!("refs/heads/main{sep}main{sep}origin/main{sep}200{sep}*"),
    ]
    .join("\n");
    let branches = parse_branches(&raw);
    let names: Vec<_> = branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["main", "vieja", "origin/feat"]);
    assert!(branches[0].current);
    assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
    assert!(branches[2].remote);
    assert!(BRANCH_FORMAT.contains("%1f"));
}

#[test]
fn un_asunto_con_separadores_comunes_no_rompe_el_log() {
    let raw = "abc123\u{1f}abc\u{1f}p1 p2\u{1f}Ana\u{1f}1700000000\u{1f}HEAD -> main\u{1f}fix: a | b, c; d\u{1e}\ndef456\u{1f}def\u{1f}\u{1f}Luis\u{1f}1700000100\u{1f}\u{1f}feat: otra\u{1e}";
    let log = parse_log(raw, &[]);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].subject, "fix: a | b, c; d");
    assert_eq!(log[0].parents, vec!["p1", "p2"]);
    assert!(log[1].parents.is_empty(), "el primer commit no tiene padres");
    assert_eq!(log[1].author, "Luis");
    assert_eq!(log[1].time, 1_700_000_100);
    assert!(LOG_FORMAT.ends_with("%x1e"));
}

#[test]
fn las_referencias_se_clasifican_por_lo_que_son() {
    let remotes = vec!["origin".to_string()];
    let refs = parse_refs("HEAD -> feat/x, origin/feat/x, origin/HEAD, tag: v1.7.3, fix/y", &remotes);
    let kinds: Vec<(&str, RefKind)> = refs.iter().map(|r| (r.name.as_str(), r.kind)).collect();
    assert_eq!(kinds, vec![
        ("feat/x", RefKind::Head),
        ("origin/feat/x", RefKind::Remote),
        ("v1.7.3", RefKind::Tag),
        // Tiene barra pero no empieza con un remoto: es una rama local.
        ("fix/y", RefKind::Local),
    ]);
}

#[test]
fn los_archivos_de_un_commit_con_renombres() {
    let raw = "M\0src/a.ts\0R087\0viejo.ts\0nuevo.ts\0A\0b.ts\0";
    let files = parse_name_status(raw);
    assert_eq!(files.len(), 3);
    assert_eq!(files[1].path, "nuevo.ts");
    assert_eq!(files[1].orig_path.as_deref(), Some("viejo.ts"));
    assert_eq!(files[1].status, "R");
}

// ── remotos y proveedores ────────────────────────────────────────

#[test]
fn se_entienden_las_tres_formas_de_escribir_un_remoto() {
    assert_eq!(host_and_path("https://github.com/luis3132/ControlCode.git"),
               Some(("github.com".into(), "luis3132/ControlCode.git".into())));
    assert_eq!(host_and_path("git@gitlab.com:grupo/sub/repo.git"),
               Some(("gitlab.com".into(), "grupo/sub/repo.git".into())));
    assert_eq!(host_and_path("ssh://git@bitbucket.org:22/equipo/repo.git"),
               Some(("bitbucket.org".into(), "equipo/repo.git".into())));
    assert_eq!(host_and_path("https://usuario:token@GitHub.com/a/b"),
               Some(("github.com".into(), "a/b".into())));
}

#[test]
fn una_ruta_local_no_se_confunde_con_un_host() {
    assert_eq!(host_and_path("/srv/git/repo.git"), None);
    assert_eq!(host_and_path("C:\\repos\\app"), None);
}

#[test]
fn el_proveedor_sale_del_host() {
    assert_eq!(provider_of("github.com"), Provider::Github);
    assert_eq!(provider_of("gitlab.com"), Provider::Gitlab);
    assert_eq!(provider_of("gitlab.miempresa.com"), Provider::Gitlab);
    assert_eq!(provider_of("ssh.dev.azure.com"), Provider::Azure);
    assert_eq!(provider_of("codeberg.org"), Provider::Codeberg);
    assert_eq!(provider_of("git.miempresa.com"), Provider::Other);
}

#[test]
fn la_pagina_web_del_repo_se_deduce_solo_cuando_es_segura() {
    let gh = remote_from("origin", "git@github.com:luis3132/ControlCode.git");
    assert_eq!(gh.web_url.as_deref(), Some("https://github.com/luis3132/ControlCode"));

    let ssh_alias = remote_from("origin", "ssh://git@ssh.github.com:443/a/b.git");
    assert_eq!(ssh_alias.web_url.as_deref(), Some("https://github.com/a/b"));

    // Un servidor genérico puede tener la web en cualquier lado: no se inventa.
    let otro = remote_from("origin", "git@git.miempresa.com:equipo/app.git");
    assert_eq!(otro.web_url, None);
    assert_eq!(otro.provider, Provider::Other);
}

#[test]
fn cada_remoto_aparece_una_sola_vez() {
    let raw = "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nupstream\thttps://gitlab.com/c/d.git (fetch)\nupstream\thttps://gitlab.com/c/d.git (push)\n";
    let remotes = parse_remotes(raw);
    assert_eq!(remotes.len(), 2);
    assert_eq!(remotes[1].name, "upstream");
    assert_eq!(remotes[1].provider, Provider::Gitlab);
}

// ── errores ──────────────────────────────────────────────────────

#[test]
fn la_falta_de_credenciales_se_distingue_del_resto() {
    // Es la que el login va a resolver; hoy la UI explica cómo darle credenciales a git.
    let auth = classify_failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    assert!(matches!(auth, ScmError::Auth(_)));
    let ssh = classify_failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
    assert!(matches!(ssh, ScmError::Auth(_)));
    let otro = classify_failure("error: Your local changes to the following files would be overwritten by checkout");
    assert!(matches!(otro, ScmError::Git(_)));
}

// ── Contra un repo de verdad ─────────────────────────────────────
//
// Lo de arriba prueba la lectura de salidas; esto prueba que los comandos que se arman
// son los que git acepta (flags, orden, `--`) en un repo real.

use super::commands::{
    parse_shortstat, scm_branches, scm_checkout, scm_compare, scm_commit, scm_discard, scm_file_at, scm_log, scm_stage, scm_status, scm_unstage,
};

fn git_in(dir: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn temp_repo(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-scm-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git_in(&dir, &["init", "-q", "-b", "main"]);
    git_in(&dir, &["config", "user.email", "test@controlcode.dev"]);
    git_in(&dir, &["config", "user.name", "Control Code"]);
    git_in(&dir, &["config", "commit.gpgsign", "false"]);
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn el_ciclo_completo_en_un_repo_real() {
    let dir = temp_repo("ciclo");
    let root = std::fs::canonicalize(&dir).unwrap().to_string_lossy().to_string();

    // Sin commits: un archivo nuevo aparece sin seguimiento.
    std::fs::write(dir.join("app.ts"), "uno\n").unwrap();
    std::fs::write(dir.join("con espacio.md"), "hola\n").unwrap();
    let st = scm_status(root.clone()).await.unwrap().expect("es un repo");
    assert!(st.info.initial);
    assert_eq!(st.info.untracked.len(), 2);

    // Preparar uno y sacarlo en un repo sin HEAD (el camino de `rm --cached`).
    scm_stage(root.clone(), vec!["app.ts".into()]).await.unwrap();
    let st = scm_status(root.clone()).await.unwrap().unwrap();
    assert_eq!(st.info.staged.len(), 1);
    scm_unstage(root.clone(), vec!["app.ts".into()]).await.unwrap();
    let st = scm_status(root.clone()).await.unwrap().unwrap();
    assert!(st.info.staged.is_empty());

    // Commit sin nada preparado = preparar todo.
    scm_commit(root.clone(), "primero".into(), true).await.unwrap();
    let st = scm_status(root.clone()).await.unwrap().unwrap();
    assert!(!st.info.initial);
    assert_eq!(st.info.branch.as_deref(), Some("main"));
    assert!(st.info.staged.is_empty() && st.info.unstaged.is_empty() && st.info.untracked.is_empty());

    // Modificar, preparar, volver a tocar: aparece en los dos grupos; sacar de preparados
    // con HEAD usa `restore --staged`.
    std::fs::write(dir.join("app.ts"), "dos\n").unwrap();
    scm_stage(root.clone(), vec![]).await.unwrap();
    std::fs::write(dir.join("app.ts"), "tres\n").unwrap();
    let st = scm_status(root.clone()).await.unwrap().unwrap();
    assert_eq!(st.info.staged.len(), 1);
    assert_eq!(st.info.unstaged.len(), 1);
    assert_eq!(scm_file_at(root.clone(), "app.ts".into(), "HEAD".into()).await.unwrap().as_deref(), Some("uno\n"));
    assert_eq!(scm_file_at(root.clone(), "app.ts".into(), "INDEX".into()).await.unwrap().as_deref(), Some("dos\n"));
    assert_eq!(scm_file_at(root.clone(), "no-existe.ts".into(), "HEAD".into()).await.unwrap(), None);

    // Descartar lo no preparado vuelve a lo preparado, sin tocarlo.
    scm_discard(root.clone(), vec!["app.ts".into()], vec![]).await.unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("app.ts")).unwrap(), "dos\n");
    scm_unstage(root.clone(), vec![]).await.unwrap();
    let st = scm_status(root.clone()).await.unwrap().unwrap();
    assert!(st.info.staged.is_empty());
    assert_eq!(st.info.unstaged.len(), 1);

    // Descartar un archivo nuevo lo borra.
    std::fs::write(dir.join("borrador.txt"), "x").unwrap();
    scm_discard(root.clone(), vec![], vec!["borrador.txt".into()]).await.unwrap();
    assert!(!dir.join("borrador.txt").exists());

    // Ramas: crear, volver, y el nombre que empieza con guion no llega a git.
    scm_commit(root.clone(), "segundo".into(), true).await.unwrap();
    scm_checkout(root.clone(), "feat/nueva".into(), true, false).await.unwrap();
    assert_eq!(scm_status(root.clone()).await.unwrap().unwrap().info.branch.as_deref(), Some("feat/nueva"));
    scm_checkout(root.clone(), "main".into(), false, false).await.unwrap();
    let branches = scm_branches(root.clone()).await.unwrap();
    assert!(branches.iter().any(|b| b.name == "main" && b.current));
    assert!(branches.iter().any(|b| b.name == "feat/nueva" && !b.current));
    assert!(scm_checkout(root.clone(), "-f".into(), false, false).await.is_err());
    assert!(scm_checkout(root.clone(), "no válida..".into(), true, false).await.is_err());

    let log = scm_log(root.clone(), 10).await.unwrap();
    assert_eq!(log.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["segundo", "primero"]);

    // Un commit con el mensaje vacío no llega a git.
    assert!(scm_commit(root.clone(), "   ".into(), true).await.is_err());

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn una_carpeta_sin_repo_no_es_un_error() {
    let dir = std::env::temp_dir().join(format!("cc-scm-sinrepo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(scm_status(dir.to_string_lossy().to_string()).await.unwrap().is_none());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn push_sin_remotos_explica_por_que() {
    let dir = temp_repo("sinremoto");
    std::fs::write(dir.join("a"), "a").unwrap();
    git_in(&dir, &["add", "-A"]);
    git_in(&dir, &["commit", "-q", "-m", "a"]);
    let err = super::commands::push(&dir.to_string_lossy(), &[]).unwrap_err();
    assert!(matches!(err, ScmError::Git(ref m) if m.contains("remoto")), "{err:?}");
    std::fs::remove_dir_all(dir).ok();
}

/// El grafo contra git de verdad: un merge da dos padres, y con upstream se distingue lo
/// que falta subir de lo que traería un pull.
#[tokio::test(flavor = "multi_thread")]
async fn el_historial_trae_padres_ramas_y_lo_que_entra_y_sale() {
    let origin = temp_repo("grafo-origen");
    std::fs::write(origin.join("a"), "1").unwrap();
    git_in(&origin, &["add", "-A"]);
    git_in(&origin, &["commit", "-q", "-m", "base"]);
    git_in(&origin, &["switch", "-q", "-c", "feat"]);
    std::fs::write(origin.join("b"), "1").unwrap();
    git_in(&origin, &["add", "-A"]);
    git_in(&origin, &["commit", "-q", "-m", "feat"]);
    git_in(&origin, &["switch", "-q", "main"]);
    git_in(&origin, &["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);

    let local = std::env::temp_dir().join(format!("cc-scm-grafo-local-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&local);
    git_in(&origin, &["clone", "-q", &origin.to_string_lossy(), &local.to_string_lossy()]);
    git_in(&local, &["config", "user.email", "test@controlcode.dev"]);
    git_in(&local, &["config", "user.name", "Control Code"]);
    git_in(&local, &["config", "commit.gpgsign", "false"]);

    // Uno sin subir en el clon, y uno sin traer en el origen.
    std::fs::write(local.join("c"), "1").unwrap();
    git_in(&local, &["add", "-A"]);
    git_in(&local, &["commit", "-q", "-m", "local"]);
    std::fs::write(origin.join("d"), "1").unwrap();
    git_in(&origin, &["add", "-A"]);
    git_in(&origin, &["commit", "-q", "-m", "remoto"]);
    git_in(&local, &["fetch", "-q"]);

    let root = local.to_string_lossy().to_string();
    let log = super::commands::scm_log(root.clone(), 50).await.unwrap();
    let by = |s: &str| log.iter().find(|c| c.subject == s).unwrap_or_else(|| panic!("falta {s}"));

    assert_eq!(by("merge feat").parents.len(), 2);
    assert!(by("local").outgoing && !by("local").incoming);
    assert!(by("remoto").incoming && !by("remoto").outgoing);
    assert!(!by("base").incoming && !by("base").outgoing);
    assert!(by("local").refs.iter().any(|r| r.kind == RefKind::Head && r.name == "main"));
    assert!(by("remoto").refs.iter().any(|r| r.kind == RefKind::Remote && r.name == "origin/main"));

    // Los archivos de un commit, y el contenido antes y después para el diff.
    let files = super::commands::scm_commit_files(root.clone(), by("local").hash.clone()).await.unwrap();
    assert_eq!(files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), vec![("c", "A")]);
    let hash = by("local").hash.clone();
    assert_eq!(super::commands::scm_file_at(root.clone(), "c".into(), hash.clone()).await.unwrap().as_deref(), Some("1"));
    assert_eq!(super::commands::scm_file_at(root.clone(), "c".into(), format!("{hash}^")).await.unwrap(), None);
    assert!(super::commands::scm_file_at(root.clone(), "c".into(), "--output=x".into()).await.is_err());

    // El primer commit no tiene padre: sus archivos se leen contra nada.
    let first = super::commands::scm_commit_files(root, by("base").hash.clone()).await.unwrap();
    assert_eq!(first.len(), 1);

    std::fs::remove_dir_all(origin).ok();
    std::fs::remove_dir_all(local).ok();
}

/// Tags contra git de verdad: anotado y liviano, en HEAD o en otro commit, subirlo a un
/// remoto y borrar el local sin tocar el del remoto.
#[tokio::test(flavor = "multi_thread")]
async fn los_tags_se_crean_listan_suben_y_borran() {
    let origin = temp_repo("tags-origen");
    git_in(&origin, &["config", "receive.denyCurrentBranch", "ignore"]);
    std::fs::write(origin.join("a"), "1").unwrap();
    git_in(&origin, &["add", "-A"]);
    git_in(&origin, &["commit", "-q", "-m", "base"]);
    let local = std::env::temp_dir().join(format!("cc-scm-tags-local-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&local);
    git_in(&origin, &["clone", "-q", &origin.to_string_lossy(), &local.to_string_lossy()]);
    git_in(&local, &["config", "user.email", "test@controlcode.dev"]);
    git_in(&local, &["config", "user.name", "Control Code"]);
    git_in(&local, &["config", "tag.gpgsign", "false"]);
    std::fs::write(local.join("b"), "1").unwrap();
    git_in(&local, &["add", "-A"]);
    git_in(&local, &["commit", "-q", "-m", "segundo"]);
    let root = local.to_string_lossy().to_string();
    let first = super::commands::scm_log(root.clone(), 10).await.unwrap().last().unwrap().hash.clone();

    super::commands::create_tag(&root, "v1.0.0", Some(&first), Some("Primera")).unwrap();
    super::commands::create_tag(&root, "liviano", None, None).unwrap();
    assert!(super::commands::create_tag(&root, "--force", None, None).is_err(), "no se lee como opción");
    assert!(super::commands::create_tag(&root, "mal nombre", None, None).is_err());
    assert!(super::commands::create_tag(&root, "x", Some("--all"), None).is_err());

    let tags = super::commands::scm_tags(root.clone()).await.unwrap();
    let v1 = tags.iter().find(|t| t.name == "v1.0.0").unwrap();
    assert!(v1.annotated);
    assert_eq!(v1.subject, "Primera");
    assert!(first.starts_with(&v1.target), "el tag anotado apunta al commit, no a sí mismo");
    let light = tags.iter().find(|t| t.name == "liviano").unwrap();
    assert!(!light.annotated);
    assert_eq!(light.subject, "segundo");

    // Subir: el tag aparece en el remoto. Sin la app no hay `AppHandle`, así que se prueba
    // el mismo `git push` que arma `push_tag`, sin credenciales (el remoto es local).
    super::git::network(&root, &["push", "origin", "refs/tags/v1.0.0"], &[]).unwrap();
    let remote_tags = std::process::Command::new("git").args(["-C", &origin.to_string_lossy(), "tag"]).output().unwrap();
    assert!(String::from_utf8_lossy(&remote_tags.stdout).contains("v1.0.0"));

    super::commands::scm_delete_tag(root.clone(), "v1.0.0".into()).await.unwrap();
    assert!(!super::commands::scm_tags(root).await.unwrap().iter().any(|t| t.name == "v1.0.0"));
    let remote_tags = std::process::Command::new("git").args(["-C", &origin.to_string_lossy(), "tag"]).output().unwrap();
    assert!(String::from_utf8_lossy(&remote_tags.stdout).contains("v1.0.0"), "borrar el local no toca el remoto");

    std::fs::remove_dir_all(origin).ok();
    std::fs::remove_dir_all(local).ok();
}

#[test]
fn el_resumen_de_un_diff_se_lee_aunque_falten_partes() {
    assert_eq!(parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), (3, 10, 2));
    assert_eq!(parse_shortstat(" 1 file changed, 1 deletion(-)"), (1, 0, 1));
    assert_eq!(parse_shortstat(""), (0, 0, 0));
}

/// Lo que se muestra antes de abrir un PR: los commits de la rama que `base` no tiene,
/// cuánto le falta de `base` y el tamaño del cambio.
#[tokio::test(flavor = "multi_thread")]
async fn comparar_dos_ramas_da_lo_que_entraria_en_el_pr() {
    let dir = temp_repo("compare");
    let root = std::fs::canonicalize(&dir).unwrap().to_string_lossy().to_string();
    let write = |name: &str, body: &str| std::fs::write(dir.join(name), body).unwrap();
    write("a.txt", "uno\n");
    git_in(&dir, &["add", "."]);
    git_in(&dir, &["commit", "-qm", "base"]);
    git_in(&dir, &["switch", "-qc", "feat"]);
    write("a.txt", "uno\ndos\n");
    write("b.txt", "nuevo\n");
    git_in(&dir, &["add", "."]);
    git_in(&dir, &["commit", "-qm", "feat: dos cosas"]);
    git_in(&dir, &["switch", "-q", "main"]);
    write("c.txt", "otra\n");
    git_in(&dir, &["add", "."]);
    git_in(&dir, &["commit", "-qm", "main avanza"]);

    let cmp = scm_compare(root.clone(), "main".into(), "feat".into()).await.unwrap();
    assert_eq!(cmp.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["feat: dos cosas"]);
    assert_eq!(cmp.behind, 1);
    assert_eq!((cmp.files, cmp.insertions, cmp.deletions), (2, 2, 0));
    assert!(!cmp.truncated);

    assert!(scm_compare(root.clone(), "--output=x".into(), "feat".into()).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
