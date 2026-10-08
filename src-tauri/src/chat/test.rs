use serde_json::json;

use super::parse::{parse_line, transcript, ChatEvent};
use super::session::{claude_args, user_line, ChatTurn};

const TURN1: &str = include_str!("fixtures/claude_turn1.jsonl");
const TURN2: &str = include_str!("fixtures/claude_turn2.jsonl");
const SESSION: &str = include_str!("fixtures/claude_session.jsonl");

fn all(stream: &str) -> Vec<ChatEvent> {
    stream.lines().flat_map(parse_line).collect()
}

#[test]
fn un_turno_real_trae_init_herramienta_resultado_texto_y_cierre() {
    let events = all(TURN1);

    let init = events.iter().find_map(|e| match e {
        ChatEvent::Init { model, slash_commands, terminal_commands, permission_mode, .. } => {
            Some((model.clone(), slash_commands.clone(), terminal_commands.clone(), permission_mode.clone()))
        }
        _ => None,
    });
    let (model, commands, terminal, mode) = init.expect("init");
    assert_eq!(model.as_deref(), Some("claude-haiku-5-5"));
    assert!(commands.iter().any(|c| c == "compact"));
    assert!(terminal.iter().any(|c| c == "doctor"));
    assert_eq!(mode.as_deref(), Some("default"));

    // La herramienta se anuncia antes de tener su input, y después llega entera.
    let start = events.iter().position(|e| matches!(e, ChatEvent::ToolStart { name, .. } if name == "Bash"));
    let used = events.iter().position(|e| matches!(e, ChatEvent::ToolUse { .. }));
    assert!(start.unwrap() < used.unwrap());
    let ChatEvent::ToolUse { id, input, label, parent, .. } = &events[used.unwrap()] else { unreachable!() };
    assert_eq!(input["command"], "ls");
    assert_eq!(label, "Bash(ls)");
    assert!(parent.is_none());

    // El resultado apunta a la misma herramienta.
    let result = events.iter().find_map(|e| match e {
        ChatEvent::ToolResult { tool_use_id, content, is_error, .. } => Some((tool_use_id, content, is_error)),
        _ => None,
    });
    let (tool_use_id, content, is_error) = result.expect("tool_result");
    assert_eq!(tool_use_id, id);
    assert!(content.contains("a.txt"));
    assert!(!is_error);

    // El texto llega de a pedazos y después entero; los pedazos suman lo mismo.
    let deltas: String = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::TextDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let full = events.iter().find_map(|e| match e {
        ChatEvent::Text { text, .. } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(Some(deltas), full);

    match events.last() {
        Some(ChatEvent::Result { ok, cost_usd, tokens_in, tokens_out, .. }) => {
            assert!(ok);
            assert!(cost_usd.unwrap() > 0.0);
            // Con los de caché: el `input_tokens` pelado es casi cero.
            assert!(tokens_in.unwrap() > 1000);
            assert!(tokens_out.is_some());
        }
        other => panic!("el último no es el cierre: {other:?}"),
    }
}

#[test]
fn compactar_con_p_avisa_y_trae_el_resumen() {
    let events = all(TURN2);
    assert!(events.iter().any(|e| matches!(e, ChatEvent::Status { status: Some(s) } if s == "compacting")));
    let compacted = events.iter().position(|e| *e == ChatEvent::Compacted).expect("compact_boundary");
    let summary = events.iter().position(|e| matches!(e, ChatEvent::Summary { .. })).expect("resumen");
    assert!(compacted < summary);
    assert!(events.iter().any(|e| matches!(e, ChatEvent::CommandOutput { text } if text == "Compacted")));
    // El resumen no se confunde con algo que escribió la persona.
    assert!(!events.iter().any(|e| matches!(e, ChatEvent::User { .. })));
}

#[test]
fn el_historial_trae_la_conversacion_entera_sin_lo_que_inyecta_la_cli() {
    let events = transcript(SESSION);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| match e {
            ChatEvent::User { .. } => "user",
            ChatEvent::ToolUse { .. } => "tool",
            ChatEvent::ToolResult { .. } => "result",
            ChatEvent::Text { .. } => "text",
            ChatEvent::Compacted => "compacted",
            ChatEvent::Summary { .. } => "summary",
            ChatEvent::Command { .. } => "command",
            ChatEvent::CommandOutput { .. } => "output",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["user", "tool", "result", "text", "compacted", "summary", "command", "output"]);
    assert!(matches!(&events[0], ChatEvent::User { text, images: 0 } if text.starts_with("Run `ls`")));
    assert!(matches!(&events[6], ChatEvent::Command { name, args } if name == "compact" && args.is_empty()));
}

#[test]
fn thinking_imagenes_subagentes_y_errores() {
    let line = json!({"type":"assistant","parent_tool_use_id":"toolu_task","message":{"content":[
        {"type":"thinking","thinking":"veamos"},
        {"type":"text","text":"   "},
        {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a/b/c.rs"}}
    ]}});
    let events = parse_line(&line.to_string());
    assert_eq!(events.len(), 2, "el texto vacío no se dibuja");
    assert!(matches!(&events[0], ChatEvent::Thinking { text, parent: Some(p) } if text == "veamos" && p == "toolu_task"));
    assert!(matches!(&events[1], ChatEvent::ToolUse { label, .. } if label == "Read(b/c.rs)"));

    let user = json!({"type":"user","message":{"content":[
        {"type":"text","text":"mirá esto"},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}
    ]}});
    assert_eq!(parse_line(&user.to_string()), vec![ChatEvent::User { text: "mirá esto".into(), images: 1 }]);

    let big = "x".repeat(super::parse::MAX_RESULT_CHARS + 10);
    let result = json!({"type":"user","message":{"content":[
        {"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":big}]}
    ]}});
    match &parse_line(&result.to_string())[0] {
        ChatEvent::ToolResult { is_error, truncated, content, .. } => {
            assert!(*is_error && *truncated);
            assert_eq!(content.chars().count(), super::parse::MAX_RESULT_CHARS);
        }
        other => panic!("{other:?}"),
    }

    let failed = json!({"type":"result","subtype":"error_max_turns","is_error":true});
    assert!(matches!(&parse_line(&failed.to_string())[0],
        ChatEvent::Result { ok: false, error: Some(e), .. } if e == "error_max_turns"));

    let meta = json!({"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>x</local-command-caveat>"}});
    assert!(parse_line(&meta.to_string()).is_empty());
    assert!(parse_line("no es json").is_empty());
}

fn turn(resume: bool) -> ChatTurn {
    ChatTurn {
        tab_id: "tab-1".into(),
        cwd: "/p".into(),
        session_id: "s-1".into(),
        resume,
        model: Some("sonnet".into()),
        effort: Some("high".into()),
        permission_mode: Some("acceptEdits".into()),
        side: false,
        content: vec![json!({"type":"text","text":"hola"})],
        env: Default::default(),
        prelaunch: Vec::new(),
    }
}

#[test]
fn los_flags_del_turno() {
    let allowed = vec!["mcp__controlcode__browser_click".to_string()];
    let args = claude_args(&turn(true), Some(("/cfg.json", &allowed)));
    let has = |pair: [&str; 2]| args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1]);
    assert!(has(["--resume", "s-1"]));
    assert!(has(["--model", "sonnet"]));
    assert!(has(["--permission-mode", "acceptEdits"]));
    assert!(has(["--effort", "high"]));
    assert!(has(["--permission-prompt-tool", "mcp__controlcode__approve_tool_use"]));
    assert!(has(["--permission-prompts", "host"]));
    assert!(has(["--allowedTools", "mcp__controlcode__browser_click"]));
    assert!(args.contains(&"--include-partial-messages".to_string()));

    // Sesión nueva, sin MCP, y un modo que no existe: no se le pasa a la CLI.
    let mut fresh = turn(false);
    fresh.permission_mode = Some("yolo".into());
    fresh.model = None;
    let args = claude_args(&fresh, None);
    let has = |pair: [&str; 2]| args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1]);
    assert!(has(["--session-id", "s-1"]));
    assert!(has(["--permission-mode", "default"]));
    assert!(has(["--permission-prompts", "none"]));
    assert!(!args.contains(&"--model".to_string()));

    // Un esfuerzo que no existe tampoco viaja: la CLI lo rechazaría y el turno entero se
    // caería por un selector mal guardado.
    let mut raro = turn(true);
    raro.effort = Some("ultra".into());
    assert!(!claude_args(&raro, None).contains(&"--effort".to_string()));
}

/// Una pregunta al margen corre sobre una copia de la conversación y sin poder escribir:
/// eso es lo que la hace "al margen" y no otro turno más.
#[test]
fn una_pregunta_al_margen_forkea_y_no_escribe() {
    let mut aparte = turn(true);
    aparte.side = true;
    aparte.permission_mode = Some("bypassPermissions".into());
    let args = claude_args(&aparte, None);
    let has = |pair: [&str; 2]| args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1]);
    assert!(args.contains(&"--fork-session".to_string()), "no toca la conversación");
    assert!(has(["--resume", "s-1"]), "pero la ve entera");
    assert!(has(["--permission-mode", "plan"]), "el modo que pidió la tab no la deja escribir");
}

#[test]
fn el_mensaje_por_stdin() {
    let line = user_line(&[json!({"type":"text","text":"hola"})]);
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["type"], "user");
    assert_eq!(v["message"]["role"], "user");
    assert_eq!(v["message"]["content"][0]["text"], "hola");
    assert!(!line.contains('\n'));
}

/// Un turno de punta a punta con un proceso falso que imita el stream: lo que escribe por
/// stdout llega como eventos, y al terminar avisa con el código.
#[cfg(unix)]
#[test]
fn un_turno_con_un_proceso_falso_emite_y_termina() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = seen.clone();
    app.listen(super::session::event_name("tab-fake"), move |e| {
        sink.lock().unwrap().push(serde_json::from_str(e.payload()).unwrap());
    });

    let dir = std::env::temp_dir().join(format!("cc-chat-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake.sh");
    // Lee el mensaje (como `-p`), lo devuelve como texto del asistente y cierra.
    std::fs::write(
        &script,
        "read line\n\
         echo '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"eco\"}]}}'\n\
         echo \"$line\" >&2\n\
         echo '{\"type\":\"result\",\"is_error\":false,\"total_cost_usd\":0.01}'\n",
    )
    .unwrap();

    let mut t = turn(true);
    t.tab_id = "tab-fake".into();
    t.cwd = dir.to_string_lossy().into_owned();
    tauri::async_runtime::block_on(async {
        super::session::start(app.handle(), t.clone(), "sh".into(), vec![script.to_string_lossy().into_owned()])
            .unwrap();
        // Un segundo mensaje mientras corre el primero no lanza otro proceso.
        assert!(super::session::start(app.handle(), t, "sh".into(), vec![]).is_err());
        for _ in 0..100 {
            if !super::session::is_running("tab-fake") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    });

    let seen = seen.lock().unwrap();
    let kinds: Vec<&str> = seen.iter().map(|v| v["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["events", "events", "ended"]);
    assert_eq!(seen[0]["events"][0]["kind"], "text");
    assert_eq!(seen[0]["events"][0]["text"], "eco");
    assert_eq!(seen[1]["events"][0]["costUsd"], 0.01);
    assert_eq!(seen[2]["code"], 0);
    assert_eq!(seen[2]["stopped"], false);
    // stdin recibió la línea del mensaje.
    assert!(seen[2]["stderr"].as_str().unwrap().contains("\"text\":\"hola\""));
}

#[cfg(unix)]
#[test]
fn parar_un_turno_lo_mata_y_lo_marca() {
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    let app = tauri::test::mock_app();
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = seen.clone();
    app.listen(super::session::event_name("tab-stop"), move |e| {
        sink.lock().unwrap().push(serde_json::from_str(e.payload()).unwrap());
    });
    let mut t = turn(true);
    t.tab_id = "tab-stop".into();
    t.cwd = std::env::temp_dir().to_string_lossy().into_owned();
    tauri::async_runtime::block_on(async {
        super::session::start(app.handle(), t, "sleep".into(), vec!["30".into()]).unwrap();
        assert!(super::session::is_running("tab-stop"));
        assert!(super::session::stop("tab-stop", false));
        for _ in 0..100 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    });
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0]["type"], "ended");
    assert_eq!(seen[0]["stopped"], true);
    assert!(!super::session::is_running("tab-stop"));
}

/// Con pasos previos, el turno corre en un shell que los ejecuta y termina en el programa,
/// con los argumentos intactos aunque tengan espacios o comillas.
#[cfg(unix)]
#[test]
fn los_pasos_previos_preparan_el_entorno_y_los_argumentos_llegan_enteros() {
    use super::launch::{command_for, quote};

    assert_eq!(quote("--model"), "--model");
    assert_eq!(quote("a b"), "'a b'");
    assert_eq!(quote("it's"), r"'it'\''s'");

    let args = vec!["-c".to_string(), "printf '%s|%s' \"$CC_PRE\" \"$0\"".to_string(), "con espacio 'y' comillas".to_string()];
    let out = tauri::async_runtime::block_on(async {
        command_for("sh".as_ref(), &args, &["export CC_PRE=listo".to_string()]).output().await.unwrap()
    });
    assert_eq!(String::from_utf8_lossy(&out.stdout), "listo|con espacio 'y' comillas");
}


/// Lo gastado mientras el turno corre, para el reloj de "trabajando". Las líneas son las de
/// una corrida real con `--include-partial-messages` (2.1.293, haiku).
#[test]
fn el_stream_dice_cuanto_lleva_gastado() {
    let start = json!({"type":"stream_event","event":{"type":"message_start","message":{
        "model":"claude-haiku-5-5","role":"assistant","content":[],
        "usage":{"input_tokens":2,"cache_creation_input_tokens":11878,"cache_read_input_tokens":10481}}}});
    // La entrada es TODO el contexto que viajó: lo nuevo más lo que salió de la caché, que
    // en una conversación larga es casi todo. Contar solo `input_tokens` daría 2.
    assert!(matches!(&parse_line(&start.to_string())[0],
        ChatEvent::Usage { input_tokens: Some(22361), .. }));

    let delta = json!({"type":"stream_event","event":{"type":"message_delta",
        "delta":{"stop_reason":"end_turn"},
        "usage":{"input_tokens":2,"cache_read_input_tokens":10481,"output_tokens":49}}});
    assert!(matches!(&parse_line(&delta.to_string())[0],
        ChatEvent::Usage { input_tokens: None, output_tokens: Some(49) }));

    // Un `message_start` sin uso no inventa un cero.
    let vacio = json!({"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}}});
    assert!(parse_line(&vacio.to_string()).is_empty());
}


/// Las capas de configuración de la TUI: lo del proyecto pisa lo del usuario, y lo local
/// pisa a los dos. Es con lo que el chat dice "va a arrancar con esto".
#[test]
fn los_valores_de_fabrica_salen_de_settings_json() {
    use super::commands::merge_defaults;
    let usuario = json!({"model": "opus", "effortLevel": "xhigh", "hooks": {}});
    let proyecto = json!({"effortLevel": "medium"});
    let local = json!({"ultracode": true});

    let solo_usuario = merge_defaults(&[usuario.clone()]);
    assert_eq!(solo_usuario.model.as_deref(), Some("opus"));
    assert_eq!(solo_usuario.effort.as_deref(), Some("xhigh"));
    assert!(!solo_usuario.ultracode);

    let todo = merge_defaults(&[usuario, proyecto, local]);
    assert_eq!(todo.effort.as_deref(), Some("medium"), "la del proyecto manda");
    assert_eq!(todo.model.as_deref(), Some("opus"), "lo que la capa no dice, no lo borra");
    assert!(todo.ultracode);

    // Un settings sin nada de esto no inventa valores.
    assert_eq!(merge_defaults(&[json!({"permissions": {}})]), super::commands::ChatDefaults::default());
}

/// El modelo y el esfuerzo con que viene una sesión, de su `.jsonl` real: la última
/// respuesta manda. Un `/model` o `/effort` mandado con `-p` vale solo para ese proceso (la
/// CLI lo dice: "for this session only"), y la respuesta siguiente lo confirma.
#[test]
fn el_modelo_y_el_esfuerzo_de_la_sesion_salen_de_su_ultima_respuesta() {
    use super::parse::{session_settings, SessionSettings};
    let content = include_str!("fixtures/claude_model_session.jsonl");
    let s = session_settings(content);
    assert_eq!(s, SessionSettings { model: Some("claude-sonnet-5-5".into()), effort: Some("medium".into()) });

    // Cortado en la respuesta que corrió con `--model sonnet --effort high`.
    let upto: Vec<&str> = content.lines().take(6).collect();
    let s = session_settings(&upto.join("\n"));
    assert_eq!(s.model.as_deref(), Some("claude-sonnet-5-5"));
    assert_eq!(s.effort.as_deref(), Some("high"));

    assert_eq!(session_settings(""), SessionSettings::default());
}

/// En la TUI, `/model` y `/effort` sin argumentos abren un selector, y lo elegido sale en la
/// salida del comando. Valen para lo que sigue aunque todavía no haya respuestas con ellos.
#[test]
fn un_model_o_effort_de_la_tui_cuenta_aunque_no_haya_respondido_todavia() {
    use super::parse::session_settings;
    let user = |text: &str| json!({"type":"user","message":{"role":"user","content":text}}).to_string();
    let answer = json!({"type":"assistant","effort":"xhigh","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"hola"}]}}).to_string();
    let synthetic = json!({"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"x"}]}}).to_string();
    let lines = [
        answer.clone(),
        user("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"),
        user("<local-command-stdout>Set model to Haiku 5.5</local-command-stdout>"),
        synthetic,
        user("<command-name>/effort</command-name>\n<command-args></command-args>"),
        user("<local-command-stdout>Set effort level to low (this session only): Quick</local-command-stdout>"),
    ];
    let s = session_settings(&lines.join("\n"));
    assert_eq!(s.model.as_deref(), Some("haiku"));
    assert_eq!(s.effort.as_deref(), Some("low"));

    // Con argumentos: el nombre tal cual; `default` vuelve al de la configuración.
    let typed = [answer.clone(), user("<command-name>/model</command-name><command-args>claude-opus-4-1</command-args>")];
    assert_eq!(session_settings(&typed.join("\n")).model.as_deref(), Some("claude-opus-4-1"));
    let back = [answer.clone(), user("<command-name>/model</command-name><command-args>default</command-args>")];
    assert_eq!(session_settings(&back.join("\n")).model, None);
    // Un nivel que no existe no pisa el que había.
    let bad = [answer, user("<command-name>/effort</command-name><command-args>turbo</command-args>")];
    assert_eq!(session_settings(&bad.join("\n")).effort.as_deref(), Some("xhigh"));
}

/// Una pregunta al margen corre en una copia, en modo plan y sin nada que espere a una
/// persona: sin eso el modelo preguntaba (`AskUserQuestion`) y la tarjeta quedaba colgada.
#[test]
fn una_pregunta_al_margen_no_puede_preguntar_ni_planificar() {
    let mut t = turn(true);
    t.side = true;
    let args = claude_args(&t, None);
    let has = |pair: [&str; 2]| args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1]);
    assert!(args.contains(&"--fork-session".to_string()));
    assert!(has(["--permission-mode", "plan"]));
    assert!(has(["--disallowedTools", "AskUserQuestion,ExitPlanMode,EnterPlanMode"]));
    assert!(args.iter().any(|a| a == "--append-system-prompt"));

    // El turno normal no lleva nada de eso.
    let args = claude_args(&turn(true), None);
    assert!(!args.iter().any(|a| a == "--disallowedTools" || a == "--fork-session"));
}

/// El catálogo del selector de `/model`, tal como lo deja el bundle de la CLI: con nombre y
/// versión, y sin los retirados.
#[test]
fn el_catalogo_de_modelos_sale_del_binario_con_su_version() {
    use super::models::{scan_catalog, used_in, ModelInfo};
    let bundle = b"xx{id:\"claude-opus-5-5\",name:\"Opus 5.5\",short_name:\"Opus\",section:\"main\",cap..}\0\
{id:\"claude-opus-4-5-20251101\",name:\"Opus 4.5\",short_name:\"Opus\",section:\"deprecated\"}\
{id:\"claude-haiku-4-5-20251001\",name:\"Haiku 4.5\",short_name:\"Haiku\",section:\"main\"}\
{id:\"claude-opus-5-5\",name:\"Opus 5.5\",short_name:\"Opus\",section:\"main\"}";
    assert_eq!(
        scan_catalog(&bundle[..]),
        vec![
            ModelInfo { id: "claude-opus-5-5".into(), name: Some("Opus 5.5".into()) },
            ModelInfo { id: "claude-haiku-4-5-20251001".into(), name: Some("Haiku 4.5".into()) },
        ]
    );

    // Lo que usaron las sesiones, de su `.jsonl` (el fixture real), sin `<synthetic>`.
    let used = used_in(include_str!("fixtures/claude_model_session.jsonl"));
    assert_eq!(used, ["claude-haiku-5-5", "claude-sonnet-5-5"]);
}
