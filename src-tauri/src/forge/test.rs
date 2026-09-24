use std::io::{Read, Write};
use std::net::TcpListener;

use serde_json::json;

use super::api::Api;
use super::commands::clone_dir_name;
use super::credentials::{basic, env_for, https_host};
use super::provider::{normalize_host, ForgeKind};
use super::store::{self, GitAccount};

fn account(id: &str, host: &str, login: &str) -> GitAccount {
    GitAccount {
        id: id.into(),
        kind: ForgeKind::Github,
        host: host.into(),
        login: login.into(),
        name: None,
        avatar_url: None,
        auth: "token".into(),
        git_user: None,
        created_at: 0,
        storage: None,
    }
}

#[test]
fn el_host_se_normaliza_como_lo_escribiria_cualquiera() {
    assert_eq!(normalize_host("https://GitHub.com/").unwrap(), "github.com");
    assert_eq!(normalize_host(" git.empresa.com:8443 ").unwrap(), "git.empresa.com:8443");
    assert!(normalize_host("github.com/owner/repo").is_err());
    assert!(normalize_host("").is_err());
    assert!(normalize_host("-x").is_err());
}

#[test]
fn cada_host_tiene_su_api_y_su_usuario_de_git() {
    assert_eq!(ForgeKind::Github.api_base("github.com"), "https://api.github.com");
    assert_eq!(ForgeKind::Github.api_base("ghe.corp"), "https://ghe.corp/api/v3");
    assert_eq!(ForgeKind::Gitlab.api_base("gitlab.com"), "https://gitlab.com/api/v4");
    assert_eq!(ForgeKind::Gitea.api_base("codeberg.org"), "https://codeberg.org/api/v1");
    assert_eq!(ForgeKind::Github.git_user("ana", None), "x-access-token");
    assert_eq!(ForgeKind::Gitlab.git_user("ana", None), "oauth2");
    assert_eq!(ForgeKind::Gitea.git_user("ana", None), "ana");
    assert_eq!(ForgeKind::Other.git_user("ana", Some("deploy")), "deploy");
}

#[test]
fn el_nombre_del_clon_sale_de_la_url() {
    assert_eq!(clone_dir_name("https://github.com/o/repo.git").as_deref(), Some("repo"));
    assert_eq!(clone_dir_name("git@github.com:o/repo.git").as_deref(), Some("repo"));
    assert_eq!(clone_dir_name("https://gitlab.com/g/sub/proj/").as_deref(), Some("proj"));
    assert_eq!(clone_dir_name("https://h/.."), None);
}

#[test]
fn solo_las_urls_https_llevan_la_cuenta() {
    assert_eq!(https_host("https://user@GitHub.com/o/r.git").as_deref(), Some("github.com"));
    assert_eq!(https_host("https://git.corp:8443/o/r").as_deref(), Some("git.corp:8443"));
    assert_eq!(https_host("git@github.com:o/r.git"), None);
    assert_eq!(https_host("ssh://git@github.com/o/r"), None);
}

#[test]
fn las_variables_de_git_van_numeradas() {
    let env = env_for(&[("a.b".into(), "1".into()), ("c.d".into(), "".into())]);
    assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "2".into()));
    assert!(env.contains(&("GIT_CONFIG_KEY_1".into(), "c.d".into())));
    assert!(env.contains(&("GIT_CONFIG_VALUE_1".into(), "".into())));
    assert!(env_for(&[]).is_empty());
}

#[test]
fn volver_a_iniciar_sesion_conserva_la_cuenta() {
    let conn = crate::database::test_db();
    let id = store::upsert(&conn, &account("a1", "github.com", "ana")).unwrap();
    assert_eq!(id, "a1");
    // Mismo host y login con otro id: es la misma cuenta, se actualiza.
    let again = store::upsert(&conn, &account("a2", "github.com", "ana")).unwrap();
    assert_eq!(again, "a1");
    assert_eq!(store::list(&conn).len(), 1);
}

#[test]
fn cada_repo_puede_elegir_su_cuenta() {
    let conn = crate::database::test_db();
    store::upsert(&conn, &account("a1", "github.com", "ana")).unwrap();
    store::upsert(&conn, &account("a2", "github.com", "trabajo")).unwrap();
    store::upsert(&conn, &account("a3", "gitlab.com", "ana")).unwrap();

    let (chosen, all) = store::pick(&conn, Some("/r"), "github.com");
    assert_eq!(all.len(), 2);
    assert_eq!(chosen.unwrap().login, "ana");

    store::set_repo_choice(&conn, "/r", "a2").unwrap();
    assert_eq!(store::pick(&conn, Some("/r"), "github.com").0.unwrap().login, "trabajo");
    // El alias de SSH de GitHub es el mismo host.
    assert_eq!(store::pick(&conn, Some("/r"), "ssh.github.com").0.unwrap().login, "trabajo");
    // Otro repo sigue con la primera.
    assert_eq!(store::pick(&conn, Some("/otro"), "github.com").0.unwrap().login, "ana");

    // Borrar la cuenta elegida borra también la elección.
    store::delete(&conn, "a2").unwrap();
    assert_eq!(store::repo_choice(&conn, "/r"), None);
}

#[test]
fn un_pr_se_lee_igual_venga_de_donde_venga() {
    let gh = Api::new(ForgeKind::Github, "github.com", "t").unwrap();
    let pr = gh.item_from(
        &json!({
            "number": 7, "title": "Arreglo", "state": "closed", "merged_at": "2026-01-01T00:00:00Z",
            "draft": false, "user": { "login": "ana" }, "html_url": "https://github.com/o/r/pull/7",
            "labels": [{ "name": "bug" }], "head": { "ref": "fix" }, "base": { "ref": "main" }
        }),
        true,
    );
    assert_eq!((pr.number, pr.state.as_str()), (7, "merged"));
    assert_eq!(pr.source_branch.as_deref(), Some("fix"));
    assert_eq!(pr.labels, vec!["bug"]);

    let gl = Api::new(ForgeKind::Gitlab, "gitlab.com", "t").unwrap();
    let mr = gl.item_from(
        &json!({
            "iid": 3, "title": "MR", "state": "opened", "draft": true, "author": { "username": "ana" },
            "web_url": "https://gitlab.com/g/p/-/merge_requests/3", "labels": ["ui"],
            "source_branch": "feat", "target_branch": "main", "user_notes_count": 2
        }),
        true,
    );
    assert_eq!((mr.number, mr.state.as_str(), mr.draft), (3, "open", true));
    assert_eq!(mr.author.as_deref(), Some("ana"));
    assert_eq!(mr.comments, Some(2));
    assert_eq!(mr.labels, vec!["ui"]);
}

#[test]
fn una_cuenta_generica_no_tiene_api() {
    assert!(Api::new(ForgeKind::Other, "git.corp", "t").is_err());
}

/// Lo que importa de verdad: que git, con estas variables, mande el token a ESE host y no
/// le pregunte al credential helper del sistema cuando el token no alcanza.
///
/// Un servidor HTTP mínimo contesta 401 y guarda la cabecera que le llegó. Se prueba con
/// `http://` porque es local; el mecanismo (`http.<url>.extraheader`,
/// `credential.<url>.helper`) es el mismo que con `https://`.
#[test]
fn git_manda_el_token_y_no_usa_otro_helper() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let mut headers = Vec::new();
        // git puede reintentar; alcanza con los primeros pedidos.
        for _ in 0..3 {
            listener.set_nonblocking(false).unwrap();
            let Ok((mut stream, _)) = listener.accept() else { break };
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let auth = req
                .lines()
                .find(|l| l.to_lowercase().starts_with("authorization:"))
                .map(|l| l.to_string());
            headers.push(auth);
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            if !headers.is_empty() {
                break;
            }
        }
        headers
    });

    let base = format!("http://127.0.0.1:{port}");
    // Un helper que, si git lo llegara a usar, dejaría una marca.
    let marker = std::env::temp_dir().join(format!("cc-forge-helper-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let helper = format!("!touch {}; echo", marker.display());
    let env = env_for(&[
        (format!("http.{base}/.extraheader"), basic("x-access-token", "secreto")),
        (format!("credential.{base}.helper"), String::new()),
    ]);
    // El helper del "sistema" va donde lo tiene un usuario de verdad: en su config global,
    // que git lee ANTES que las variables. (Un `-c` no sirve para probarlo: git lo lee
    // después y le ganaría a cualquier cosa.)
    let global = std::env::temp_dir().join(format!("cc-forge-gitconfig-{}", std::process::id()));
    std::fs::write(&global, format!("[credential]\n\thelper = {helper}\n")).unwrap();
    let out = std::process::Command::new("git")
        .args(["ls-remote", &format!("{base}/o/r.git")])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_GLOBAL", &global)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .envs(env.iter().map(|(k, v)| (k, v)))
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&global);
    assert!(!out.status.success());

    let headers = server.join().unwrap();
    let expected = basic("x-access-token", "secreto");
    assert_eq!(headers[0].as_deref().map(str::to_lowercase), Some(expected.to_lowercase()), "{headers:?}");
    assert!(!marker.exists(), "git consultó al credential helper del sistema");
}

/// Contra el llavero REAL del sistema: guarda, lee y borra una entrada de prueba. Ignorado
/// por defecto (en CI no hay llavero); correrlo a mano en cada sistema:
/// `cargo test --lib forge::test::el_llavero -- --ignored`.
#[test]
#[ignore]
fn el_llavero_del_sistema_guarda_y_devuelve_el_token() {
    use super::secret::{self, Secret, Storage};
    let dir = std::env::temp_dir().join(format!("cc-forge-secret-{}", std::process::id()));
    let id = format!("prueba-{}", std::process::id());
    let s = Secret { access_token: "tok".into(), refresh_token: Some("ref".into()), expires_at: Some(1) };
    let storage = secret::save(&dir, &id, &s).unwrap();
    assert_eq!(storage, Storage::Keyring, "no hay llavero: quedó en archivo");
    secret::delete(&dir, "otro-id-que-no-existe");
    // Sin la cache: que venga del llavero de verdad.
    super::secret::clear_cache_for_tests();
    assert_eq!(secret::load(&dir, &id).unwrap(), s);
    secret::delete(&dir, &id);
    assert!(secret::load(&dir, &id).is_err());
}
