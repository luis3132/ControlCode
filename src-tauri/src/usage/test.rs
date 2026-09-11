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
