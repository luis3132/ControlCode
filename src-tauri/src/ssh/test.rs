//! Tests de las conexiones SSH: lo que termina en la línea de comandos de `ssh` y el CRUD.

use super::*;
use super::tools::{agent_connection, hosts_text, output_text, timeout_of};
use serde_json::json;

fn draft(name: &str, host: &str) -> SshConnectionDraft {
    SshConnectionDraft { name: name.into(), host: host.into(), agent_access: true, ..Default::default() }
}

fn conn(host: &str) -> SshConnection {
    connection_from_draft(draft("pc", host)).unwrap()
}

// ── Validación ───────────────────────────────────────────────────

/// `usuario@equipo` es como se escribe en la terminal: se acepta y se parte.
#[test]
fn usuario_arroba_equipo_se_parte_en_sus_dos_campos() {
    let d = normalize_draft(draft("pc", " luis@192.168.1.50 ")).unwrap();
    assert_eq!(d.user.as_deref(), Some("luis"));
    assert_eq!(d.host, "192.168.1.50");
}

/// Lo que empieza con `-` lo leería `ssh` como opción: `-oProxyCommand=…` en el campo del
/// equipo ejecutaría un comando local.
#[test]
fn nada_que_ssh_pueda_leer_como_opcion() {
    assert!(normalize_draft(draft("pc", "-oProxyCommand=calc")).is_err());
    let mut d = draft("pc", "equipo");
    d.user = Some("-oProxyCommand=x".into());
    assert!(normalize_draft(d).is_err());
    let mut d = draft("pc", "equipo");
    d.identity_file = Some("-F/tmp/x".into());
    assert!(normalize_draft(d).is_err());
    assert!(normalize_draft(draft("pc", "equipo con espacios")).is_err());
}

/// El nombre es lo que escribe el agente: sin espacios ni caracteres raros.
#[test]
fn el_nombre_es_una_palabra_que_un_agente_puede_escribir() {
    assert!(normalize_draft(draft("", "h")).is_err());
    assert!(normalize_draft(draft("mi pc", "h")).is_err());
    assert!(normalize_draft(draft("servidor-casa_2.lan", "h")).is_ok());
}

#[test]
fn campos_vacios_quedan_en_nada() {
    let mut d = draft("pc", "h");
    d.user = Some("  ".into());
    d.remote_dir = Some("".into());
    let d = normalize_draft(d).unwrap();
    assert_eq!(d.user, None);
    assert_eq!(d.remote_dir, None);
}

// ── Argumentos ───────────────────────────────────────────────────

/// Los agentes corren sin nadie que escriba una contraseña: `ssh` tiene que fallar enseguida
/// en vez de quedarse esperando.
#[test]
fn para_un_agente_ssh_no_es_interactivo() {
    let mut c = conn("equipo");
    c.user = Some("luis".into());
    c.port = Some(2222);
    let args = exec_args(&c, "ls", None);
    assert_eq!(
        args,
        vec!["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2222", "luis@equipo", "ls"]
    );
}

/// La carpeta va entre comillas (puede tener espacios) pero `~` tiene que seguir fuera,
/// o el shell remoto no lo expandiría.
#[test]
fn el_comando_arranca_en_la_carpeta_pedida() {
    assert_eq!(remote_command(Some("/srv/mi app"), "ls"), "cd '/srv/mi app' && ls");
    assert_eq!(remote_command(Some("~/proyectos"), "ls"), "cd ~/'proyectos' && ls");
    assert_eq!(remote_command(Some("it's"), "ls"), r"cd 'it'\''s' && ls");
    assert_eq!(remote_command(None, "ls"), "ls");

    let mut c = conn("h");
    c.remote_dir = Some("/srv".into());
    // La que pide el agente gana sobre la de la conexión.
    assert_eq!(exec_args(&c, "ls", Some("/tmp")).last().unwrap(), "cd '/tmp' && ls");
    assert_eq!(exec_args(&c, "ls", None).last().unwrap(), "cd '/srv' && ls");
}

/// `scp` usa `-P` para el puerto, y una IPv6 va entre corchetes.
#[test]
fn scp_con_su_propio_flag_de_puerto() {
    let mut c = conn("::1");
    c.port = Some(2222);
    let args = scp_args(&c, "a.txt", &scp_remote(&c, "/tmp/a.txt"), true);
    assert_eq!(
        args,
        vec!["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-P", "2222", "-r", "a.txt", "[::1]:/tmp/a.txt"]
    );
}

/// La terminal es interactiva (ahí sí hay una persona), y el comando tiene que partirse
/// bien con el `split_command` del PTY.
#[test]
fn la_terminal_es_interactiva_y_arranca_en_la_carpeta() {
    let mut c = conn("equipo");
    c.user = Some("luis".into());
    assert_eq!(terminal_command(&c), "ssh luis@equipo");

    c.remote_dir = Some("~/mi proyecto".into());
    c.identity_file = Some("/home/luis/mis claves/id".into());
    let command = terminal_command(&c);
    assert!(!command.contains("BatchMode"), "{command}");
    assert_eq!(
        command,
        "ssh -i \"/home/luis/mis claves/id\" -t luis@equipo \"cd ~/'mi proyecto' && exec $SHELL -l\""
    );
}

#[test]
fn los_errores_conocidos_traen_que_hacer() {
    assert!(hint_for("Host key verification failed.").unwrap().contains("huella"));
    assert!(hint_for("luis@h: Permission denied (publickey).").unwrap().contains("ssh-copy-id"));
    assert!(hint_for("algo raro").is_none());
}

#[test]
fn una_salida_larga_se_queda_con_el_final() {
    let text = "á".repeat(100);
    let cut = super::exec::tail(&text, 51);
    assert!(cut.ends_with('á'));
    assert!(cut.contains("recortados"));
    assert_eq!(super::exec::tail("corto", 10), "corto");
}

// ── Base ─────────────────────────────────────────────────────────

#[test]
fn alta_edicion_y_baja() {
    let db = crate::database::test_db();
    let saved = save_conn(&db, draft("servidor", "luis@10.0.0.2")).unwrap();
    assert_eq!(saved.user.as_deref(), Some("luis"));
    assert!(saved.agent_access);

    let mut edit = draft("servidor", "10.0.0.3");
    edit.id = Some(saved.id.clone());
    edit.port = Some(2200);
    edit.agent_access = false;
    let edited = save_conn(&db, edit).unwrap();
    assert_eq!(edited.id, saved.id);
    assert_eq!(edited.host, "10.0.0.3");
    assert_eq!(edited.port, Some(2200));
    assert!(!edited.agent_access);
    assert_eq!(list_conn(&db).unwrap().len(), 1);

    delete_conn(&db, &saved.id).unwrap();
    assert!(list_conn(&db).unwrap().is_empty());
}

/// Los agentes buscan por nombre sin distinguir mayúsculas, así que dos nombres que solo
/// difieren en eso serían ambiguos.
#[test]
fn no_hay_dos_conexiones_con_el_mismo_nombre() {
    let db = crate::database::test_db();
    save_conn(&db, draft("Servidor", "a")).unwrap();
    let err = save_conn(&db, draft("servidor", "b")).unwrap_err();
    assert!(err.contains("Ya existe"), "{err}");
}

/// Una conexión sin permiso para agentes no se lista ni se puede usar, pero el mensaje dice
/// qué habilitar.
#[test]
fn un_agente_solo_alcanza_las_conexiones_habilitadas() {
    let db = crate::database::test_db();
    save_conn(&db, draft("abierta", "a")).unwrap();
    let mut closed = draft("cerrada", "b");
    closed.agent_access = false;
    save_conn(&db, closed).unwrap();

    assert_eq!(agent_connection(&db, "ABIERTA").unwrap().name, "abierta");
    assert!(agent_connection(&db, "cerrada").unwrap_err().contains("not enabled"));
    assert!(agent_connection(&db, "otra").unwrap_err().contains("Available: abierta"));

    let text = hosts_text(&list_conn(&db).unwrap());
    assert!(text.contains("abierta — a"));
    assert!(!text.contains("cerrada"));
}

#[test]
fn la_salida_para_el_agente_dice_codigo_y_consejo() {
    let out = RemoteOutput { exit_code: Some(255), stdout: String::new(), stderr: "Permission denied (publickey).".into() };
    let text = output_text(&out);
    assert!(text.starts_with("exit code: 255"));
    assert!(text.contains("ssh could not connect"));
    assert!(text.contains("--- stderr"));
}

#[test]
fn el_tope_de_tiempo_queda_dentro_de_los_limites() {
    assert_eq!(timeout_of(&json!({})).as_secs(), DEFAULT_TIMEOUT_SECS);
    assert_eq!(timeout_of(&json!({ "timeout_s": 1 })).as_secs(), 5);
    assert_eq!(timeout_of(&json!({ "timeout_s": 99999 })).as_secs(), MAX_TIMEOUT_SECS);
}

// ── Contra un servidor de verdad ─────────────────────────────────

/// Corre `ssh` y `scp` de verdad contra un servidor que ya confía en una clave:
///
/// ```sh
/// CC_SSH_TEST_HOST=127.0.0.1 CC_SSH_TEST_PORT=2222 CC_SSH_TEST_USER=root \
/// CC_SSH_TEST_KEY=/ruta/a/la/clave cargo test --lib ssh:: -- --ignored
/// ```
///
/// Ignorado por defecto: necesita red y un `sshd` del otro lado.
#[test]
#[ignore]
fn contra_un_sshd_de_verdad() {
    use std::time::Duration;
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let mut d = draft("prueba", &env("CC_SSH_TEST_HOST").expect("CC_SSH_TEST_HOST"));
    d.port = env("CC_SSH_TEST_PORT").map(|p| p.parse().unwrap());
    d.user = env("CC_SSH_TEST_USER");
    d.identity_file = env("CC_SSH_TEST_KEY");
    let c = connection_from_draft(d).unwrap();

    let check = check(&c);
    assert!(check.ok, "{check:?}");

    let out = run_remote(&c, "echo hola && echo error >&2 && exit 3", None, Duration::from_secs(20)).unwrap();
    assert_eq!(out.exit_code, Some(3));
    assert_eq!(out.stdout.trim(), "hola");
    assert_eq!(out.stderr.trim(), "error");

    let tmp = std::env::temp_dir().join(format!("cc-ssh-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let local = tmp.join("subida.txt");
    std::fs::write(&local, "de acá para allá").unwrap();
    let remote = format!("/tmp/cc-ssh-{}.txt", std::process::id());
    let up = copy(&c, local.to_str().unwrap(), &scp_remote(&c, &remote), false, Duration::from_secs(20)).unwrap();
    assert_eq!(up.exit_code, Some(0), "{up:?}");
    let cat = run_remote(&c, &format!("cat {remote}"), Some("/tmp"), Duration::from_secs(20)).unwrap();
    assert_eq!(cat.stdout, "de acá para allá");

    let back = tmp.join("bajada.txt");
    let down = copy(&c, &scp_remote(&c, &remote), back.to_str().unwrap(), false, Duration::from_secs(20)).unwrap();
    assert_eq!(down.exit_code, Some(0), "{down:?}");
    assert_eq!(std::fs::read_to_string(&back).unwrap(), "de acá para allá");

    let _ = run_remote(&c, &format!("rm -f {remote}"), None, Duration::from_secs(20));
    let _ = std::fs::remove_dir_all(&tmp);

    // Una carpeta que no existe se dice como tal, no como "no conecta".
    let lost = SshConnection { remote_dir: Some("/no/existe/de/verdad".into()), ..c };
    let check = super::exec::check(&lost);
    assert!(!check.ok && check.detail.contains("no existe"), "{check:?}");
}
