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
