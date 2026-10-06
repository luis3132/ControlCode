//! Subprocesos de verdad (`sh`), en PTYs de verdad, con la app falsa de Tauri.

use std::time::Duration;

use super::logs::{self, Query, Until, Waited};
use super::{Owner, StartSpec, Status};

fn tmp() -> String {
    let dir = std::env::temp_dir().join(format!("cc-procs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

fn spec(command: &str, workspace: &str) -> StartSpec {
    StartSpec {
        command: command.into(),
        cwd: workspace.into(),
        name: None,
        workspace: workspace.into(),
        owner: Owner { tab_id: Some("t1".into()), task_id: None },
    }
}

fn never() -> bool {
    false
}

#[test]
fn las_rutas_de_carpeta_se_comparan_sin_la_barra_final() {
    assert!(super::same_folder("/a/b", "/a/b/"));
    assert!(!super::same_folder("/a/b", "/a/bc"));
}

#[test]
fn el_final_de_un_texto_se_corta_en_un_borde_de_caracter() {
    assert_eq!(logs::last_bytes_for_tests("añob", 2), "ob");
    assert_eq!(logs::last_bytes_for_tests("añob", 3), "ob"); // el corte cae dentro de "ñ"
    assert_eq!(logs::last_bytes_for_tests("añob", 4), "ñob");
    assert_eq!(logs::last_bytes_for_tests("ab", 10), "ab");
}

#[test]
fn los_descendientes_salen_del_arbol_de_padres() {
    let parents = std::collections::HashMap::from([(2, 1), (3, 2), (4, 1), (9, 8), (1, 2)]);
    let mut d = super::stats::descendants(1, &parents);
    d.sort();
    assert_eq!(d, vec![2, 3, 4]); // el ciclo 1↔2 no cuelga ni repite
}

#[cfg(unix)]
#[test]
fn un_subproceso_entero_lanzar_leer_escribir_parar_reiniciar() {
    super::init_for_tests();
    let ws = tmp();

    // Lanzar y esperar a que diga que está listo.
    let proc = super::start(spec("echo arrancando; echo 'error: algo falló'; read x; echo \"leí $x\"; sleep 30", &ws)).unwrap();
    assert_eq!(proc.status, Status::Running);
    let waited = logs::wait(&proc.id, &Until::Pattern(regex::Regex::new("arrancando").unwrap()), Duration::from_secs(10), Some(0), &never).unwrap();
    assert!(matches!(waited, Waited::Matched(_)), "{waited:?}");

    // Lo nuevo: la primera lectura trae todo, la segunda nada.
    let first = logs::read("tab:t1", &proc.id, &Query::default()).unwrap();
    assert!(first.contains("arrancando"), "{first}");
    assert!(first.contains("Errors:"), "el error tiene que salir aparte: {first}");
    let again = logs::read("tab:t1", &proc.id, &Query::default()).unwrap();
    assert!(again.contains("No new output"), "{again}");
    // Otro lector tiene su propio "lo nuevo".
    assert!(logs::read("tab:otro", &proc.id, &Query::default()).unwrap().contains("arrancando"));

    // Solo errores, con contexto, y por patrón.
    let errors = logs::read("tab:t1", &proc.id, &Query { errors: true, ..Default::default() }).unwrap();
    assert!(errors.contains("[error]") && errors.contains("algo falló"), "{errors}");
    let grep = logs::read("tab:t1", &proc.id, &Query { grep: Some("ARRANC".into()), ..Default::default() }).unwrap();
    assert!(grep.contains("1 line(s) match"), "{grep}");

    // Escribirle, como en una terminal.
    // La respuesta puede salir antes de empezar a esperar: se mira desde lo que este
    // lector no leyó, no desde ahora.
    let from = logs::cursor_of("tab:t1", &proc.id);
    super::send(&proc.id, "hola", true).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let waited = logs::wait(&proc.id, &Until::Pattern(regex::Regex::new("leí hola").unwrap()), Duration::from_secs(10), Some(from), &never).unwrap();
    assert!(matches!(waited, Waited::Matched(_)), "{waited:?}");

    // Parar: Ctrl-C alcanza para `sleep`, y queda como detenido, con sus logs.
    let stopped = super::stop(&proc.id, false).unwrap();
    assert_eq!(stopped.status, Status::Stopped);
    assert!(logs::read("tab:t1", &proc.id, &Query { lines: Some(50), ..Default::default() }).unwrap().contains("leí hola"));

    // Reiniciar: el mismo id, otro PTY, corriendo de nuevo.
    let restarted = super::restart(&proc.id).unwrap();
    assert_eq!(restarted.id, proc.id);
    assert_ne!(restarted.pty_id, proc.pty_id);
    assert_eq!(restarted.status, Status::Running);
    assert_eq!(restarted.restarts, 1);
    assert_eq!(super::stop(&proc.id, true).unwrap().status, Status::Stopped);
}

#[cfg(unix)]
#[test]
fn uno_que_termina_solo_queda_con_su_codigo() {
    super::init_for_tests();
    let ws = tmp();
    let proc = super::start(spec("echo listo; exit 3", &ws)).unwrap();
    let waited = logs::wait(&proc.id, &Until::Exit, Duration::from_secs(10), None, &never).unwrap();
    assert_eq!(waited, Waited::Exited);
    // El aviso de fin llega por el hilo del PTY: un momento.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline && super::get(&proc.id).unwrap().exit_code.is_none() {
        std::thread::sleep(Duration::from_millis(20));
    }
    let done = super::get(&proc.id).unwrap();
    assert_eq!(done.status, Status::Exited);
    assert_eq!(done.exit_code, Some(3));
    assert_eq!(super::list(Some(&ws)).len(), 1);
    assert!(super::list(Some("/otro/workspace")).is_empty());
    assert_eq!(super::clear(Some(&proc.id)), 1);
    assert!(super::get(&proc.id).is_none());
}

#[cfg(unix)]
#[test]
fn esperar_a_que_se_calle() {
    super::init_for_tests();
    let ws = tmp();
    let proc = super::start(spec("echo compilando; sleep 30", &ws)).unwrap();
    let waited = logs::wait(&proc.id, &Until::Idle(Duration::from_millis(600)), Duration::from_secs(10), None, &never).unwrap();
    assert_eq!(waited, Waited::Idle);
    // Cancelar una espera la corta enseguida.
    let waited = logs::wait(&proc.id, &Until::Exit, Duration::from_secs(10), None, &|| true).unwrap();
    assert_eq!(waited, Waited::Cancelled);
    super::stop(&proc.id, true).unwrap();
}

#[cfg(unix)]
#[test]
fn el_uso_suma_al_arbol() {
    super::init_for_tests();
    let ws = tmp();
    let proc = super::start(spec("sleep 30 & sleep 30", &ws)).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let pid = crate::terminal::process_id(proc.pty_id).unwrap();
    let usage = super::stats::usage_of(&[pid]);
    let u = usage.get(&pid).unwrap();
    assert!(u.processes >= 2, "el shell y sus sleeps: {u:?}");
    assert!(u.memory > 0);
    super::stop(&proc.id, true).unwrap();
}
