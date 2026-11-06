use super::adb::{parse_avds, parse_devices, png_size};
use super::commands::{input_command, UserInput};
use super::input::{keycode, quote, scroll_path, type_steps, untypeable, TypeStep};
use super::ui::{find_text, parse, render};

const DUMP: &str = r#"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Iniciar sesi&#243;n" resource-id="com.example.shop:id/title" class="android.widget.TextView" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][980,300]" /><node index="1" text="" resource-id="com.example.shop:id/email" class="android.widget.EditText" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[100,400][980,520]" /><node index="2" text="" resource-id="com.example.shop:id/login" class="android.widget.LinearLayout" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,600][980,720]"><node index="0" text="Entrar &amp; seguir" resource-id="" class="android.widget.TextView" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[400,630][680,690]" /></node><node index="3" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" /><node index="4" text="" resource-id="" class="android.widget.ImageButton" package="com.example.shop" content-desc="Cerrar" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[960,40][1060,140]" /></node></hierarchy>"#;

#[test]
fn lee_los_dispositivos_de_adb() {
    let text = "List of devices attached\n\
emulator-5554          device product:sdk_gphone64_x86_64 model:Pixel_9_Pro_XL device:emu64xa transport_id:1\n\
R58M123ABC             unauthorized usb:1-1 transport_id:2\n\n";
    let devices = parse_devices(text);
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0].serial, "emulator-5554");
    assert!(devices[0].ready() && devices[0].emulator);
    assert_eq!(devices[0].name(), "Pixel 9 Pro XL");
    assert_eq!(devices[1].state, "unauthorized");
    assert!(!devices[1].ready() && !devices[1].emulator);
    assert_eq!(devices[1].name(), "R58M123ABC");
}

#[test]
fn ignora_los_avisos_del_emulador_al_listar_avds() {
    let text = "INFO    | Storing crashdata in: /tmp/x\nPixel_9_Pro_XL\nTablet_API_35\n";
    assert_eq!(parse_avds(text), vec!["Pixel_9_Pro_XL", "Tablet_API_35"]);
}

#[test]
fn lee_el_tamano_de_un_png() {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend(1080u32.to_be_bytes());
    png.extend(2400u32.to_be_bytes());
    assert_eq!(png_size(&png), Some((1080, 2400)));
    assert_eq!(png_size(b"error: device offline"), None);
}

#[test]
fn el_snapshot_muestra_solo_lo_que_importa_con_refs() {
    let nodes = parse(DUMP).unwrap();
    assert_eq!(nodes.len(), 7);
    assert_eq!(nodes[1].text, "Iniciar sesión");
    assert_eq!(nodes[1].id, "title");
    assert_eq!(nodes[3].depth, 1);
    assert_eq!(nodes[4].depth, 2);

    let (text, targets) = render(&nodes);
    let lines: Vec<&str> = text.lines().collect();
    // El contenedor raíz sin nada y el de tamaño cero no aparecen.
    assert_eq!(lines.len(), 5, "{text}");
    assert_eq!(lines[0], "[a1] TextView \"Iniciar sesión\" #title @540,250");
    assert_eq!(lines[1], "[a2] EditText #email editable long-clickable focused @540,460");
    // Un botón hecho de un contenedor se nombra con el texto de adentro, y lo de adentro va
    // sangrado debajo.
    assert_eq!(lines[2], "[a3] LinearLayout ≈\"Entrar & seguir\" #login clickable @540,660");
    assert_eq!(lines[3], "  [a4] TextView \"Entrar & seguir\" @540,660");
    assert_eq!(lines[4], "[a5] ImageButton \"Cerrar\" clickable disabled @1010,90");
    assert_eq!(targets[2].reference, "a3");
    assert_eq!(targets[2].bounds, [100, 600, 980, 720]);
}

#[test]
fn buscar_por_texto_prefiere_lo_exacto_y_tocable() {
    let nodes = parse(DUMP).unwrap();
    assert_eq!(find_text(&nodes, "cerrar").unwrap().desc, "Cerrar");
    assert_eq!(find_text(&nodes, "email").unwrap().id, "email");
    assert_eq!(find_text(&nodes, "entrar").unwrap().text, "Entrar & seguir");
    assert!(find_text(&nodes, "no existe").is_none());
}

#[test]
fn buscar_por_texto_prefiere_las_mismas_mayusculas() {
    let mut nodes = parse(DUMP).unwrap();
    // Lo que alguien escribió en el campo coincide sin mayúsculas con el título de abajo.
    nodes[2].text = "iniciar sesión".into();
    assert_eq!(find_text(&nodes, "Iniciar sesión").unwrap().id, "title");
    assert_eq!(find_text(&nodes, "iniciar sesión").unwrap().id, "email");
}

#[test]
fn una_salida_sin_pantalla_es_un_error_legible() {
    assert!(parse("ERROR: could not get idle state.").unwrap_err().contains("idle state"));
}

#[test]
fn las_teclas_se_nombran_como_las_diria_una_persona() {
    assert_eq!(keycode("back"), Some(4));
    assert_eq!(keycode("Home"), Some(3));
    assert_eq!(keycode("KEYCODE_ENTER"), Some(66));
    assert_eq!(keycode("volume-up"), Some(24));
    assert_eq!(keycode("recents"), Some(187));
    assert_eq!(keycode("82"), Some(82));
    assert_eq!(keycode("nada"), None);
}

#[test]
fn el_texto_se_parte_en_tramos_y_teclas() {
    assert_eq!(
        type_steps("hola mundo\nchau"),
        vec![TypeStep::Text("hola%smundo".into()), TypeStep::Key(66), TypeStep::Text("chau".into())]
    );
    // Un `%s` de verdad no se puede mandar junto: input lo tomaría por un espacio.
    assert_eq!(type_steps("100%s"), vec![TypeStep::Text("100%".into()), TypeStep::Text("s".into())]);
    // Pero un espacio seguido de una s sí.
    assert_eq!(type_steps("a so"), vec![TypeStep::Text("a%sso".into())]);
    assert_eq!(untypeable("señal ok"), vec!['ñ']);
    assert!(untypeable("plain text\n").is_empty());
}

#[test]
fn las_comillas_aguantan_lo_que_escriba_el_agente() {
    assert_eq!(quote("it's"), r"'it'\''s'");
    assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
}

#[test]
fn desplazar_hacia_abajo_es_arrastrar_hacia_arriba() {
    let (x1, y1, x2, y2) = scroll_path([0, 0, 1000, 2000], "down", 1.0).unwrap();
    assert_eq!((x1, x2), (500, 500));
    assert!(y1 > y2);
    let (x1, _, x2, _) = scroll_path([0, 0, 1000, 2000], "right", 0.5).unwrap();
    assert!(x1 > x2);
    assert!(scroll_path([0, 0, 10, 10], "sideways", 1.0).is_none());
}

#[test]
fn lo_que_toca_la_persona_se_traduce_a_input() {
    assert_eq!(input_command(&UserInput::Tap { x: 10, y: 20 }).unwrap(), "input tap 10 20");
    assert_eq!(input_command(&UserInput::Hold { x: 1, y: 2, ms: 5 }).unwrap(), "input swipe 1 2 1 2 100");
    assert_eq!(input_command(&UserInput::Key { key: "back".into() }).unwrap(), "input keyevent 4");
    assert_eq!(
        input_command(&UserInput::Text { text: "a b\n".into() }).unwrap(),
        "input text 'a%sb' && input keyevent 66"
    );
    assert!(input_command(&UserInput::Text { text: "ñ".into() }).is_err());
}

/// Contra un dispositivo de verdad: `cargo test android::test::en_un_dispositivo -- --ignored
/// --nocapture` con un teléfono o un emulador conectado. Recorre lo que hace un agente: ver
/// la pantalla, ir al inicio, abrir los ajustes, buscar, escribir y volver.
#[test]
#[ignore]
fn en_un_dispositivo_un_agente_ve_toca_y_escribe() {
    use super::agent::run;
    use serde_json::json;
    let go = |request: serde_json::Value| {
        let out = run(&request, "test", None).unwrap_or_else(|e| panic!("{request}: {e}"));
        println!("── {request}\n{}\n", out.text.chars().take(1500).collect::<String>());
        out
    };
    go(json!({ "op": "devices" }));
    go(json!({ "op": "key", "key": "wakeup" }));
    go(json!({ "op": "key", "key": "home" }));
    let shot = go(json!({ "op": "screenshot" }));
    let (image, mime) = shot.image.expect("una imagen");
    assert_eq!(mime, "image/jpeg");
    assert!(image.len() > 1000);
    go(json!({ "op": "app", "action": "launch", "package": "com.android.settings" }));
    go(json!({ "op": "wait", "timeout_s": 8 }));
    let snap = go(json!({ "op": "snapshot" }));
    assert!(snap.text.contains("[a1]"), "{}", snap.text);
    go(json!({ "op": "app", "action": "current" }));
    go(json!({ "op": "swipe", "direction": "down" }));
    let typed = go(json!({ "op": "type", "text": "hola mañana" }));
    assert!(typed.text.contains('ñ'), "{}", typed.text);
    go(json!({ "op": "key", "key": "back" }));
    go(json!({ "op": "logcat", "lines": 5, "level": "E" }));
    go(json!({ "op": "app", "action": "stop", "package": "com.android.settings" }));
}

/// Contra un dispositivo de verdad: tocar por ref y por texto, esperar un texto.
#[test]
#[ignore]
fn en_un_dispositivo_se_toca_por_ref_y_por_texto() {
    use super::agent::run;
    use serde_json::json;
    let go = |request: serde_json::Value| {
        let out = run(&request, "test", None).unwrap_or_else(|e| panic!("{request}: {e}"));
        println!("── {request}\n{}\n", out.text.lines().take(12).collect::<Vec<_>>().join("\n"));
        out
    };
    go(json!({ "op": "app", "action": "launch", "package": "com.android.settings" }));
    go(json!({ "op": "wait", "text": "Search Settings", "timeout_s": 10 }));
    let snap = go(json!({ "op": "snapshot" }));
    let line = snap.text.lines().find(|l| l.contains("Search Settings") && l.contains("clickable")).expect("la barra de búsqueda");
    let reference = line.trim().trim_start_matches('[').split(']').next().unwrap().to_string();
    let tap = go(json!({ "op": "tap", "ref": reference }));
    assert_eq!(tap.touches.len(), 1);
    go(json!({ "op": "type", "text": "display", "submit": true }));
    go(json!({ "op": "wait", "timeout_s": 6 }));
    go(json!({ "op": "tap", "text": "Display", "hold_ms": 600 }));
    let err = run(&json!({ "op": "tap", "ref": "a999" }), "test", None).unwrap_err();
    assert!(err.contains("a999"), "{err}");
    go(json!({ "op": "key", "key": "back, back, home" }));
}
