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

#[test]
fn el_ci_de_github_junta_check_runs_y_statuses() {
    use super::api::{github_checks, overall};
    let runs = json!({ "check_runs": [
        { "name": "build", "status": "completed", "conclusion": "success", "html_url": "https://gh/1" },
        { "name": "lint", "status": "in_progress", "conclusion": null },
        { "name": "e2e", "status": "completed", "conclusion": "timed_out" },
    ]});
    let combined = json!({ "statuses": [{ "context": "vercel", "state": "success", "target_url": "https://v" }] });
    let checks = github_checks(&runs, &combined);
    let states: Vec<(&str, &str)> = checks.iter().map(|c| (c.name.as_str(), c.state.as_str())).collect();
    assert_eq!(states, vec![("build", "success"), ("lint", "running"), ("e2e", "failure"), ("vercel", "success")]);
    assert_eq!(overall(&checks), "failure");
    assert_eq!(overall(&checks[..2]), "pending");
    assert_eq!(overall(&checks[..1]), "success");
    assert_eq!(overall(&[]), "none");
}

#[test]
fn el_ci_de_gitlab_y_gitea_se_lee_igual() {
    use super::api::{gitea_checks, gitlab_checks, overall};
    let jobs = vec![
        json!({ "name": "test", "status": "success", "web_url": "u" }),
        json!({ "name": "deploy", "status": "manual" }),
        json!({ "name": "lint", "status": "failed" }),
    ];
    let gl = gitlab_checks(&jobs);
    assert_eq!(gl.iter().map(|c| c.state.as_str()).collect::<Vec<_>>(), vec!["success", "skipped", "failure"]);
    assert_eq!(overall(&gl), "failure");

    let gt = gitea_checks(&json!({ "statuses": [{ "context": "ci/build", "status": "pending", "target_url": "" }] }));
    assert_eq!(gt[0].state, "pending");
    assert_eq!(gt[0].url, None, "una URL vacía no es un link");
}

#[test]
fn un_diff_de_varios_archivos_se_parte_por_archivo() {
    use super::api::{count_patch, split_diff};
    let raw = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-uno\n+UNO\n+dos\ndiff --git a/viejo.md b/nuevo.md\nsimilarity index 90%\n@@ -3 +3 @@\n-x\n+y\n";
    let parts = split_diff(raw);
    assert_eq!(parts.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["src/a.ts", "nuevo.md"]);
    assert!(parts[0].1.starts_with("@@ -1 +1,2 @@"));
    assert_eq!(count_patch(&parts[0].1), (2, 1));
}

#[test]
fn una_release_se_lee_igual_en_github_y_gitlab() {
    let gh = Api::new(ForgeKind::Github, "github.com", "t").unwrap();
    let r = gh.release_from(&json!({
        "tag_name": "v1.7.3", "name": "v1.7.3 — Git", "body": "## Notas", "draft": false, "prerelease": true,
        "html_url": "https://github.com/o/r/releases/tag/v1.7.3", "published_at": "2026-09-24T00:00:00Z",
        "author": { "login": "luis3132" }
    }));
    assert_eq!((r.tag.as_str(), r.prerelease, r.draft), ("v1.7.3", true, false));
    assert_eq!(r.author.as_deref(), Some("luis3132"));

    let gl = Api::new(ForgeKind::Gitlab, "gitlab.com", "t").unwrap();
    let r = gl.release_from(&json!({
        "tag_name": "v2", "name": "Dos", "description": "", "released_at": "2026-01-01T00:00:00Z",
        "_links": { "self": "https://gitlab.com/g/p/-/releases/v2" }, "author": { "username": "ana" }
    }));
    assert_eq!(r.web_url, "https://gitlab.com/g/p/-/releases/v2");
    assert_eq!(r.body, None, "una descripción vacía no es un cuerpo");
    assert!(!r.draft);
}

/// Cada host da el color con o sin `#`, y alguno deja la descripción vacía.
#[test]
fn las_etiquetas_se_leen_igual_de_cualquier_host() {
    use super::api::label_from;
    let gh = label_from(&serde_json::json!({ "name": "bug", "color": "d73a4a", "description": "Algo anda mal" })).unwrap();
    assert_eq!(gh.color.as_deref(), Some("d73a4a"));
    let gl = label_from(&serde_json::json!({ "name": "ui", "color": "#0e8a16", "description": "" })).unwrap();
    assert_eq!(gl.color.as_deref(), Some("0e8a16"));
    assert_eq!(gl.description, None);
    assert!(label_from(&serde_json::json!({ "color": "fff" })).is_none());
}

// ── Varias Control Code abiertas con la misma cuenta ─────────────

mod renovar_con_varias_instancias {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::super::credentials::resolve_token;
    use super::super::secret::Secret;

    const NOW: i64 = 1_000_000;

    fn secret(access: &str, refresh: &str, expires_at: i64) -> Secret {
        Secret { access_token: access.into(), refresh_token: Some(refresh.into()), expires_at: Some(expires_at) }
    }

    /// El llavero compartido entre instancias, y cuántas veces se renovó contra el host.
    struct World {
        keyring: Mutex<Secret>,
        refreshes: AtomicUsize,
    }

    async fn run(world: Arc<World>, cached: Secret) -> Result<(String, Option<Secret>), String> {
        let w = world.clone();
        let reload = move || {
            let w = w.clone();
            async move { Ok(w.keyring.lock().unwrap().clone()) }
        };
        let w = world.clone();
        let refresh = move |token: String| async move {
            w.refreshes.fetch_add(1, Ordering::SeqCst);
            // El host acepta solo el refresh token vigente, y lo rota.
            let mut k = w.keyring.lock().unwrap();
            if k.refresh_token.as_deref() != Some(token.as_str()) {
                return Err("La sesión venció; volvé a iniciar sesión".to_string());
            }
            *k = secret("nuevo", "r2", NOW + 3600);
            Ok(k.clone())
        };
        resolve_token(cached, NOW, reload, refresh, &[std::time::Duration::from_millis(1)]).await
    }

    #[tokio::test]
    async fn vigente_se_usa_sin_tocar_el_llavero() {
        let world = Arc::new(World { keyring: Mutex::new(secret("a", "r1", NOW + 3600)), refreshes: AtomicUsize::new(0) });
        let (token, fresh) = run(world.clone(), secret("a", "r1", NOW + 3600)).await.unwrap();
        assert_eq!((token.as_str(), fresh.is_none()), ("a", true));
        assert_eq!(world.refreshes.load(Ordering::SeqCst), 0);
    }

    /// Lo que pasaba: otra instancia ya renovó (el llavero tiene r2) y esta todavía tiene
    /// r1 en memoria. Renovar con r1 fallaba con "la sesión venció".
    #[tokio::test]
    async fn si_otra_instancia_ya_renovo_se_usa_lo_suyo() {
        let world = Arc::new(World { keyring: Mutex::new(secret("nuevo", "r2", NOW + 3600)), refreshes: AtomicUsize::new(0) });
        let (token, fresh) = run(world.clone(), secret("viejo", "r1", NOW - 10)).await.unwrap();
        assert_eq!(token, "nuevo");
        assert!(fresh.is_none(), "no hay nada nuevo que guardar");
        assert_eq!(world.refreshes.load(Ordering::SeqCst), 0, "ni se le preguntó al host");
    }

    #[tokio::test]
    async fn vencido_en_todos_lados_se_renueva_y_se_guarda() {
        let world = Arc::new(World { keyring: Mutex::new(secret("viejo", "r1", NOW - 10)), refreshes: AtomicUsize::new(0) });
        let (token, fresh) = run(world.clone(), secret("viejo", "r1", NOW - 10)).await.unwrap();
        assert_eq!(token, "nuevo");
        assert_eq!(fresh.and_then(|f| f.refresh_token).as_deref(), Some("r2"));
    }

    /// Las dos renovaron a la vez y ganó la otra: el host rechaza el refresh token de esta,
    /// pero en el llavero ya está el par bueno.
    #[tokio::test]
    async fn si_otra_gano_la_carrera_se_toma_su_token() {
        let world = Arc::new(World { keyring: Mutex::new(secret("viejo", "r1", NOW - 10)), refreshes: AtomicUsize::new(0) });
        let w = world.clone();
        let reload = {
            let w = w.clone();
            let calls = Arc::new(AtomicUsize::new(0));
            move || {
                let (w, calls) = (w.clone(), calls.clone());
                async move {
                    // La primera lectura es antes de que la otra guarde; las siguientes, después.
                    if calls.fetch_add(1, Ordering::SeqCst) > 0 {
                        *w.keyring.lock().unwrap() = secret("de-la-otra", "r9", NOW + 3600);
                    }
                    Ok(w.keyring.lock().unwrap().clone())
                }
            }
        };
        let refresh = |_token: String| async { Err::<Secret, _>("La sesión venció".to_string()) };
        let (token, fresh) =
            resolve_token(secret("viejo", "r1", NOW - 10), NOW, reload, refresh, &[std::time::Duration::from_millis(1)])
                .await
                .unwrap();
        assert_eq!(token, "de-la-otra");
        assert!(fresh.is_none());
    }

    #[tokio::test]
    async fn si_de_verdad_vencio_se_dice() {
        let world = Arc::new(World { keyring: Mutex::new(secret("viejo", "rX", NOW - 10)), refreshes: AtomicUsize::new(0) });
        // El host no acepta rX (fue revocado) y nadie más renovó.
        *world.keyring.lock().unwrap() = secret("viejo", "rX", NOW - 10);
        let w = world.clone();
        let reload = move || {
            let w = w.clone();
            async move { Ok(w.keyring.lock().unwrap().clone()) }
        };
        let refresh = |_t: String| async { Err::<Secret, _>("La sesión venció; volvé a iniciar sesión".to_string()) };
        let err = resolve_token(secret("viejo", "rX", NOW - 10), NOW, reload, refresh, &[std::time::Duration::from_millis(1)])
            .await
            .unwrap_err();
        assert!(err.contains("venció"));
    }
}

// ── Crear un repo en el host ─────────────────────────────────────

/// Lo que se le pide a cada host para crear un repo vacío, en la cuenta o en una
/// organización (en GitLab, un grupo por su id).
#[test]
fn crear_un_repo_pide_lo_de_cada_host() {
    use super::api::{create_repo_request, RepoOwner};
    let me = RepoOwner { login: "luis".into(), org: false, id: None };
    let org = RepoOwner { login: "acme".into(), org: true, id: Some(42) };

    let (path, body) = create_repo_request(ForgeKind::Github, Some(&me), "app", "Mi app", true);
    assert_eq!(path, "/user/repos");
    assert_eq!(body, json!({ "name": "app", "private": true, "description": "Mi app", "auto_init": false }));
    let (path, body) = create_repo_request(ForgeKind::Github, Some(&org), "app", "", false);
    assert_eq!(path, "/orgs/acme/repos");
    assert_eq!(body["private"], false);
    // Gitea: lo mismo que GitHub.
    assert_eq!(create_repo_request(ForgeKind::Gitea, Some(&org), "app", "", true).0, "/orgs/acme/repos");
    assert_eq!(create_repo_request(ForgeKind::Gitea, None, "app", "", true).0, "/user/repos");

    let (path, body) = create_repo_request(ForgeKind::Gitlab, Some(&org), "app", "", false);
    assert_eq!(path, "/projects");
    assert_eq!(body["namespace_id"], 42);
    assert_eq!(body["visibility"], "public");
    let (_, body) = create_repo_request(ForgeKind::Gitlab, Some(&me), "app", "", true);
    assert!(body.get("namespace_id").is_none(), "en la cuenta no se manda grupo");
    assert_eq!(body["visibility"], "private");
}

#[test]
fn las_organizaciones_y_los_grupos_se_leen_de_cada_host() {
    use super::api::owner_from;
    let gh = owner_from(ForgeKind::Github, &json!({ "login": "acme", "id": 7 })).unwrap();
    assert_eq!((gh.login.as_str(), gh.org, gh.id), ("acme", true, Some(7)));
    let gitea = owner_from(ForgeKind::Gitea, &json!({ "username": "equipo", "id": 3 })).unwrap();
    assert_eq!(gitea.login, "equipo");
    let gl = owner_from(ForgeKind::Gitlab, &json!({ "full_path": "empresa/front", "id": 99 })).unwrap();
    assert_eq!((gl.login.as_str(), gl.id), ("empresa/front", Some(99)));
    assert!(owner_from(ForgeKind::Gitlab, &json!({ "id": 1 })).is_none());
}

#[test]
fn el_nombre_del_repo_se_valida_como_en_los_hosts() {
    use super::api::valid_repo_name;
    assert!(valid_repo_name("facturas-crear") && valid_repo_name("app.web_2"));
    for bad in ["", ".oculto", "-guion", "con espacio", "a/b", "ñandú"] {
        assert!(!valid_repo_name(bad), "{bad}");
    }
}
