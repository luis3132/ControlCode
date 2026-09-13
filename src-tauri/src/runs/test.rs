//! Tests de los agentes headless.
//!
//! Nada de acá lanza un agente ni sale a la red: los eventos son fixtures del formato
//! `stream-json` y la base es la de `schema::in_memory()`, que corre la migración real.

use super::activity::{text_line, tool_label};
use super::agents::{adapter_for, HeadlessAgent, LaunchCtx};
use super::store::{self, NewTask};
use super::types::{status, AgentEvent, TaskOutcome};
use crate::database::test_db;
use rusqlite::Connection;

fn claude() -> Box<dyn HeadlessAgent + Send + Sync> {
    adapter_for("claude-code").expect("claude-code tiene adaptador")
}

/// Un workspace y un run listos, para no repetir el andamiaje en cada test.
fn run_en(conn: &Connection) -> String {
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, last_active) VALUES ('w1', 'W', 0, 0)",
        [],
    )
    .unwrap();
    store::create_run(conn, "w1", "objetivo", "/tmp/proy").unwrap().id
}

fn tarea(conn: &Connection, run_id: &str) -> String {
    store::create_task(
        conn,
        &NewTask {
            run_id,
            title: "t",
            prompt: "hacé algo",
            agent_id: "claude-code",
            account_id: None,
            model: None,
            cwd: "/tmp/proy",
            budget_usd: None,
        },
    )
    .unwrap()
    .id
}

// ── El argv ─────────────────────────────────────────────────────

fn ctx_sin_broker() -> LaunchCtx<'static> {
    LaunchCtx { session_id: "s-1", account_env: Default::default(), mcp_config: None }
}

fn ctx_con_broker() -> LaunchCtx<'static> {
    LaunchCtx {
        session_id: "s-1",
        account_env: Default::default(),
        mcp_config: Some(std::path::PathBuf::from("/tmp/cc/t1.json")),
    }
}

/// Los flags sin los cuales esto no es un agente headless supervisado, sino un proceso
/// suelto: sin `stream-json` no hay eventos y sin `--session-id` no se puede reabrir como
/// tab.
#[test]
fn el_lanzamiento_de_claude_pide_eventos_y_sesion_fijada() {
    let launch = claude().launch("arreglá el bug", None, None, &ctx_sin_broker());
    let args = launch.args.join(" ");

    assert!(args.contains("-p arreglá el bug"));
    assert!(args.contains("--output-format stream-json"));
    assert!(args.contains("--session-id s-1"));

    // Nunca por default: dejar a un agente sin supervisión y sin límites son dos
    // decisiones distintas, y acá solo se tomó la primera.
    assert!(!args.contains("bypassPermissions"));
    assert!(!args.contains("--dangerously-skip-permissions"));
}

/// Con broker el agente PREGUNTA, y la pregunta tiene que llegar a nuestra tool. Los cuatro
/// flags van juntos o no va ninguno: `--permission-mode default` sin `host` deja la
/// pregunta sin destino, y `host` sin `--permission-prompt-tool` la manda a un SDK que acá
/// no existe.
#[test]
fn con_broker_los_permisos_se_rutean_a_la_consola() {
    let args = claude().launch("x", None, None, &ctx_con_broker()).args.join(" ");

    assert!(args.contains("--mcp-config /tmp/cc/t1.json"));
    assert!(args.contains("--strict-mcp-config"));
    assert!(args.contains("--permission-prompt-tool mcp__controlcode__approve_tool_use"));
    assert!(args.contains("--permission-mode default"));
    assert!(args.contains("--permission-prompts host"));
}

/// Sin broker no hay a quién preguntarle: lo que preguntaría se deniega en vez de colgar el
/// proceso esperando a nadie.
#[test]
fn sin_broker_lo_que_preguntaria_se_deniega() {
    let args = claude().launch("x", None, None, &ctx_sin_broker()).args.join(" ");

    assert!(args.contains("--permission-mode acceptEdits"));
    assert!(args.contains("--permission-prompts none"));
    assert!(!args.contains("--permission-prompt-tool"));
}

#[test]
fn el_modelo_y_el_presupuesto_solo_van_si_se_pidieron() {
    let ctx = ctx_sin_broker();

    let pelado = claude().launch("x", None, None, &ctx).args.join(" ");
    assert!(!pelado.contains("--model"));
    assert!(!pelado.contains("--max-budget-usd"));

    let con = claude().launch("x", Some("opus"), Some(1.5), &ctx).args.join(" ");
    assert!(con.contains("--model opus"));
    assert!(con.contains("--max-budget-usd 1.5"));
}

// ── El stream ───────────────────────────────────────────────────

#[test]
fn el_arranque_trae_la_sesion() {
    let eventos = claude().parse_line(r#"{"type":"system","subtype":"init","session_id":"abc"}"#);
    assert_eq!(eventos, vec![AgentEvent::Started { session_id: Some("abc".into()) }]);
}

/// Un solo mensaje puede traer texto Y varias herramientas. Por eso `parse_line` devuelve
/// una lista: con un `Option` se perdería todo menos lo primero.
#[test]
fn un_mensaje_con_texto_y_herramientas_produce_un_evento_por_cada_uno() {
    let linea = r#"{"type":"assistant","message":{"content":[
        {"type":"text","text":"Voy a mirar el test\ny después corro cargo"},
        {"type":"tool_use","name":"Read","input":{"file_path":"/home/u/proy/src/terminal/containment.rs"}},
        {"type":"tool_use","name":"Bash","input":{"command":"cargo test containment\n# segunda línea"}}
    ]}}"#;
    let eventos = claude().parse_line(linea);

    assert_eq!(
        eventos,
        vec![
            AgentEvent::Text { text: "Voy a mirar el test".into() },
            AgentEvent::Tool {
                name: "Read".into(),
                label: "Read(terminal/containment.rs)".into()
            },
            AgentEvent::Tool { name: "Bash".into(), label: "Bash(cargo test containment)".into() },
        ]
    );
}

/// El stream puede ganar tipos y campos entre versiones de la TUI. Una línea que no se
/// entiende es una línea que no se muestra — nunca una tarea que se cae.
#[test]
fn una_linea_desconocida_o_rota_no_produce_nada_ni_explota() {
    assert!(claude().parse_line("esto no es json").is_empty());
    assert!(claude().parse_line(r#"{"type":"loquesea"}"#).is_empty());
    assert!(claude().parse_line(r#"{"type":"assistant"}"#).is_empty());
    assert!(claude().parse_line("").is_empty());
}

#[test]
fn el_cierre_trae_el_veredicto_con_su_costo() {
    let linea = r#"{"type":"result","subtype":"success","is_error":false,
        "result":"listo","total_cost_usd":0.0342,
        "usage":{"input_tokens":1200,"output_tokens":340}}"#;
    let eventos = claude().parse_line(linea);

    assert_eq!(
        eventos,
        vec![AgentEvent::Finished {
            outcome: TaskOutcome {
                ok: true,
                result: Some("listo".into()),
                error: None,
                cost_usd: Some(0.0342),
                tokens_in: Some(1200),
                tokens_out: Some(340),
            }
        }]
    );
}

#[test]
fn un_cierre_con_error_deja_el_texto_como_error_y_no_como_resultado() {
    let eventos = claude()
        .parse_line(r#"{"type":"result","is_error":true,"result":"se acabó el presupuesto"}"#);
    let AgentEvent::Finished { outcome } = &eventos[0] else { panic!("no cerró") };
    assert!(!outcome.ok);
    assert_eq!(outcome.error.as_deref(), Some("se acabó el presupuesto"));
    assert_eq!(outcome.result, None);
}

/// **El fin de una tarea lo decide el proceso, no un mensaje del agente.** Un agente puede
/// colgarse, quedarse sin cupo o morir a mitad, y en ninguno de esos casos llega a emitir
/// su `result`. Si el cierre dependiera de ese mensaje, la tarjeta se quedaría "corriendo"
/// para siempre.
#[test]
fn una_tarea_que_muere_sin_decir_nada_igual_cierra() {
    let a = claude();
    assert!(a.finish(None, 0).ok, "salir bien sin emitir nada es éxito");

    let fallo = a.finish(None, 1);
    assert!(!fallo.ok);
    assert!(fallo.error.unwrap().contains("código 1"));
}

// ── Las etiquetas de la tarjeta ─────────────────────────────────

#[test]
fn cada_herramienta_muestra_el_dato_que_la_identifica() {
    let v = serde_json::json!({ "file_path": "/a/b/c/store.rs" });
    assert_eq!(tool_label("Edit", &v), "Edit(c/store.rs)");

    let v = serde_json::json!({ "command": "bun run test" });
    assert_eq!(tool_label("Bash", &v), "Bash(bun run test)");

    let v = serde_json::json!({ "pattern": "TODO" });
    assert_eq!(tool_label("Grep", &v), "Grep(TODO)");

    // Una herramienta desconocida (de un MCP, por ejemplo) se muestra sin argumento en vez
    // de inventarle uno.
    let v = serde_json::json!({ "loquesea": 1 });
    assert_eq!(tool_label("mcp__foo__bar", &v), "mcp__foo__bar");
    assert_eq!(tool_label("Edit", &serde_json::Value::Null), "Edit");
}

/// Cortar por bytes partiría un carácter multibyte al medio y la tarjeta mostraría el
/// glifo de reemplazo en vez del texto.
#[test]
fn el_recorte_no_parte_caracteres() {
    let largo = "ñ".repeat(200);
    let linea = text_line(&largo).unwrap();
    assert!(linea.chars().count() <= 96);
    assert!(linea.ends_with('…'));
}

#[test]
fn el_texto_toma_la_primera_linea_util() {
    assert_eq!(text_line("\n\n  Vamos a empezar  \ndetalle"), Some("Vamos a empezar".into()));
    assert_eq!(text_line("   \n  "), None);
}

// ── Las filas ───────────────────────────────────────────────────

#[test]
fn una_tarea_arranca_lista_y_al_lanzarse_queda_corriendo_con_su_sesion() {
    let conn = test_db();
    let run = run_en(&conn);
    let id = tarea(&conn, &run);

    assert_eq!(store::task_by_id(&conn, &id).unwrap().unwrap().status, status::READY);

    store::mark_running(&conn, &id, "sesion-1", "/tmp/e.jsonl").unwrap();
    let t = store::task_by_id(&conn, &id).unwrap().unwrap();
    assert_eq!(t.status, status::RUNNING);
    // El id de sesión lo puso la app ANTES de lanzar: es lo que después permite reabrir
    // la tarea como tab con `--resume` sin descubrir nada.
    assert_eq!(t.session_id.as_deref(), Some("sesion-1"));
    assert_eq!(t.attempt, 1);
}

#[test]
fn cerrar_una_tarea_acumula_lo_que_gasto_en_su_run() {
    let conn = test_db();
    let run = run_en(&conn);
    let a = tarea(&conn, &run);
    let b = tarea(&conn, &run);

    for id in [&a, &b] {
        store::mark_running(&conn, id, "s", "/tmp/e.jsonl").unwrap();
        let outcome = TaskOutcome { ok: true, cost_usd: Some(0.25), ..Default::default() };
        store::finish_task(&conn, id, &outcome).unwrap();
    }

    assert!((store::run_by_id(&conn, &run).unwrap().unwrap().spent_usd - 0.5).abs() < 1e-9);
}

/// Cancelar y fallar no son lo mismo. Al cancelar, el proceso muere y el supervisor llega
/// igual con un veredicto de fallo; si ese fallo pisara la fila, el usuario vería su propia
/// cancelación reportada como un error del agente.
#[test]
fn una_tarea_cancelada_no_la_pisa_el_fallo_del_proceso_que_se_mato() {
    let conn = test_db();
    let run = run_en(&conn);
    let id = tarea(&conn, &run);
    store::mark_running(&conn, &id, "s", "/tmp/e.jsonl").unwrap();

    conn.execute("UPDATE tasks SET status = 'cancelled' WHERE id = ?1", [&id]).unwrap();
    store::finish_task(&conn, &id, &TaskOutcome::failed("murió")).unwrap();

    assert_eq!(store::task_by_id(&conn, &id).unwrap().unwrap().status, status::CANCELLED);
}

/// Una tarea que falla AL LANZARSE nunca llegó a `running`. Sin contemplar ese estado se
/// quedaría en `ready` para siempre, o sea una tarjeta que nunca arranca ni termina.
#[test]
fn una_tarea_que_falla_al_lanzarse_igual_queda_cerrada() {
    let conn = test_db();
    let run = run_en(&conn);
    let id = tarea(&conn, &run);

    store::finish_task(&conn, &id, &TaskOutcome::failed("no existe el binario")).unwrap();

    let t = store::task_by_id(&conn, &id).unwrap().unwrap();
    assert_eq!(t.status, status::FAILED);
    assert_eq!(t.error.as_deref(), Some("no existe el binario"));
}

/// El proceso de una tarea es hijo de la app: cuando la app se va, se va con ella. Una fila
/// en `running` después de reabrir no es una tarea viva, es una que murió sin que nadie
/// llegara a anotarlo.
#[test]
fn al_arrancar_se_cierran_las_tareas_que_murieron_con_la_app() {
    let conn = test_db();
    let run = run_en(&conn);
    let viva = tarea(&conn, &run);
    let cerrada = tarea(&conn, &run);

    store::mark_running(&conn, &viva, "s", "/tmp/e.jsonl").unwrap();
    store::mark_running(&conn, &cerrada, "s", "/tmp/e.jsonl").unwrap();
    store::finish_task(&conn, &cerrada, &TaskOutcome { ok: true, ..Default::default() }).unwrap();

    let db: crate::database::DbConnection = std::sync::Arc::new(std::sync::Mutex::new(conn));
    assert_eq!(store::sweep_orphans(&db).unwrap(), 1);

    let conn = db.lock().unwrap();
    assert_eq!(store::task_by_id(&conn, &viva).unwrap().unwrap().status, status::FAILED);
    // La que ya había cerrado bien no se toca.
    assert_eq!(store::task_by_id(&conn, &cerrada).unwrap().unwrap().status, status::DONE);
}

/// Borrar un run se lleva sus tareas: son suyas, no tienen sentido sueltas. Es la FK con
/// `ON DELETE CASCADE`, que solo actúa con `PRAGMA foreign_keys = ON` — de ahí que los
/// tests corran sobre el schema real y no sobre uno inventado.
#[test]
fn borrar_un_run_se_lleva_sus_tareas() {
    let conn = test_db();
    let run = run_en(&conn);
    tarea(&conn, &run);

    conn.execute("DELETE FROM runs WHERE id = ?1", [&run]).unwrap();
    assert!(store::list_tasks(&conn, "w1").unwrap().is_empty());
}

// ── Contra una corrida real ─────────────────────────────────────

/// El stream tal cual lo escupió `claude 2.1.269`, recortado a los campos que el parser
/// mira.
///
/// Va como fixture y no como JSON escrito a mano porque tres bugs de este módulo solo
/// aparecieron al ver la salida de verdad: los `system` que no son `init`, el cierre con
/// error que viene sin texto, y los tokens de entrada que llegan en cero porque los reales
/// están en los campos de caché. Un fixture inventado los habría pasado por alto a los
/// tres.
const STREAM_REAL: &str = include_str!("fixtures/claude_stream.jsonl");

fn eventos_del_fixture() -> Vec<AgentEvent> {
    let a = claude();
    STREAM_REAL.lines().flat_map(|l| a.parse_line(l)).collect()
}

/// Hay varios `system` por sesión (`hook_started`, `hook_response`, `init`). Tomarlos
/// todos como arranque emitía tres "arrancó" para una sola tarea.
#[test]
fn una_corrida_real_arranca_una_sola_vez() {
    let arranques: Vec<_> = eventos_del_fixture()
        .into_iter()
        .filter(|e| matches!(e, AgentEvent::Started { .. }))
        .collect();

    assert_eq!(
        arranques,
        vec![AgentEvent::Started {
            session_id: Some("11111111-2222-3333-4444-555555555555".into())
        }],
        "solo el `system` con subtype `init` es el arranque"
    );
}

/// Y de paso confirma lo que sostiene todo el diseño: la sesión que vuelve es **la que la
/// app impuso** con `--session-id`, así que la fila ya sabe a qué conversación mirar sin
/// descubrir nada.
#[test]
fn la_sesion_que_devuelve_es_la_que_le_impuso_la_app() {
    let Some(AgentEvent::Started { session_id }) = eventos_del_fixture()
        .into_iter()
        .find(|e| matches!(e, AgentEvent::Started { .. }))
    else {
        panic!("no arrancó");
    };
    assert_eq!(session_id.as_deref(), Some("11111111-2222-3333-4444-555555555555"));
}

/// Un cierre con error viene SIN texto: el motivo está en el `subtype`. Sin el respaldo, la
/// tarjeta decía "falló" y nada más.
#[test]
fn un_cierre_sin_texto_igual_explica_por_que_fallo() {
    let Some(AgentEvent::Finished { outcome }) = eventos_del_fixture()
        .into_iter()
        .find(|e| matches!(e, AgentEvent::Finished { .. }))
    else {
        panic!("no cerró");
    };

    assert!(!outcome.ok);
    assert_eq!(outcome.error.as_deref(), Some("error_max_budget_usd"));
    assert!(outcome.cost_usd.unwrap() > 0.0);
}

/// `input_tokens` solo cuenta lo que NO salió de la caché, y en una sesión normal eso es
/// casi cero — en la corrida real dio 0 con decenas de miles realmente consumidos. Informar
/// ese 0 haría ver toda tarea como gratis.
#[test]
fn los_tokens_de_entrada_incluyen_los_de_cache() {
    let v = serde_json::json!({
        "type": "result", "is_error": false, "result": "ok",
        "usage": { "input_tokens": 0, "cache_creation_input_tokens": 12_000,
                   "cache_read_input_tokens": 30_000, "output_tokens": 250 }
    });
    let eventos = claude().parse_line(&v.to_string());
    let AgentEvent::Finished { outcome } = &eventos[0] else { panic!() };

    assert_eq!(outcome.tokens_in, Some(42_000));
    assert_eq!(outcome.tokens_out, Some(250));
}

/// Sin ningún campo de uso no se inventa un cero: "no lo sé" y "no gastó nada" son cosas
/// distintas, y el panel de consumo de la app ya distingue esa diferencia.
#[test]
fn sin_datos_de_uso_no_se_inventa_un_cero() {
    let eventos = claude().parse_line(r#"{"type":"result","is_error":false,"result":"ok"}"#);
    let AgentEvent::Finished { outcome } = &eventos[0] else { panic!() };
    assert_eq!(outcome.tokens_in, None);
}

#[test]
fn una_corrida_real_produce_la_actividad_que_se_muestra() {
    let lineas: Vec<String> = eventos_del_fixture()
        .into_iter()
        .filter_map(|e| match e {
            AgentEvent::Text { text } => Some(text),
            AgentEvent::Tool { label, .. } => Some(label),
            _ => None,
        })
        .collect();

    assert_eq!(lineas.len(), 2, "un texto y una herramienta");
    assert!(lineas[1].starts_with("Read("), "la herramienta se muestra con su archivo");
}

// ── Las reglas ──────────────────────────────────────────────────

use super::rules::{decide, Decision, PermissionRule};

fn regla(pattern: &str, allow: bool) -> PermissionRule {
    PermissionRule { pattern: pattern.into(), allow }
}

fn entrada(json: serde_json::Value) -> serde_json::Value {
    json
}

/// Sin reglas se pregunta todo. Es el default y es el lado seguro: una carpeta sin reglas
/// no puede terminar autorizando algo sola.
#[test]
fn sin_reglas_se_pregunta_todo() {
    assert_eq!(decide(&[], "Edit", &entrada(serde_json::json!({}))), Decision::Ask);
}

#[test]
fn una_regla_sin_parentesis_vale_para_toda_la_herramienta() {
    let reglas = [regla("Read", true)];
    assert_eq!(decide(&reglas, "Read", &entrada(serde_json::json!({"file_path": "/x"}))), Decision::Allow);
    assert_eq!(decide(&reglas, "Edit", &entrada(serde_json::json!({"file_path": "/x"}))), Decision::Ask);
}

#[test]
fn el_patron_compara_contra_el_campo_que_identifica_la_accion() {
    let reglas = [regla("Bash(git status*)", true), regla("Edit(src/**)", true)];

    assert_eq!(
        decide(&reglas, "Bash", &entrada(serde_json::json!({"command": "git status --short"}))),
        Decision::Allow
    );
    assert_eq!(
        decide(&reglas, "Bash", &entrada(serde_json::json!({"command": "git push origin main"}))),
        Decision::Ask
    );
    assert_eq!(
        decide(&reglas, "Edit", &entrada(serde_json::json!({"file_path": "src/a/b.rs"}))),
        Decision::Allow
    );
    assert_eq!(
        decide(&reglas, "Edit", &entrada(serde_json::json!({"file_path": "otro/a.rs"}))),
        Decision::Ask
    );
}

/// Gana la primera que coincide, no la más específica. El orden es el que el usuario ve;
/// inferir precedencia haría que dos reglas que se leen claras den un resultado que no se
/// deduce mirándolas.
#[test]
fn gana_la_primera_regla_que_coincide() {
    let deniega_primero = [regla("Bash(git push*)", false), regla("Bash", true)];
    assert_eq!(
        decide(&deniega_primero, "Bash", &entrada(serde_json::json!({"command": "git push"}))),
        Decision::Deny
    );

    let permite_primero = [regla("Bash", true), regla("Bash(git push*)", false)];
    assert_eq!(
        decide(&permite_primero, "Bash", &entrada(serde_json::json!({"command": "git push"}))),
        Decision::Allow
    );
}

/// Una regla con patrón necesita un argumento que comparar. Si la herramienta no expone
/// ninguno que sepamos leer, la regla NO aplica y se termina preguntando: el otro lado del
/// error sería permitir algo por una regla que nunca se pudo verificar.
#[test]
fn una_regla_con_patron_no_aplica_a_una_herramienta_sin_argumento_legible() {
    let reglas = [regla("mcp__foo__bar(*)", true)];
    assert_eq!(
        decide(&reglas, "mcp__foo__bar", &entrada(serde_json::json!({"lo_que_sea": 1}))),
        Decision::Ask
    );

    // Y la misma herramienta SIN patrón sí se puede autorizar entera.
    let reglas = [regla("mcp__foo__bar", true)];
    assert_eq!(
        decide(&reglas, "mcp__foo__bar", &entrada(serde_json::json!({"lo_que_sea": 1}))),
        Decision::Allow
    );
}

#[test]
fn el_glob_ancla_los_extremos() {
    let exacto = [regla("Bash(ls)", true)];
    assert_eq!(decide(&exacto, "Bash", &entrada(serde_json::json!({"command": "ls"}))), Decision::Allow);
    assert_eq!(
        decide(&exacto, "Bash", &entrada(serde_json::json!({"command": "ls -la"}))),
        Decision::Ask,
        "sin `*` el patrón es exacto"
    );

    let sufijo = [regla("Edit(*.rs)", true)];
    assert_eq!(
        decide(&sufijo, "Edit", &entrada(serde_json::json!({"file_path": "src/main.rs"}))),
        Decision::Allow
    );
    assert_eq!(
        decide(&sufijo, "Edit", &entrada(serde_json::json!({"file_path": "src/main.ts"}))),
        Decision::Ask
    );
}

// ── El broker ───────────────────────────────────────────────────

use super::broker;
use std::time::Duration;

lazy_static::lazy_static! {
    /// La cola del broker es global —tiene que serlo: el `ccode mcp` de cualquier tarea
    /// entra por ahí— así que estos tests no pueden correr en paralelo entre sí. Sin esto
    /// pasan solos y fallan en la suite completa, que es la peor forma de fallar.
    static ref UNO_A_LA_VEZ: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

fn con_broker_limpio() -> std::sync::MutexGuard<'static, ()> {
    let guard = UNO_A_LA_VEZ.lock().unwrap_or_else(|e| e.into_inner());
    broker::clear();
    guard
}

/// El circuito completo: el agente pregunta y se queda esperando, una persona contesta, y
/// el agente sigue con esa respuesta. Es lo único que separa "un agente que corre solo" de
/// "un agente al que le podés confiar el repo".
#[test]
fn un_pedido_espera_hasta_que_alguien_contesta() {
    let _serial = con_broker_limpio();
    let id = "ap-1";

    let esperando = std::thread::spawn(move || {
        broker::ask(id, "t1", "Edit", serde_json::json!({"file_path": "/x"}), Duration::from_secs(5))
    });

    // El pedido aparece en la cola para que la consola lo muestre.
    let visto = loop {
        let p = broker::pending();
        if !p.is_empty() {
            break p;
        }
        std::thread::yield_now();
    };
    assert_eq!(visto[0].tool_name, "Edit");
    assert_eq!(visto[0].task_id, "t1");

    assert!(broker::decide(id, true, None));
    let verdict = esperando.join().unwrap();
    assert!(verdict.allow);
    assert_eq!(verdict.by, broker::DecidedBy::User);

    // Y deja de estar pendiente.
    assert!(broker::pending().is_empty());
}

/// Si nadie contesta, NO se aprueba solo: se deniega, pero anotado como `Timeout` y no como
/// decisión de nadie — "te dijeron que no" y "no había nadie" son cosas distintas y el
/// agente las repite en su salida.
#[test]
fn un_pedido_que_vence_no_se_aprueba_solo() {
    let _serial = con_broker_limpio();
    let verdict = broker::ask(
        "ap-2",
        "t1",
        "Bash",
        serde_json::json!({"command": "rm -rf /"}),
        Duration::from_millis(50),
    );
    assert!(!verdict.allow);
    assert_eq!(verdict.by, broker::DecidedBy::Timeout);
    assert!(broker::pending().is_empty(), "un pedido vencido no queda en la cola");
}

/// Cancelar una tarea tiene que soltar lo que estuviera esperando: ese pedido no lo va a
/// contestar nadie, y dejarlo lo mostraría en la consola para siempre.
#[test]
fn cancelar_una_tarea_suelta_sus_pedidos() {
    let _serial = con_broker_limpio();
    let esperando = std::thread::spawn(|| {
        broker::ask("ap-3", "t9", "Edit", serde_json::json!({}), Duration::from_secs(5))
    });
    while broker::pending().is_empty() {
        std::thread::yield_now();
    }

    assert_eq!(broker::drop_task("t9"), 1);
    let verdict = esperando.join().unwrap();
    assert!(!verdict.allow);
    assert_eq!(verdict.by, broker::DecidedBy::Cancelled, "cancelar no es lo mismo que vencer");
    assert!(broker::pending().is_empty());
}

#[test]
fn contestar_un_pedido_que_ya_no_existe_lo_dice() {
    let _serial = con_broker_limpio();
    assert!(!broker::decide("no-existe", true, None));
}

// ── Recordar: la regla exacta ───────────────────────────────────

use super::rules::{exact_rule_for, is_valid_pattern};

/// "Recordar" escribe EXACTAMENTE lo que se vio. Aprobar `cargo test --lib` no puede
/// terminar autorizando `cargo test` a secas.
#[test]
fn recordar_fija_exactamente_lo_que_se_aprobo() {
    let bash = serde_json::json!({"command": "cargo test --lib"});
    let regla_escrita = exact_rule_for("Bash", &bash).expect("se puede recordar");
    assert_eq!(regla_escrita, "Bash(cargo test --lib)");

    let reglas = [regla(&regla_escrita, true)];
    assert_eq!(decide(&reglas, "Bash", &bash), Decision::Allow);
    assert_eq!(
        decide(&reglas, "Bash", &serde_json::json!({"command": "cargo test"})),
        Decision::Ask,
        "una variante del comando no quedó aprobada"
    );
    assert_eq!(
        decide(&reglas, "Bash", &serde_json::json!({"command": "cargo test --lib && rm -rf ~"})),
        Decision::Ask,
        "ni uno que lo contenga"
    );

    let edit = serde_json::json!({"file_path": "/p/src/a.rs", "old_string": "x", "new_string": "y"});
    assert_eq!(exact_rule_for("Edit", &edit).as_deref(), Some("Edit(/p/src/a.rs)"));
}

/// En una regla `*` es comodín. Recordar `rm *.log` tal cual aprobaría también
/// `rm -rf /tmp/x.log`: sin forma de escaparlo, no se ofrece.
#[test]
fn no_se_recuerda_un_comando_con_asterisco() {
    assert_eq!(exact_rule_for("Bash", &serde_json::json!({"command": "rm *.log"})), None);
}

/// Sin un dato que fijar, la única regla posible sería la herramienta entera: aprobar de
/// antemano cualquier cosa que haga en el futuro, con cualquier input.
#[test]
fn no_se_recuerda_una_herramienta_sin_dato_legible() {
    assert_eq!(exact_rule_for("mcp__db__query", &serde_json::json!({"sql": "DROP TABLE x"})), None);
    assert_eq!(exact_rule_for("Bash", &serde_json::json!({})), None);
}

#[test]
fn un_patron_escrito_a_mano_se_valida() {
    for bueno in ["Read", "Bash(git status*)", "Edit(src/**)", "mcp__foo__bar"] {
        assert!(is_valid_pattern(bueno), "{bueno}");
    }
    // Un paréntesis sin cerrar parece acotado pero valdría para toda la herramienta.
    for malo in ["", "   ", "Bash(git status", "Bash()", "dos palabras"] {
        assert!(!is_valid_pattern(malo), "{malo:?}");
    }
}

// ── Las reglas por carpeta ──────────────────────────────────────

fn tarea_en(conn: &Connection, run_id: &str) -> String {
    tarea(conn, run_id)
}

/// Una regla es de la carpeta del proyecto: la de un proyecto no puede decidir por otro.
#[test]
fn las_reglas_de_una_carpeta_no_valen_en_otra() {
    let conn = test_db();
    run_en(&conn); // w1, /tmp/proy
    store::upsert_rule(&conn, "/tmp/proy", "Bash(git push*)", true).unwrap();
    store::upsert_rule(&conn, "/tmp/otro", "Bash(git push*)", false).unwrap();

    let de_proy = store::list_rules(&conn, "/tmp/proy").unwrap();
    assert_eq!(de_proy.len(), 1);
    assert!(de_proy[0].allow);
    assert!(store::list_rules(&conn, "/tmp/nadie").unwrap().is_empty());
}

/// Cambiarle el veredicto a una regla la reemplaza EN SU LUGAR. Con "gana la primera", una
/// regla que se mueve al final cambiaría de precedencia sin que nadie lo pidiera.
#[test]
fn cambiar_una_regla_no_la_mueve_de_lugar() {
    let conn = test_db();
    store::upsert_rule(&conn, "/p", "Bash(a)", true).unwrap();
    store::upsert_rule(&conn, "/p", "Bash(b)", true).unwrap();
    store::upsert_rule(&conn, "/p", "Bash(a)", false).unwrap();

    let reglas = store::list_rules(&conn, "/p").unwrap();
    assert_eq!(reglas.iter().map(|r| r.pattern.as_str()).collect::<Vec<_>>(), ["Bash(a)", "Bash(b)"]);
    assert!(!reglas[0].allow, "quedó con el veredicto nuevo");
}

#[test]
fn la_carpeta_de_una_tarea_es_la_de_su_run() {
    let conn = test_db();
    let run = run_en(&conn);
    let id = tarea_en(&conn, &run);
    assert_eq!(store::project_cwd_of_task(&conn, &id).as_deref(), Some("/tmp/proy"));
    assert_eq!(store::project_cwd_of_task(&conn, "no-existe"), None);
}

fn db_compartida() -> crate::database::DbConnection {
    std::sync::Arc::new(std::sync::Mutex::new(test_db()))
}

/// El circuito completo del broker con reglas de la base: lo que una regla cubre se
/// contesta al instante, sin llegar a la cola, y queda anotado como decisión de la regla.
#[test]
fn una_regla_guardada_contesta_sin_preguntar_y_queda_anotada() {
    let _serial = con_broker_limpio();
    let db = db_compartida();
    let id = {
        let conn = db.lock().unwrap();
        let run = run_en(&conn);
        store::upsert_rule(&conn, "/tmp/proy", "Bash(git status)", true).unwrap();
        tarea_en(&conn, &run)
    };

    let verdict = broker::resolve(
        &db,
        &id,
        "Bash",
        serde_json::json!({"command": "git status"}),
        Duration::from_secs(5),
    );
    assert!(verdict.allow);
    assert_eq!(verdict.by, broker::DecidedBy::Rule);
    assert!(broker::pending().is_empty(), "no pasó por la cola");

    let conn = db.lock().unwrap();
    let (status, by): (String, String) = conn
        .query_row("SELECT status, decided_by FROM task_approvals WHERE task_id = ?1", [&id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((status.as_str(), by.as_str()), ("allowed", "rule"));
}

/// "Permitir siempre" en un agente tiene que destrabar a OTRO agente de la misma carpeta
/// que pidió exactamente lo mismo — y a ninguno de otra carpeta. Sin esto, el usuario
/// tendría que contestarle a mano algo que acaba de decir que no quiere contestar más.
#[test]
fn una_regla_nueva_destraba_a_los_que_esperaban_lo_mismo_en_su_carpeta() {
    let _serial = con_broker_limpio();
    let db = db_compartida();
    let (misma, otra_carpeta, otro_pedido) = {
        let conn = db.lock().unwrap();
        let run = run_en(&conn);
        conn.execute(
            "INSERT INTO runs (id, workspace_id, objective, cwd, created_at)
             VALUES ('r-otro', 'w1', 'x', '/tmp/otro', 0)",
            [],
        )
        .unwrap();
        (tarea_en(&conn, &run), tarea_en(&conn, "r-otro"), tarea_en(&conn, &run))
    };

    let test_cmd = serde_json::json!({"command": "cargo test"});
    let esperan: Vec<_> = [
        ("a", misma.clone(), test_cmd.clone()),
        ("b", otra_carpeta.clone(), test_cmd.clone()),
        ("c", otro_pedido.clone(), serde_json::json!({"command": "git push"})),
    ]
    .into_iter()
    .map(|(id, task, input)| {
        std::thread::spawn(move || broker::ask(id, &task, "Bash", input, Duration::from_secs(5)))
    })
    .collect();
    while broker::pending().len() < 3 {
        std::thread::yield_now();
    }

    {
        let conn = db.lock().unwrap();
        store::upsert_rule(&conn, "/tmp/proy", "Bash(cargo test)", true).unwrap();
    }
    assert_eq!(broker::release_matching(&db, "/tmp/proy"), 1, "solo el pedido igual, en su carpeta");

    let mut restantes: Vec<String> = broker::pending().into_iter().map(|p| p.id).collect();
    restantes.sort();
    assert_eq!(restantes, ["b", "c"]);

    // Se liberan los demás para que los hilos terminen.
    broker::decide("b", false, None);
    broker::decide("c", false, None);
    let veredictos: Vec<_> = esperan.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(veredictos[0].allow);
    assert_eq!(veredictos[0].by, broker::DecidedBy::Rule);
}

/// El plazo de un pedido es fijo. Antes se renovaba cada vez que se contestaba el pedido de
/// OTRO agente (`notify_all` los despierta a todos), así que con varios agentes activos un
/// pedido podía no vencer nunca.
#[test]
fn contestar_otros_pedidos_no_renueva_el_plazo_de_uno() {
    let _serial = con_broker_limpio();
    let espera = std::thread::spawn(|| {
        let empezo = std::time::Instant::now();
        let v = broker::ask("lento", "t1", "Bash", serde_json::json!({}), Duration::from_millis(300));
        (v, empezo.elapsed())
    });

    // Mientras tanto, otros pedidos se contestan una y otra vez, despertando a todos.
    let fin = std::time::Instant::now() + Duration::from_millis(900);
    let mut n = 0;
    while std::time::Instant::now() < fin {
        let id = format!("ruido-{n}");
        let id2 = id.clone();
        let h = std::thread::spawn(move || {
            broker::ask(&id2, "t2", "Bash", serde_json::json!({}), Duration::from_secs(5))
        });
        while broker::get(&id).is_none() {
            std::thread::yield_now();
        }
        broker::decide(&id, true, None);
        h.join().unwrap();
        n += 1;
    }

    let (verdict, tardo) = espera.join().unwrap();
    assert_eq!(verdict.by, broker::DecidedBy::Timeout);
    assert!(tardo < Duration::from_millis(800), "venció a su hora pese al ruido: {tardo:?}");
}

/// Un segundo click (o una regla que llega justo) no puede cambiarle la respuesta a un
/// agente que ya está leyendo la primera.
#[test]
fn un_pedido_ya_resuelto_no_se_vuelve_a_resolver() {
    let _serial = con_broker_limpio();
    let h = std::thread::spawn(|| broker::ask("x", "t1", "Edit", serde_json::json!({}), Duration::from_secs(5)));
    while broker::get("x").is_none() {
        std::thread::yield_now();
    }
    // Se toman los dos lugares antes de que el hilo despierte.
    let primero = broker::decide("x", false, None);
    let segundo = broker::decide("x", true, None);
    assert!(primero);
    assert!(!segundo);
    assert!(!h.join().unwrap().allow, "vale la primera respuesta");
}

/// Pasar una tarea a una terminal no es un fallo. Al pararla, el proceso muere y el
/// supervisor llega igual con un veredicto de error; si ese veredicto pisara la fila, la
/// tarjeta diría "falló" de algo que el usuario solo movió a una tab.
#[test]
fn una_tarea_pasada_a_terminal_no_la_pisa_el_proceso_que_se_paro() {
    let conn = test_db();
    let run = run_en(&conn);
    let id = tarea(&conn, &run);
    store::mark_running(&conn, &id, "s", "/tmp/e.jsonl").unwrap();

    conn.execute("UPDATE tasks SET status = ?1 WHERE id = ?2", rusqlite::params![status::HANDED_OFF, id])
        .unwrap();
    store::finish_task(&conn, &id, &TaskOutcome::failed("killed")).unwrap();

    let t = store::task_by_id(&conn, &id).unwrap().unwrap();
    assert_eq!(t.status, status::HANDED_OFF);
    assert_eq!(t.error, None, "no se le inventa un error");
    assert_eq!(t.session_id.as_deref(), Some("s"), "y conserva la sesión con la que se reabre");
}
