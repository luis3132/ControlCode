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
// La captura de abajo es literal: salió de abrir `claude` en una PTY y guardar los bytes.
// Lo importante es lo que rompió el primer intento — la TUI separa sus renglones con `\r`,
// no con `\n`, así que para cualquier parseo por líneas el panel entero es UNA línea. Se
// conserva también el `3%used` sin espacio y el aviso de promoción con su propio `%`.

use super::parse::{parse_usage_screen, strip_ansi};

const PANTALLA: &str = concat!(
    "Current session\r",
    "█▌                                                3%used\r",
    "Resets 12:50pm (America/Bogota)\r",
    "Current week (all models)\r",
    "   ██████████████████████████████████▌                69% used\r",
    "  Resets Sep 13, 11am (America/Bogota)\r",
    "   +50% weekly limits promo through Sep 13 · clau.de/cc-50-promo\r\r",
    "What's contributing to your limits usage?\r",
    "Current week (Fable)\r",
    "████████████▌                                      25% used             ",
);

#[test]
fn lee_el_panel_aunque_todo_venga_en_un_solo_renglon() {
    assert!(!PANTALLA.contains('\n'), "la captura real no trae saltos de línea");

    let u = parse_usage_screen(PANTALLA);
    assert!(u.available);

    let s = u.session.expect("la ventana en curso");
    assert_eq!(s.percent, 3, "el '3%used' sin espacio tiene que leerse igual");
    assert_eq!(s.resets.as_deref(), Some("12:50pm (America/Bogota)"));

    let w = u.week.expect("la semana");
    assert_eq!(w.percent, 69);
    assert_eq!(w.resets.as_deref(), Some("Sep 13, 11am (America/Bogota)"));
}

#[test]
fn el_aviso_de_promocion_no_se_confunde_con_una_barra() {
    // "+50% weekly limits promo" cae justo después de la barra semanal. Sin exigir la
    // palabra "used" pegada al porcentaje, se leería como el consumo de la semana.
    assert_eq!(parse_usage_screen(PANTALLA).week.unwrap().percent, 69);
}

#[test]
fn la_semana_es_la_de_todos_los_modelos_no_la_de_uno() {
    // El panel trae también "Current week (Fable)" con otro número. La semana es la
    // completa; la de un modelo suelto no lo es.
    assert_eq!(parse_usage_screen(PANTALLA).week.unwrap().percent, 69);
}

#[test]
fn sirve_igual_si_solo_esta_la_seccion_por_modelo() {
    // Un plan que no desglose por modelo no dibuja "(all models)"; ahí el rótulo a secas
    // es lo único que hay y tiene que alcanzar.
    let u = parse_usage_screen("Current week\r  12% used\r");
    assert_eq!(u.week.unwrap().percent, 12);
}

#[test]
fn una_salida_sin_panel_no_inventa_ceros() {
    // Un 0% se leería como "no gastaste nada", que es una mentira distinta a "no se pudo
    // preguntar".
    let u = parse_usage_screen("bienvenido a la TUI\r> \r");
    assert!(!u.available);
    assert!(u.problem.is_some());
    assert!(u.session.is_none() && u.week.is_none());
}

#[test]
fn descarta_un_porcentaje_imposible() {
    assert!(parse_usage_screen("Current session\r999% used\r").session.is_none());
}

#[test]
fn un_rotulo_sin_barra_no_le_roba_el_numero_a_la_siguiente() {
    let lejos = " ".repeat(600);
    let texto = format!("Current session\r{lejos}Current week (all models)\r42% used\r");
    let u = parse_usage_screen(&texto);
    assert!(u.session.is_none(), "la ventana no tiene barra y no debe tomar la semanal");
    assert_eq!(u.week.unwrap().percent, 42);
}

#[test]
fn se_queda_con_la_ultima_pintada_del_panel() {
    // La TUI repinta mientras abre: la primera pasada puede estar a medias.
    let texto = "Current session\r0% used\rCurrent session\r37% used\rResets 3pm\r";
    assert_eq!(parse_usage_screen(texto).session.unwrap().percent, 37);
}

#[test]
fn quita_los_escapes_y_los_bloques_de_las_barras() {
    let raw = "\x1b[32m\x1b[1mCurrent session\x1b[0m\r\x1b]0;titulo\x07█▌ 7% used\r";
    let limpio = strip_ansi(raw);
    assert!(limpio.contains("Current session") && limpio.contains("7% used"));
    assert!(!limpio.contains('\x1b'), "quedaron escapes: {limpio:?}");
    assert!(!limpio.contains('█'));
}

/// Comprobación contra los BYTES crudos de una captura, escapes incluidos. Solo corre si
/// se le pasa el archivo por variable de entorno; es una verificación puntual, no algo que
/// tenga que estar en la máquina de todos.
#[test]
fn contra_una_captura_cruda_en_disco() {
    let Ok(path) = std::env::var("CC_USAGE_CAPTURE") else { return };
    let raw = std::fs::read(&path).expect("leer la captura");
    let texto = String::from_utf8_lossy(&raw);
    let u = parse_usage_screen(&texto);
    println!(
        "session={:?} week={:?} available={}",
        u.session, u.week, u.available
    );
    assert!(u.available, "no se encontró el panel en la captura cruda");
    assert!(u.session.is_some() && u.week.is_some());
}


// ── El desglose por modelo ───────────────────────────────────────

#[test]
fn lee_las_semanas_por_modelo() {
    // El plan mide Fable aparte y con su propio número: sale JUNTO a la semana completa,
    // no en lugar de ella.
    let u = parse_usage_screen(PANTALLA);
    assert_eq!(u.week.unwrap().percent, 69, "la semana completa no cambia");
    assert_eq!(u.week_models.len(), 1);
    assert_eq!(u.week_models[0].model, "Fable");
    assert_eq!(u.week_models[0].meter.percent, 25);
}

#[test]
fn el_desglose_no_incluye_la_semana_completa() {
    let u = parse_usage_screen(PANTALLA);
    assert!(
        !u.week_models.iter().any(|m| m.model.eq_ignore_ascii_case("all models")),
        "'all models' es la semana entera, no un modelo"
    );
}

#[test]
fn de_un_modelo_repetido_gana_la_ultima_pintada() {
    let texto = "Current week (Fable)\r1% used\rCurrent week (Fable)\r44% used\r";
    let u = parse_usage_screen(texto);
    assert_eq!(u.week_models.len(), 1, "no se duplica el modelo");
    assert_eq!(u.week_models[0].meter.percent, 44);
}

// ── En qué carpeta se puede abrir el sondeo ──────────────────────
//
// Acá estaba el fallo con las cuentas alternativas: cada perfil lleva su propia lista de
// carpetas de confianza, y uno recién creado no confía en ninguna.

use super::trust::{pick_trusted, trusted_paths};

fn config(json: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap()
}

#[test]
fn lee_solo_las_carpetas_aceptadas() {
    let c = config(r#"{"projects":{
        "/a":{"hasTrustDialogAccepted":true},
        "/b":{"hasTrustDialogAccepted":false},
        "/c":{}
    }}"#);
    assert_eq!(trusted_paths(&c), vec!["/a".to_string()]);
}

#[test]
fn una_cuenta_nueva_no_confia_en_nada() {
    assert!(trusted_paths(&config(r#"{}"#)).is_empty());
    assert!(trusted_paths(&config(r#"{"projects":{}}"#)).is_empty());
}

#[test]
fn el_orden_es_estable() {
    // Sin ordenar, el sondeo elegiría una carpeta distinta en cada arranque según cómo se
    // haya deserializado el mapa, y un fallo sería imposible de reproducir.
    let c = config(r#"{"projects":{
        "/z":{"hasTrustDialogAccepted":true},
        "/a":{"hasTrustDialogAccepted":true}
    }}"#);
    assert_eq!(trusted_paths(&c), vec!["/a".to_string(), "/z".to_string()]);
}

#[test]
fn gana_la_carpeta_pedida_si_la_cuenta_confia_en_ella() {
    let trusted = vec!["/a".to_string(), "/proyecto".to_string()];
    assert_eq!(pick_trusted(&trusted, Some("/proyecto"), |_| true), Some("/proyecto"));
}

#[test]
fn si_la_pedida_no_es_de_confianza_se_usa_otra_de_la_cuenta() {
    // Es el caso de la cuenta alternativa: el proyecto abierto no está en SU lista.
    let trusted = vec!["/otra".to_string()];
    assert_eq!(pick_trusted(&trusted, Some("/proyecto"), |_| true), Some("/otra"));
}

#[test]
fn se_saltean_las_carpetas_que_ya_no_existen() {
    // La lista de confianza guarda rutas viejas para siempre; abrir el sondeo en una que
    // se borró dejaría a la TUI protestando.
    let trusted = vec!["/borrada".to_string(), "/viva".to_string()];
    assert_eq!(pick_trusted(&trusted, None, |p| p == "/viva"), Some("/viva"));
}

#[test]
fn sin_ninguna_carpeta_de_confianza_no_se_sondea() {
    assert_eq!(pick_trusted(&[], Some("/proyecto"), |_| true), None);
    assert_eq!(pick_trusted(&["/borrada".to_string()], None, |_| false), None);
}
