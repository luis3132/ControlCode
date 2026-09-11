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

/// Los cinco flags sin los cuales esto no es un agente headless supervisado, sino un
/// proceso suelto: sin `stream-json` no hay eventos, sin `--session-id` no se puede
/// reabrir como tab, y sin la pareja de permisos queda esperando a un humano que no está.
#[test]
fn el_lanzamiento_de_claude_pide_eventos_sesion_y_permisos_resueltos() {
    let ctx = LaunchCtx { session_id: "s-1", account_env: Default::default() };
    let launch = claude().launch("arreglá el bug", None, None, &ctx);
    let args = launch.args.join(" ");

    assert!(args.contains("-p arreglá el bug"));
    assert!(args.contains("--output-format stream-json"));
    assert!(args.contains("--session-id s-1"));
    assert!(args.contains("--permission-mode acceptEdits"));
    assert!(args.contains("--permission-prompts none"));

    // Nunca por default: dejar a un agente sin supervisión y sin límites son dos
    // decisiones distintas, y acá solo se tomó la primera.
    assert!(!args.contains("bypassPermissions"));
    assert!(!args.contains("--dangerously-skip-permissions"));
}

#[test]
fn el_modelo_y_el_presupuesto_solo_van_si_se_pidieron() {
    let ctx = LaunchCtx { session_id: "s-1", account_env: Default::default() };

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
