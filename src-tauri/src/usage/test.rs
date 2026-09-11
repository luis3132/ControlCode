use super::claude::parse_ts;

/// El formato lo escribe la propia TUI, siempre en UTC y siempre igual — pero si se
/// parsea mal, el consumo entero cae fuera de la ventana y el panel muestra ceros.
#[test]
fn parsea_el_timestamp_de_un_transcript_real() {
    // Tomado de un transcript de verdad.
    assert_eq!(parse_ts("2026-08-21T20:29:09.363Z"), Some(1_787_344_149));
}

#[test]
fn el_epoch_es_el_epoch() {
    assert_eq!(parse_ts("1970-01-01T00:00:00.000Z"), Some(0));
}

#[test]
fn cuenta_bien_los_bisiestos() {
    // 2024 es bisiesto y 1900 no lo era: el 29 de febrero es donde se rompen las
    // implementaciones a mano.
    assert_eq!(parse_ts("2024-02-29T00:00:00.000Z"), Some(1_709_164_800));
    assert_eq!(parse_ts("2024-03-01T00:00:00.000Z"), Some(1_709_251_200));
}

#[test]
fn un_dia_dura_un_dia() {
    let a = parse_ts("2026-01-01T00:00:00.000Z").unwrap();
    let b = parse_ts("2026-01-02T00:00:00.000Z").unwrap();
    assert_eq!(b - a, 86_400);
}

#[test]
fn tolera_que_falten_los_milisegundos() {
    assert_eq!(parse_ts("2026-08-21T20:29:09Z"), parse_ts("2026-08-21T20:29:09.000Z"));
}

#[test]
fn una_linea_rota_no_devuelve_una_fecha_inventada() {
    // Devolver `Some(0)` metería el mensaje en 1970 y lo dejaría fuera de toda ventana,
    // que es un error silencioso; `None` lo descarta explícitamente.
    for malo in ["", "ayer", "2026-08-21", "2026-08-21T20:29", "xxxx-xx-xxTxx:xx:xxZ"] {
        assert_eq!(parse_ts(malo), None, "{malo}");
    }
}

use super::claude::current_window_start;
use super::types::WINDOW_SECS;

const NOW: i64 = 1_800_000_000;

/// La ventana arranca con el primer mensaje y dura cinco horas. Es lo que responde
/// "cuánto le queda a la sesión", así que tiene que salir de las marcas REALES y no de
/// una cuenta redonda hacia atrás desde ahora.
#[test]
fn la_ventana_arranca_en_el_primer_mensaje() {
    let start = NOW - 3600;
    assert_eq!(current_window_start(vec![start, NOW - 600, NOW - 60], NOW), Some(start));
}

#[test]
fn un_hueco_de_mas_de_cinco_horas_abre_una_ventana_nueva() {
    // Trabajaste a la mañana, paraste, y volviste hace un rato: la ventana vigente es la
    // que abriste al volver, no la de la mañana.
    let manana = NOW - 20 * 3600;
    let vuelta = NOW - 1800;
    assert_eq!(
        current_window_start(vec![manana, manana + 600, vuelta, NOW - 60], NOW),
        Some(vuelta)
    );
}

#[test]
fn sin_actividad_reciente_no_hay_ventana_abierta() {
    // El último mensaje quedó fuera de la ventana: ya se reabrió y no hay nada que contar.
    assert_eq!(current_window_start(vec![NOW - WINDOW_SECS - 60], NOW), None);
}

#[test]
fn el_limite_exacto_cuenta_como_vencida() {
    assert_eq!(current_window_start(vec![NOW - WINDOW_SECS], NOW), None);
    assert!(current_window_start(vec![NOW - WINDOW_SECS + 1], NOW).is_some());
}

#[test]
fn no_importa_en_que_orden_vengan_las_marcas() {
    // Se recorren varios archivos, cada uno con su propio orden.
    let start = NOW - 7200;
    let desordenadas = vec![NOW - 60, start, NOW - 3600, start + 10];
    assert_eq!(current_window_start(desordenadas, NOW), Some(start));
}

#[test]
fn sin_mensajes_no_hay_ventana() {
    assert_eq!(current_window_start(vec![], NOW), None);
}

// ── El panel de `/usage`, leído de la pantalla ───────────────────
//
// La captura de abajo es real: salió de abrir `claude` en una PTY y mandarle el comando.
// Se conserva con sus rarezas —el "3%used" sin espacio, los bloques de las barras, los
// encabezados repetidos por el redibujado— porque son justo las que rompen un parseo
// escrito de memoria.

use super::parse::{parse_usage_screen, strip_ansi};

const PANTALLA: &str = "\
   Settings  Status   Config   Usage   Stats
 Session
Total cost:            $0.0000
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
Current session
█▌                                                3%used
Resets 12:50pm (America/Bogota)
Current week (all models)
   ██████████████████████████████████▌                69% used
  Resets Sep 13, 11am (America/Bogota)
   +50% weekly limits promo through Sep 13 · clau.de/cc-50-promo
What's contributing to your limits usage?
Current week (Fable)
████████████▌                                      25% used
";

#[test]
fn lee_las_tres_barras_de_una_captura_real() {
    let u = parse_usage_screen(PANTALLA);
    assert!(u.available);

    let s = u.session.expect("la ventana corta");
    assert_eq!(s.percent, 3, "el '3%used' sin espacio tiene que leerse igual");
    assert_eq!(s.resets.as_deref(), Some("12:50pm (America/Bogota)"));

    let w = u.week.expect("la semana");
    assert_eq!(w.percent, 69);
    assert_eq!(w.resets.as_deref(), Some("Sep 13, 11am (America/Bogota)"));

    assert_eq!(u.week_model.as_deref(), Some("Fable"));
    assert_eq!(u.week_model_meter.expect("la semana del modelo").percent, 25);
}

#[test]
fn el_promo_con_porcentaje_no_se_confunde_con_una_barra() {
    // "+50% weekly limits promo" tiene un porcentaje y está justo debajo de la semana.
    // Sin exigir la palabra "used", se leería como el consumo semanal.
    let u = parse_usage_screen(PANTALLA);
    assert_eq!(u.week.unwrap().percent, 69);
}

#[test]
fn all_models_no_es_un_modelo() {
    let u = parse_usage_screen(PANTALLA);
    assert_eq!(u.week_model.as_deref(), Some("Fable"), "el modelo es Fable, no 'all models'");
}

#[test]
fn una_salida_sin_panel_no_inventa_ceros() {
    // Mostrar 0% se leería como "no gastaste nada", que es una mentira distinta a
    // "no se pudo preguntar".
    let u = parse_usage_screen("bienvenido a la TUI\n> \n");
    assert!(!u.available);
    assert!(u.problem.is_some());
    assert!(u.session.is_none() && u.week.is_none());
}

#[test]
fn descarta_un_porcentaje_imposible() {
    let u = parse_usage_screen("Current session\n999% used\n");
    assert!(u.session.is_none());
}

#[test]
fn quita_los_escapes_y_los_bloques_de_las_barras() {
    let raw = "\x1b[32m\x1b[1mCurrent session\x1b[0m\n\x1b]0;titulo\x07█▌ 7% used\n";
    let limpio = strip_ansi(raw);
    assert!(limpio.contains("Current session"));
    assert!(limpio.contains("7% used"));
    assert!(!limpio.contains('\x1b'), "quedaron escapes: {limpio:?}");
    assert!(!limpio.contains('█'));
}

#[test]
fn un_encabezado_sin_su_barra_no_arrastra_la_de_abajo() {
    // Si una sección quedó cortada, su porcentaje no puede salir de la siguiente.
    let u = parse_usage_screen("Current session\n\n\n\n\n\nCurrent week (all models)\n42% used\n");
    assert!(u.session.is_none());
    assert_eq!(u.week.unwrap().percent, 42);
}
