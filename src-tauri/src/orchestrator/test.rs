//! Tests del modo orquestador: cursores de lectura, digest y modo push.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use super::digest::{
    digest, estimate_tokens, strip_ansi, visible_line, MAX_LINE_CHARS, SPINNER_GLYPHS,
};
use super::watch::{
    add, clear, count, note_exit, observe, push_event, remove_tab, wait, WatchEvent,
    DEFAULT_IDLE_SECS, ERROR_LINES_PER_EVENT, MAX_QUEUED_EVENTS,
};
use super::{forget_cursor, new_output_for, watch_limit, DEFAULT_WATCH_LIMIT, WATCH_LIMIT_KEY};

// ── Cursores de lectura ─────────────────────────────────────────

/// Lo que hace que dos llamadas seguidas no cuesten dos veces lo mismo.
#[test]
fn una_segunda_lectura_solo_devuelve_lo_que_llego_despues() {
    forget_cursor("t1");

    let first = new_output_for("t1", "hola\n", 5);
    assert!(first.first_read);
    assert_eq!(first.text, "hola\n");

    let second = new_output_for("t1", "hola\nchau\n", 10);
    assert!(!second.first_read);
    assert_eq!(second.text, "chau\n");

    // Sin salida nueva, no se devuelve nada — el caso que antes reenviaba 200 líneas.
    assert_eq!(new_output_for("t1", "hola\nchau\n", 10).text, "");
}

/// El buffer se recorta por delante al pasar de 3MB. Si mientras tanto se escribió más
/// de lo que el buffer conserva, hay que decirlo en vez de devolver un pedazo cualquiera.
#[test]
fn lo_que_se_perdio_en_el_recorte_del_scrollback_se_reporta() {
    forget_cursor("t2");
    new_output_for("t2", "inicio", 6);

    // Se escribieron 1000 bytes más, pero el buffer solo conserva 10.
    let out = new_output_for("t2", "0123456789", 1006);
    assert!(out.lost);
    assert_eq!(out.text, "0123456789");
}

/// Reanudar una tab crea un PTY nuevo cuyo total arranca de cero. Con el cursor viejo,
/// la resta daría negativo.
#[test]
fn un_pty_reiniciado_se_trata_como_primera_lectura() {
    forget_cursor("t3");
    new_output_for("t3", "sesion vieja larga", 500);

    let out = new_output_for("t3", "sesion nueva", 12);
    assert!(out.first_read);
    assert_eq!(out.text, "sesion nueva");
}

/// El corte se hace por bytes: si cae en medio de un carácter multibyte, `&s[cut..]`
/// paniquea. Un acento partido entre dos chunks es lo más común del mundo.
#[test]
fn cortar_dentro_de_un_caracter_multibyte_no_paniquea() {
    forget_cursor("t4");
    new_output_for("t4", "ñ", 2);
    let out = new_output_for("t4", "ñañ", 5);
    assert!(out.text.ends_with("ñ"));
}

// ── Límite de tabs observadas ───────────────────────────────────

fn memory_db() -> crate::database::DbConnection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .unwrap();
    std::sync::Arc::new(std::sync::Mutex::new(conn))
}

/// Quedarse sin límite sería peor que ignorar una configuración rota.
#[test]
fn el_limite_cae_al_default_si_el_ajuste_es_basura() {
    let db = memory_db();
    assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT);

    crate::database::set_setting(&db, WATCH_LIMIT_KEY, "no soy un numero").unwrap();
    assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT);

    crate::database::set_setting(&db, WATCH_LIMIT_KEY, "0").unwrap();
    assert_eq!(watch_limit(&db), DEFAULT_WATCH_LIMIT, "cero sería 'ninguna tab observable'");

    crate::database::set_setting(&db, WATCH_LIMIT_KEY, "5").unwrap();
    assert_eq!(watch_limit(&db), 5);
}

// ── Digest: comprimir la salida antes de devolverla ─────────────

/// Una línea de terminal no es lo que se ve: trae ANSI y se reescribe con `\r`. Una barra
/// de progreso es UNA línea física reescrita muchas veces, y devolver las 40 versiones
/// intermedias es el caso más caro y más inútil que existía.
#[test]
fn una_linea_se_reduce_a_lo_que_de_verdad_se_ve() {
    assert_eq!(strip_ansi("\x1b[31mrojo\x1b[0m"), "rojo");
    assert_eq!(strip_ansi("\x1b]0;titulo\x07hola"), "hola");
    assert_eq!(strip_ansi("\x1b[2J\x1b[Hlimpio"), "limpio");
    // El hyperlink OSC 8 termina con ESC \ en vez de BEL.
    assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link"), "link");

    assert_eq!(visible_line("5%\r10%\r100% listo"), "100% listo");
    // CRLF no debe vaciar la línea.
    assert_eq!(visible_line("terminado\r"), "terminado");
}

#[test]
fn las_lineas_en_blanco_y_los_spinners_sueltos_se_descartan() {
    let d = digest("uno\n\n\n|\n/\ndos", 10);
    assert_eq!(d.tail, vec!["uno", "dos"]);
    assert_eq!(d.raw_lines, 6);
    assert_eq!(d.kept_lines, 2);
}

/// El caso de un redibujado de TUI: la misma línea con otro marco de spinner. Colapsar
/// solo aplica a líneas CONSECUTIVAS — dos ejecuciones separadas del mismo comando son
/// dos hechos distintos y el orquestador tiene que poder verlos.
#[test]
fn los_redibujados_colapsan_pero_las_repeticiones_separadas_no() {
    let d = digest("⠋ Pensando\n⠙ Pensando\n⠹ Pensando\n⠸ Pensando\nListo", 10);
    assert_eq!(d.tail, vec!["⠸ Pensando (×4)", "Listo"]);

    let d = digest("build ok\nalgo\nbuild ok", 10);
    assert_eq!(d.tail, vec!["build ok", "algo", "build ok"]);
}

/// Lo que justifica toda la fase: un error de hace mil líneas sobrevive al recorte de
/// la cola, que conserva el final y no el principio.
#[test]
fn los_errores_sobreviven_aunque_queden_fuera_de_la_cola() {
    let mut raw = String::from("ERROR: no se pudo compilar main.rs\n");
    for i in 0..500 {
        raw.push_str(&format!("linea de relleno {i}\n"));
    }
    let d = digest(&raw, 5);
    assert_eq!(d.tail, vec!["linea de relleno 495", "linea de relleno 496", "linea de relleno 497", "linea de relleno 498", "linea de relleno 499"]);
    assert_eq!(d.errors, vec!["ERROR: no se pudo compilar main.rs"]);
}

#[test]
fn los_avisos_y_los_errores_van_en_baldes_distintos() {
    let d = digest("warning: campo sin usar\nError: falta un punto y coma", 10);
    assert_eq!(d.warnings, vec!["warning: campo sin usar"]);
    assert_eq!(d.errors, vec!["Error: falta un punto y coma"]);
}

/// "0 errors" es el final feliz de casi todo build. Reportarlo como error mandaría al
/// orquestador a leer el crudo de una tab que está perfecta.
#[test]
fn un_resumen_de_cero_errores_no_es_un_error() {
    let d = digest("Compiled with 0 errors\nno errors found\nfinished", 10);
    assert!(d.errors.is_empty());
    assert!(d.warnings.is_empty());
}

#[test]
fn el_mismo_error_repetido_se_reporta_una_vez_con_su_cuenta() {
    let d = digest("ERROR: x\nok\nERROR: x\nok\nERROR: x", 10);
    assert_eq!(d.errors, vec!["ERROR: x (×3)"]);
}

#[test]
fn las_lineas_larguisimas_se_truncan() {
    let d = digest(&format!("ERROR {}", "e".repeat(1000)), 10);
    assert!(d.errors[0].ends_with('…'));
    assert!(d.errors[0].chars().count() <= MAX_LINE_CHARS + 1);
}

/// Medición del ahorro sobre una entrada con la forma real de una TUI de agente:
/// spinner redibujado + ANSI + padding.
#[test]
fn un_transcript_realista_de_agente_se_achica_muchisimo() {
    let mut raw = String::new();
    for i in 0..200 {
        let frame = SPINNER_GLYPHS[i % 10];
        raw.push_str(&format!("\x1b[2K\r\x1b[36m{frame}\x1b[0m Trabajando…\n\n"));
    }
    raw.push_str("Listo: 3 archivos modificados\n");

    let d = digest(&raw, 40);
    let before = estimate_tokens(&raw);
    let after = estimate_tokens(&d.tail.join("\n"));
    assert_eq!(d.tail.len(), 2, "200 marcos de spinner tienen que quedar en 1 línea");
    assert!(after * 10 < before, "esperado un ahorro grande: {before} → {after}");
}

// ── Modo push: las tabs avisan en vez de que el orquestador relea ─

/// Los tests comparten el registro global (es estado de proceso, como el de PTYs), así
/// que corren en serie bajo este lock en vez de pisarse entre ellos.
static TEST_LOCK: Mutex<()> = Mutex::new(());

fn fresh() -> MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    clear();
    guard
}

#[test]
fn el_limite_es_lo_que_evita_que_el_orquestador_observe_todo() {
    let _g = fresh();
    assert!(add(1, "tab-a", DEFAULT_IDLE_SECS, 2).is_ok());
    assert!(add(2, "tab-b", DEFAULT_IDLE_SECS, 2).is_ok());

    let err = add(3, "tab-c", DEFAULT_IDLE_SECS, 2).unwrap_err();
    assert!(err.contains("Límite"), "el error tiene que explicar el límite: {err}");
    assert_eq!(count(), 2);

    // Soltar una libera el slot.
    assert!(remove_tab("tab-a"));
    assert!(add(3, "tab-c", DEFAULT_IDLE_SECS, 2).is_ok());
}

#[test]
fn observar_dos_veces_la_misma_tab_se_rechaza_en_vez_de_quemar_un_slot() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
    assert!(add(9, "tab-a", DEFAULT_IDLE_SECS, 3).is_err());
    assert_eq!(count(), 1);
}

#[test]
fn una_linea_de_error_produce_un_evento_y_la_salida_normal_no() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

    observe(1, b"compilando...\ntodo bien\n");
    assert!(wait(Duration::from_millis(10), 10).is_empty());

    observe(1, b"ERROR: falta el modulo x\n");
    let events = wait(Duration::from_millis(10), 10);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "error");
    assert_eq!(events[0].tab_id, "tab-a");
    assert_eq!(events[0].lines, vec!["ERROR: falta el modulo x"]);
}

/// Un stack trace son cientos de líneas de error de golpe. Sin cooldown, cada una
/// sería un evento y el orquestador recibiría justo la avalancha que esta fase evita.
#[test]
fn una_rafaga_de_errores_colapsa_en_un_solo_evento() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

    for i in 0..50 {
        observe(1, format!("ERROR numero {i}\n").as_bytes());
    }
    let events = wait(Duration::from_millis(10), 100);
    assert_eq!(events.len(), 1);
    assert!(events[0].lines.len() <= ERROR_LINES_PER_EVENT);
}

/// El PTY corta por tamaño de buffer, no por línea: "ERR" y "OR: x\n" llegan separados
/// y ninguno de los dos, por sí solo, parece un error.
#[test]
fn un_error_partido_en_dos_chunks_igual_se_detecta() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();

    observe(1, b"ERR");
    assert!(wait(Duration::from_millis(10), 10).is_empty());
    observe(1, b"OR: se rompio\n");

    let events = wait(Duration::from_millis(10), 10);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].lines, vec!["ERROR: se rompio"]);
}

/// El color no debe tapar el error: las TUIs los pintan de rojo.
#[test]
fn los_errores_con_color_tambien_se_detectan() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
    observe(1, b"\x1b[31mError\x1b[0m: build roto\n");
    let events = wait(Duration::from_millis(10), 10);
    assert_eq!(events[0].lines, vec!["Error: build roto"]);
}

#[test]
fn la_salida_de_la_tab_emite_un_evento_y_libera_el_slot() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
    note_exit(1, 130);

    let events = wait(Duration::from_millis(10), 10);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "exit");
    assert_eq!(events[0].exit_code, Some(130));
    assert_eq!(count(), 0, "una tab muerta no debe seguir ocupando un slot");
}

#[test]
fn no_se_observa_nada_de_las_tabs_que_nadie_pidio() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
    observe(7, b"ERROR: de otra tab\n");
    note_exit(7, 1);
    assert!(wait(Duration::from_millis(10), 10).is_empty());
}

/// `wait` con la cola vacía tiene que devolver vacío al vencer el timeout, no colgarse.
#[test]
fn esperar_sin_nada_que_reportar_vence_vacio() {
    let _g = fresh();
    let started = std::time::Instant::now();
    assert!(wait(Duration::from_millis(50), 10).is_empty());
    assert!(started.elapsed() >= Duration::from_millis(45));
}

/// Los eventos se consumen: dos llamadas seguidas no devuelven lo mismo dos veces
/// (que es exactamente el desperdicio de contexto que produce el polling).
#[test]
fn los_eventos_se_drenan_una_sola_vez() {
    let _g = fresh();
    add(1, "tab-a", DEFAULT_IDLE_SECS, 3).unwrap();
    observe(1, b"ERROR: uno\n");

    assert_eq!(wait(Duration::from_millis(10), 10).len(), 1);
    assert!(wait(Duration::from_millis(10), 10).is_empty());
}

#[test]
fn la_cola_tira_los_eventos_mas_viejos_en_vez_de_crecer_sin_fin() {
    let _g = fresh();
    for i in 0..(MAX_QUEUED_EVENTS + 20) {
        push_event(WatchEvent {
            tab_id: format!("t{i}"),
            kind: "idle".into(),
            at: 0,
            lines: Vec::new(),
            exit_code: None,
        });
    }
    let events = wait(Duration::from_millis(10), 10_000);
    assert_eq!(events.len(), MAX_QUEUED_EVENTS);
    assert_eq!(events[0].tab_id, "t20", "se conservan los más recientes");
}
