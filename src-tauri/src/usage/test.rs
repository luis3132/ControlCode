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
// Acá está lo que rompía el parseo: la TUI no escribe espacios, separa TODO moviendo el
// cursor —hasta las palabras de un rótulo— y repinta el panel mientras carga. Leído de
// corrido, «Current week (all models)» nunca aparece: queda «Currentweek(allmodels)». Por
// eso primero se reconstruye la pantalla (ver `screen.rs`) y recién ahí se lee.

use super::parse::parse_usage_screen;
use super::screen::render;

/// Avanzar `n` columnas, que es como la TUI separa lo que muestra.
fn col(n: usize) -> String {
    format!("\x1b[{n}C")
}

/// Un rótulo como lo manda la TUI: cada palabra colocada con el cursor, sin espacios.
fn rotulo(palabras: &[&str]) -> String {
    palabras.iter().map(|w| format!("{}{w}", col(1))).collect()
}

/// El panel tal como lo pinta la TUI: una primera pasada sin la semana por modelo
/// (mientras dice «Refreshing…») y una segunda, completa, encima de la misma pantalla.
///
/// Cada renglón se borra ANTES de pintarlo (`CSI K`), como hace una TUI al repintar: mover
/// el cursor para separar columnas salta celdas sin limpiarlas, y si no se borra primero,
/// queda lo que había debajo.
fn pantalla() -> String {
    let mut out = String::from("\x1b[2J\x1b[H");
    for pasada in 0..2 {
        let mut renglones: Vec<String> = vec![
            rotulo(&["Current", "session"]),
            format!("\x1b[1m███\x1b[0m{}3% used", col(44)),
            rotulo(&["Resets", "12:50pm", "(America/Bogota)"]),
            rotulo(&["Current", "week", "(all", "models)"]),
            format!("███████{}69% used", col(40)),
            rotulo(&["Resets", "Sep", "13,", "11am", "(America/Bogota)"]),
            rotulo(&["+50%", "weekly", "limits", "promo", "through", "Sep", "13"]),
        ];
        if pasada == 0 {
            renglones.push(rotulo(&["Refreshing…"]));
        } else {
            renglones.push(rotulo(&["Current", "week", "(Fable)"]));
            renglones.push(format!("██{}25% used", col(46)));
            renglones.push(rotulo(&["Resets", "Sep", "13,", "11am", "(America/Bogota)"]));
        }
        renglones.push(rotulo(&["What's", "contributing", "to", "your", "limits", "usage?"]));

        out.push_str("\x1b[H");
        for renglon in renglones {
            out.push_str("\x1b[K");
            out.push_str(&renglon);
            out.push_str("\r\n");
        }
    }
    out
}

#[test]
fn de_corrido_el_rotulo_no_existe_y_reconstruido_si() {
    let cruda = pantalla();
    let sin_escapes: String = {
        // Lo que hacía el parseo viejo: sacarle los escapes y leer de corrido.
        let mut out = String::new();
        let mut chars = cruda.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\u{1b}' {
                out.push(c);
                continue;
            }
            for siguiente in chars.by_ref() {
                if siguiente.is_ascii_alphabetic() {
                    break;
                }
            }
        }
        out
    };
    assert!(sin_escapes.contains("Currentweek(allmodels)"), "así llega: {sin_escapes:?}");
    assert!(!sin_escapes.contains("Current week (all models)"));

    let pantalla = render(&cruda);
    assert!(pantalla.contains("Current week (all models)"));
    assert!(pantalla.contains("Current session"));
}

#[test]
fn lee_las_tres_barras_del_panel() {
    let u = parse_usage_screen(&pantalla());
    assert!(u.available);

    let s = u.session.expect("la ventana en curso");
    assert_eq!(s.percent, 3);
    assert_eq!(s.resets.as_deref(), Some("12:50pm (America/Bogota)"));

    let w = u.week.expect("la semana");
    assert_eq!(w.percent, 69);
    assert_eq!(w.resets.as_deref(), Some("Sep 13, 11am (America/Bogota)"));

    assert_eq!(u.week_models.len(), 1, "la semana por modelo es la tercera barra");
    assert_eq!(u.week_models[0].model, "Fable");
    assert_eq!(u.week_models[0].meter.percent, 25);
    assert_eq!(u.week_models[0].meter.resets.as_deref(), Some("Sep 13, 11am (America/Bogota)"));
}

#[test]
fn el_aviso_de_promocion_no_se_confunde_con_una_barra() {
    // "+50% weekly limits promo" cae justo después de la barra semanal. Sin exigir la
    // palabra "used" pegada al porcentaje, se leería como el consumo de la semana.
    assert_eq!(parse_usage_screen(&pantalla()).week.unwrap().percent, 69);
}

#[test]
fn la_semana_es_la_de_todos_los_modelos_no_la_de_uno() {
    // El panel trae también "Current week (Fable)" con otro número. La semana es la
    // completa; la de un modelo suelto no lo es. Era justo lo que se leía mal: el panel
    // mostraba el 2% de Fable como si fuera el consumo de la semana.
    let u = parse_usage_screen(&pantalla());
    assert_eq!(u.week.unwrap().percent, 69);
    assert!(!u.week_models.iter().any(|m| m.model.eq_ignore_ascii_case("all models")));
}

#[test]
fn sirve_igual_si_solo_esta_la_seccion_por_modelo() {
    // Un plan que no desglose por modelo no dibuja "(all models)"; ahí el rótulo a secas
    // es lo único que hay y tiene que alcanzar.
    let u = parse_usage_screen("Current week\r\n  12% used\r\n");
    assert_eq!(u.week.unwrap().percent, 12);
}

#[test]
fn una_salida_sin_panel_no_inventa_ceros() {
    // Un 0% se leería como "no gastaste nada", que es una mentira distinta a "no se pudo
    // preguntar".
    let u = parse_usage_screen("bienvenido a la TUI\r\n> \r\n");
    assert!(!u.available);
    assert!(u.problem.is_some());
    assert!(u.session.is_none() && u.week.is_none());
}

#[test]
fn descarta_un_porcentaje_imposible() {
    assert!(parse_usage_screen("Current session\r\n999% used\r\n").session.is_none());
}

#[test]
fn un_rotulo_sin_barra_no_le_roba_el_numero_a_la_siguiente() {
    let texto = "Current session\r\n\r\n\r\n\r\n\r\nCurrent week (all models)\r\n42% used\r\n";
    let u = parse_usage_screen(texto);
    assert!(u.session.is_none(), "la ventana no tiene barra y no debe tomar la semanal");
    assert_eq!(u.week.unwrap().percent, 42);
}

#[test]
fn se_queda_con_la_ultima_pintada_del_panel() {
    // La TUI repinta mientras abre: la primera pasada puede estar a medias.
    let texto = "\x1b[H Current session\r\n 0% used\r\n\x1b[H Current session\r\n 37% used\x1b[K\r\n";
    assert_eq!(parse_usage_screen(texto).session.unwrap().percent, 37);
}

#[test]
fn de_un_modelo_repetido_gana_la_ultima_pintada() {
    let texto = "\x1b[HCurrent week (Fable)\r\n1% used\r\n\x1b[HCurrent week (Fable)\r\n44% used\x1b[K\r\n";
    let u = parse_usage_screen(texto);
    assert_eq!(u.week_models.len(), 1, "no se duplica el modelo");
    assert_eq!(u.week_models[0].meter.percent, 44);
}

// ── La pantalla reconstruida ─────────────────────────────────────

#[test]
fn las_columnas_hechas_con_el_cursor_vuelven_a_ser_espacios() {
    let pantalla = render(&format!("uno{}dos", col(4)));
    assert_eq!(pantalla.lines().next(), Some("uno    dos"));
}

#[test]
fn lo_que_se_repinta_pisa_lo_anterior_y_lo_borrado_se_va() {
    let pantalla = render("viejo y largo\r\n\x1b[Hnuevo\x1b[K");
    assert_eq!(pantalla.lines().next(), Some("nuevo"));
    assert!(!pantalla.contains("largo"));
}

#[test]
fn lo_que_se_fue_por_arriba_sigue_estando() {
    // El panel es más largo que la pantalla: lo que sale por arriba ya no se repinta, así
    // que es lo último que se supo de esa parte y tiene que conservarse.
    let mut raw = String::from("Current session\r\n0% used\r\n");
    for i in 0..super::screen::ROWS + 5 {
        raw.push_str(&format!("relleno {i}\r\n"));
    }
    let pantalla = render(&raw);
    assert!(pantalla.contains("Current session"), "se perdió lo que salió de la pantalla");
    assert!(pantalla.contains(&format!("relleno {}", super::screen::ROWS + 4)));
}

#[test]
fn los_escapes_de_color_y_el_titulo_no_dejan_basura() {
    let raw = "\x1b[32m\x1b[1mCurrent session\x1b[0m\r\n\x1b]0;titulo\x07███ 7% used\r\n";
    let pantalla = render(raw);
    assert!(!pantalla.contains('\x1b'), "quedaron escapes: {pantalla:?}");
    assert!(!pantalla.contains("titulo"), "el título de la ventana no es texto del panel");
    assert_eq!(parse_usage_screen(raw).session.unwrap().percent, 7);
}

// ── Contra una captura de verdad ─────────────────────────────────

/// Bytes crudos de un `/usage` real (`claude` en una PTY de 45×100), con sus escapes.
/// Es la prueba de que esto lee el panel que la TUI dibuja hoy, no el que se supone.
const CAPTURA: &[u8] = include_bytes!("testdata/usage-panel.raw");

#[test]
fn contra_la_captura_real_del_panel() {
    let u = parse_usage_screen(&String::from_utf8_lossy(CAPTURA));
    assert!(u.available);
    assert_eq!(u.session.expect("la ventana en curso").percent, 14);

    let semana = u.week.expect("la semana");
    assert_eq!(semana.percent, 36, "la semana completa, no la de un modelo");
    assert_eq!(semana.resets.as_deref(), Some("Sep 20, 10:59am (America/Bogota)"));

    assert_eq!(u.week_models.len(), 1);
    assert_eq!(u.week_models[0].model, "Fable");
    assert_eq!(u.week_models[0].meter.percent, 2);
}

#[test]
fn el_desglose_de_abajo_no_se_lee_como_una_barra() {
    // El panel termina con "27% of your usage came from…" y una tabla de skills, subagentes
    // y MCP con sus propios porcentajes. Ninguno es una barra de consumo del plan.
    let u = parse_usage_screen(&String::from_utf8_lossy(CAPTURA));
    assert_eq!(u.week_models.len(), 1, "solo Fable: {:?}", u.week_models);
}

/// Contra la TUI instalada, de punta a punta: abre `claude`, manda `/usage`, corta cuando
/// el panel está listo y lo lee. Solo corre con `CC_USAGE_LIVE=1`, porque necesita la TUI
/// y una cuenta con sesión iniciada.
#[test]
fn contra_la_tui_de_verdad() {
    if std::env::var("CC_USAGE_LIVE").is_err() {
        return;
    }
    let dir = super::trust::probe_dir().expect("la carpeta del sondeo");
    let empezo = std::time::Instant::now();
    let pantalla = super::live::capture("claude", dir.to_str().unwrap(), &[]).expect("capturar el panel");
    let u = parse_usage_screen(&pantalla);
    println!(
        "en {:?}: session={:?} week={:?} models={:?}",
        empezo.elapsed(), u.session, u.week, u.week_models
    );
    assert!(u.session.is_some(), "falta la barra de la ventana en curso");
    assert!(u.week.is_some(), "falta la barra de la semana");
}

/// Comprobación contra los BYTES crudos de otra captura, para cuando cambie el panel. Solo
/// corre si se le pasa el archivo por variable de entorno.
#[test]
fn contra_una_captura_cruda_en_disco() {
    let Ok(path) = std::env::var("CC_USAGE_CAPTURE") else { return };
    let raw = std::fs::read(&path).expect("leer la captura");
    let u = parse_usage_screen(&String::from_utf8_lossy(&raw));
    println!(
        "session={:?} week={:?} models={:?} available={}",
        u.session, u.week, u.week_models, u.available
    );
    assert!(u.available, "no se encontró el panel en la captura cruda");
    assert!(u.session.is_some() && u.week.is_some());
}

// ── La carpeta del sondeo ────────────────────────────────────────
//
// Acá estaba el fallo del panel de consumo: se buscaba una carpeta que la cuenta ya
// hubiera aceptado, y una cuenta nueva no tiene ninguna. Ahora la carpeta la pone la app
// y se pre-aprueba sola; lo que se prueba es que ese remiendo no le rompa la
// configuración a nadie.

use super::trust::{config_file, trust_dir, with_trusted};

fn config(json: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap()
}

fn accepted(config: &serde_json::Value, dir: &str) -> bool {
    config["projects"][dir]["hasTrustDialogAccepted"] == serde_json::json!(true)
}

#[test]
fn el_archivo_de_la_cuenta_principal_esta_en_el_home_y_no_en_claude() {
    // El fallo original: `~/.claude/.claude.json` no existe, así que la cuenta principal
    // figuraba sin ninguna carpeta aceptada teniendo decenas.
    let home = dirs::home_dir().unwrap();
    assert_eq!(config_file(None), Some(home.join(".claude.json")));
}

#[test]
fn el_de_un_perfil_esta_adentro_de_su_directorio() {
    assert_eq!(
        config_file(Some("/perfiles/trabajo")),
        Some(std::path::PathBuf::from("/perfiles/trabajo/.claude.json"))
    );
}

#[test]
fn una_cuenta_nueva_queda_confiando_en_la_carpeta_del_sondeo() {
    let next = with_trusted(&config("{}"), "/sonda").expect("hay algo que escribir");
    assert!(accepted(&next, "/sonda"));
}

#[test]
fn no_se_reescribe_si_ya_estaba_aceptada() {
    // Devolver `None` es lo que evita tocar el archivo en cada sondeo: esa config la
    // escribe también la TUI mientras corre.
    let c = config(r#"{"projects":{"/sonda":{"hasTrustDialogAccepted":true}}}"#);
    assert!(with_trusted(&c, "/sonda").is_none());
}

#[test]
fn se_conserva_todo_lo_demas_de_la_configuracion() {
    // Lo importante del merge: ahí adentro está el login del usuario y el historial de sus
    // proyectos. Agregar una carpeta no puede costarle nada de eso.
    let c = config(r#"{
        "oauthAccount": {"emailAddress": "quien@ejemplo.com"},
        "projects": {"/proyecto": {"hasTrustDialogAccepted": true, "allowedTools": ["Bash"]}}
    }"#);
    let next = with_trusted(&c, "/sonda").expect("hay algo que escribir");
    assert_eq!(next["oauthAccount"]["emailAddress"], "quien@ejemplo.com");
    assert_eq!(next["projects"]["/proyecto"]["allowedTools"][0], "Bash");
    assert!(accepted(&next, "/proyecto"), "la carpeta que ya estaba sigue aceptada");
    assert!(accepted(&next, "/sonda"));
}

#[test]
fn una_carpeta_rechazada_antes_se_acepta() {
    // El caso de quien dijo que no alguna vez en esa misma ruta: el sondeo la necesita
    // aceptada, y es una carpeta de la app, vacía.
    let c = config(r#"{"projects":{"/sonda":{"hasTrustDialogAccepted":false}}}"#);
    let next = with_trusted(&c, "/sonda").expect("hay algo que escribir");
    assert!(accepted(&next, "/sonda"));
}

#[test]
fn la_escritura_deja_el_archivo_valido_y_con_sus_permisos() {
    // La parte que no se ve en el merge: el archivo real. Se escribe a un temporal y se
    // renombra, y ese temporal nace con los permisos por defecto — sin corregirlos, el
    // `~/.claude.json` del usuario (0600, con su login adentro) terminaría legible para
    // todo el sistema.
    let dir = std::env::temp_dir().join(format!("cc-trust-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(".claude.json");
    std::fs::write(&path, r#"{"oauthAccount":{"emailAddress":"quien@ejemplo.com"}}"#).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    trust_dir(&path, "/sonda").unwrap();

    let written: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(accepted(&written, "/sonda"));
    assert_eq!(written["oauthAccount"]["emailAddress"], "quien@ejemplo.com");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "no se aflojan los permisos del archivo");
    }

    // Segunda pasada: ya está aceptada, así que no se vuelve a tocar el archivo.
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    trust_dir(&path, "/sonda").unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn una_cuenta_sin_archivo_todavia_lo_estrena() {
    // Una cuenta recién creada: la TUI no escribió su config aún, y el sondeo igual tiene
    // que poder abrirse.
    let dir = std::env::temp_dir().join(format!("cc-trust-nuevo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(".claude.json");

    trust_dir(&path, "/sonda").unwrap();

    let written: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(accepted(&written, "/sonda"));

    std::fs::remove_dir_all(&dir).ok();
}
