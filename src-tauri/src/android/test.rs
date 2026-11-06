use super::adb::{parse_avds, parse_devices, png_size};
use super::commands::{input_command, UserInput};
use super::pointer::{enqueue, gesture_command, Op, Phase};
use super::stream::{message, parse_display_size, parse_request, video_size};
use super::h264::{codec_name, escape, low_latency_sps, sps_info, unescape, Splitter, Unit};
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
    assert_eq!(input_command(&UserInput::Move { x: 3, y: 4 }).unwrap(), "input motionevent MOVE 3 4");
}

/// El SPS que manda un Poco X3 Pro (Android 12) con `screenrecord --size 540x1200`: perfil
/// High, con VUI y `max_num_reorder_frames` 0.
const PHONE_SPS: [u8; 19] = [
    0x67, 0x64, 0x00, 0x2a, 0xac, 0xb4, 0x04, 0x40, 0x4b, 0xf7, 0xca, 0x41, 0x41, 0x81, 0x81, 0xb4, 0x28, 0x4d, 0x40,
];

#[test]
fn el_sps_se_reescribe_para_no_retener_cuadros() {
    let info = sps_info(&PHONE_SPS).unwrap();
    assert_eq!((info.width, info.height, info.reorder), (540, 1200, Some(0)));
    let (fixed, _) = low_latency_sps(&PHONE_SPS).unwrap();
    let again = sps_info(&fixed).unwrap();
    assert_eq!((again.width, again.height, again.reorder), (540, 1200, Some(0)));
    // El perfil y el nivel no cambian, y reescribirlo de nuevo da lo mismo.
    assert_eq!(fixed[..4], PHONE_SPS[..4]);
    assert_eq!(low_latency_sps(&fixed).unwrap().0, fixed);
    assert_eq!(codec_name(&fixed), "avc1.64002a");
}

#[test]
fn a_un_sps_sin_vui_se_le_agrega_la_restriccion() {
    // Baseline 320x240 sin VUI: profile 66, level 30, refs 1, 20x15 macrobloques.
    let mut w = Vec::new();
    let bits = "1" /* sps_id 0 */.to_string()
        + "1" /* log2_max_frame_num 4 */
        + "011" /* poc type 2 */
        + "010" /* refs 1 */
        + "0" /* gaps */
        + "000010100" /* width_mbs-1 = 19 */
        + "0001111" /* height-1 = 14 */
        + "1" /* frame_mbs_only */
        + "1" /* direct_8x8 */
        + "0" /* crop */
        + "0" /* vui */
        + "1"; /* stop */
    let mut padded = bits.clone();
    while !padded.len().is_multiple_of(8) {
        padded.push('0');
    }
    w.extend([0x67, 66, 0xc0, 30]);
    w.extend(padded.as_bytes().chunks(8).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 2).unwrap()));
    let info = sps_info(&w).unwrap();
    assert_eq!((info.width, info.height, info.reorder), (320, 240, None));
    let (fixed, _) = low_latency_sps(&w).unwrap();
    assert_eq!(sps_info(&fixed).unwrap().reorder, Some(0));
}

#[test]
fn los_bytes_de_prevencion_van_y_vuelven() {
    let raw = [0u8, 0, 1, 5, 0, 0, 0, 0, 3, 9];
    let escaped = escape(&raw);
    assert_eq!(escaped, [0, 0, 3, 1, 5, 0, 0, 3, 0, 0, 3, 3, 9]);
    assert_eq!(unescape(&escaped), raw);
}

/// Un stream Annex B de prueba: SPS, PPS, un cuadro clave y uno que no lo es.
fn sample_stream() -> Vec<u8> {
    let mut s = vec![0, 0, 0, 1];
    s.extend(PHONE_SPS);
    s.extend([0, 0, 0, 1, 0x68, 0xee, 0x06, 0xf2, 0xc0]);
    s.extend([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x21]);
    s.extend([0, 0, 1, 0x41, 0x9a, 0x02, 0x04]);
    s
}

#[test]
fn el_stream_se_corta_en_cuadros_y_el_ultimo_sale_al_quedar_quieto() {
    let mut split = Splitter::default();
    let units = split.push(&sample_stream());
    assert_eq!(units.len(), 2, "{units:?}");
    let Unit::Config { codec, avcc, width, height } = &units[0] else { panic!("{units:?}") };
    assert_eq!((codec.as_str(), *width, *height), ("avc1.64002a", 540, 1200));
    assert_eq!(avcc[0], 1);
    assert_eq!(units[1], Unit::Frame { key: true, data: vec![0, 0, 0, 5, 0x65, 0x88, 0x84, 0x00, 0x21] });
    // El último no se sabe completo hasta que el pipe se queda quieto.
    assert_eq!(split.idle(), vec![Unit::Frame { key: false, data: vec![0, 0, 0, 4, 0x41, 0x9a, 0x02, 0x04] }]);
    assert!(split.idle().is_empty());
    // Lo siguiente empieza con un inicio de NAL: todo bien.
    assert!(split.push(&[0, 0, 1, 0x41, 0x9a, 0x07]).is_empty());
    assert_eq!(split.idle().len(), 1);
}

#[test]
fn da_lo_mismo_si_el_stream_llega_de_a_un_byte() {
    let mut whole = Splitter::default();
    let mut expected = whole.push(&sample_stream());
    expected.extend(whole.idle());
    let mut split = Splitter::default();
    let mut got = Vec::new();
    for b in sample_stream() {
        got.extend(split.push(&[b]));
    }
    got.extend(split.idle());
    assert_eq!(got, expected);
}

#[test]
fn si_lo_cerrado_estaba_incompleto_avisa() {
    let mut split = Splitter::default();
    split.push(&sample_stream());
    split.idle();
    // Llega la cola del cuadro que se dio por terminado.
    assert_eq!(split.push(&[0x12, 0x34, 0, 0, 1, 0x41, 0x9a, 0x01]), vec![Unit::Broken]);
    // Hasta el próximo cuadro clave no sale nada.
    assert!(split.idle().is_empty());
    let mut key = vec![0, 0, 1, 0x65, 0x88, 0x01];
    key.extend([0, 0, 1, 0x41, 0x9a, 0x02]);
    assert!(matches!(split.push(&key)[..], [Unit::Frame { key: true, .. }]));
}

#[test]
fn los_moves_que_esperan_se_juntan_en_el_ultimo() {
    let mut queue = std::collections::VecDeque::new();
    enqueue(&mut queue, Op::Pointer(Phase::Down, 1, 1));
    enqueue(&mut queue, Op::Pointer(Phase::Move, 2, 2));
    enqueue(&mut queue, Op::Pointer(Phase::Move, 3, 3));
    enqueue(&mut queue, Op::Pointer(Phase::Move, 4, 4));
    enqueue(&mut queue, Op::Pointer(Phase::Up, 4, 4));
    enqueue(&mut queue, Op::Command("input keyevent 4".into()));
    assert_eq!(
        Vec::from(queue),
        vec![
            Op::Pointer(Phase::Down, 1, 1),
            Op::Pointer(Phase::Move, 4, 4),
            Op::Pointer(Phase::Up, 4, 4),
            Op::Command("input keyevent 4".into()),
        ]
    );
}

#[test]
fn sin_motionevent_el_gesto_se_arma_al_soltar() {
    use std::time::Duration;
    assert_eq!(gesture_command((10, 10), (15, 12), Duration::from_millis(90)), "input tap 10 10");
    assert_eq!(gesture_command((10, 10), (12, 10), Duration::from_millis(800)), "input swipe 10 10 10 10 800");
    assert_eq!(gesture_command((10, 10), (10, 500), Duration::from_millis(20)), "input swipe 10 10 10 500 80");
}

#[test]
fn el_video_se_pide_con_token_y_serial() {
    assert_eq!(
        parse_request("GET /screen?token=abc&serial=192.168.1.5%3A5555 HTTP/1.1\r\n", "abc").as_deref(),
        Some("192.168.1.5:5555")
    );
    assert_eq!(parse_request("GET /screen?token=nope&serial=x HTTP/1.1", "abc"), None);
    assert_eq!(parse_request("GET /other?token=abc&serial=x HTTP/1.1", "abc"), None);
    assert_eq!(parse_request("POST /screen?token=abc&serial=x HTTP/1.1", "abc"), None);
    assert_eq!(message(2, &[]), vec![0, 0, 0, 1, 2]);
    assert_eq!(message(1, &[9, 9]), vec![0, 0, 0, 3, 1, 9, 9]);
}

#[test]
fn el_tamano_de_la_pantalla_sigue_la_rotacion() {
    assert_eq!(parse_display_size("cur=2400x1080\nPhysical size: 1080x2400\n"), Some((2400, 1080)));
    assert_eq!(parse_display_size("Physical size: 1080x2400\nOverride size: 720x1600\n"), Some((720, 1600)));
    assert_eq!(parse_display_size("Physical size: 1344x2992\n"), Some((1344, 2992)));
    assert_eq!(parse_display_size("nada"), None);
    assert_eq!(video_size((1080, 2400), 1600), (720, 1600));
    assert_eq!(video_size((2400, 1080), 1280), (1280, 576));
    assert_eq!(video_size((720, 1280), 1600), (720, 1280));
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

/// El video y el dedo en vivo, contra un dispositivo de verdad: `ANDROID_SERIAL=… cargo test
/// android::test::en_un_dispositivo_el_video -- --ignored --nocapture`.
#[test]
#[ignore]
fn en_un_dispositivo_el_video_llega_y_el_dedo_arrastra() {
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    let serial = std::env::var("ANDROID_SERIAL").unwrap_or_else(|_| "emulator-5554".into());
    let url = super::stream::url(&serial).unwrap();
    let rest = url.strip_prefix("http://").unwrap();
    let (host, path) = rest.split_once('/').unwrap();
    let mut conn = std::net::TcpStream::connect(host).unwrap();
    write!(conn, "GET /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    conn.set_read_timeout(Some(Duration::from_millis(200))).unwrap();

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = errors.clone();
    let on_error: super::pointer::OnError = Arc::new(move |m| sink.lock().unwrap().push(m));
    let started = Instant::now();
    let mut data = Vec::new();
    let mut dragged = false;
    let mut buf = [0u8; 65536];
    while started.elapsed() < Duration::from_secs(8) {
        if !dragged && started.elapsed() > Duration::from_secs(2) {
            dragged = true;
            // Abrir el cajón de apps arrastrando desde abajo, en vivo.
            super::pointer::send(&serial, Op::Pointer(Phase::Down, 600, 2400), on_error.clone());
            for i in 1..=10 {
                super::pointer::send(&serial, Op::Pointer(Phase::Move, 600, 2400 - i * 120), on_error.clone());
                std::thread::sleep(Duration::from_millis(30));
            }
            super::pointer::send(&serial, Op::Pointer(Phase::Up, 600, 1200), on_error.clone());
        }
        match conn.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(_) => {}
        }
    }
    let body_at = data.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
    let head = String::from_utf8_lossy(&data[..body_at]).to_string();
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let mut kinds = std::collections::BTreeMap::<u8, usize>::new();
    let mut at = body_at;
    let mut config = String::new();
    while at + 5 <= data.len() {
        let len = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
        if at + 4 + len > data.len() {
            break;
        }
        let kind = data[at + 4];
        if kind == 0 {
            let json_len = u16::from_be_bytes([data[at + 5], data[at + 6]]) as usize;
            config = String::from_utf8_lossy(&data[at + 7..at + 7 + json_len]).to_string();
        }
        if kind == 3 {
            panic!("error: {}", String::from_utf8_lossy(&data[at + 5..at + 4 + len]));
        }
        *kinds.entry(kind).or_default() += 1;
        at += 4 + len;
    }
    println!("mensajes por tipo: {kinds:?}\nconfig: {config}\nerrores del dedo: {:?}", errors.lock().unwrap());
    assert!(kinds.contains_key(&0), "llegó la configuración");
    assert!(kinds.get(&1).copied().unwrap_or(0) > 5, "llegaron cuadros");
    assert!(errors.lock().unwrap().is_empty());
}

/// Deja el servidor de video andando un minuto e imprime la dirección, para probarlo desde
/// un navegador: `cargo test android::test::sirve_el_video -- --ignored --nocapture`.
#[test]
#[ignore]
fn sirve_el_video_un_minuto() {
    let serial = std::env::var("ANDROID_SERIAL").unwrap_or_else(|_| "emulator-5554".into());
    println!("URL {}", super::stream::url(&serial).unwrap());
    std::thread::sleep(std::time::Duration::from_secs(60));
}
