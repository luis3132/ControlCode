use super::git::{classify_failure, ScmError};
use super::parse::{parse_branches, parse_log, parse_status_v2, ScmEntry, BRANCH_FORMAT, LOG_FORMAT};
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
    let raw = "abc123\u{1f}abc\u{1f}Ana\u{1f}1700000000\u{1f}fix: a | b, c; d\u{1e}\ndef456\u{1f}def\u{1f}Luis\u{1f}1700000100\u{1f}feat: otra\u{1e}";
    let log = parse_log(raw);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].subject, "fix: a | b, c; d");
    assert_eq!(log[1].author, "Luis");
    assert_eq!(log[1].time, 1_700_000_100);
    assert!(LOG_FORMAT.ends_with("%x1e"));
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
    scm_branches, scm_checkout, scm_commit, scm_discard, scm_file_at, scm_log, scm_stage, scm_status, scm_unstage,
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
