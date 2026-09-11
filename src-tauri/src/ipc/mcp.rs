//! `ccode mcp --task <id>`: el servidor MCP por el que un agente headless pide permiso.
//!
//! Es un **puente, no un servidor de verdad**: cada `tools/call` se traduce a un `Request`
//! del protocolo que la app y la CLI ya comparten, y la respuesta vuelve por el mismo
//! camino. Por eso no abre ningún puerto ni inventa autorización: reusa el handshake con
//! token de `~/.controlcode/ipc.json`, que es el mismo que usa cualquier otro comando de
//! `ccode`.
//!
//! Se lanza **uno por tarea**, y el `--task` es lo que le dice a la app a qué tarjeta
//! pertenece el pedido. El agente lo arranca solo: el supervisor le escribe un
//! `--mcp-config` que lo nombra, y Claude Code lo levanta como proceso hijo suyo.
//!
//! ## El protocolo, verificado contra `claude 2.1.269`
//!
//! JSON-RPC 2.0, una línea por mensaje, sobre stdio. El cliente manda `initialize`,
//! después `notifications/initialized`, después `tools/list`, y recién entonces
//! `tools/call` con `{ tool_name, input, tool_use_id }`. La respuesta esperada es un
//! bloque de texto cuyo contenido es el JSON `{"behavior":"allow","updatedInput":{…}}` o
//! `{"behavior":"deny","message":"…"}`.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

/// El nombre con el que el agente la ve: `mcp__controlcode__approve_tool_use`.
pub const SERVER_NAME: &str = "controlcode";
pub const TOOL_NAME: &str = "approve_tool_use";

/// Cuánto espera el puente una decisión.
///
/// Es largo a propósito: del otro lado hay una persona que tiene que mirar un diff y
/// decidir, y cortar a los treinta segundos convertiría "todavía no miré" en "denegado".
/// El tope existe igual porque un agente esperando para siempre a una app que se cerró
/// tampoco sirve.
pub const APPROVAL_TIMEOUT_SECS: u64 = 3600;

/// Corre el bucle del servidor hasta que el cliente cierra stdin.
///
/// `send` es cómo se le pregunta a la app; se recibe como parámetro para poder probar el
/// protocolo sin una app corriendo detrás.
pub fn serve<R, W, F>(task_id: &str, input: R, mut output: W, mut send: F) -> std::io::Result<()>
where
    R: BufRead,
    W: Write,
    F: FnMut(&str, Value) -> Result<Value, String>,
{
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };

        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let id = req.get("id").cloned();

        // Sin `id` es una notificación: no lleva respuesta. Contestarle una igual es lo
        // que rompe a los clientes estrictos.
        let Some(id) = id else { continue };

        let response = match method {
            "initialize" => {
                // Se le devuelve la MISMA versión de protocolo que pidió. Fijar una nuestra
                // haría que el puente dejara de andar cada vez que la TUI se actualiza, y
                // acá no hay ninguna capacidad que dependa de la versión.
                let version = req
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18");
                ok(id, json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                }))
            }
            "tools/list" => ok(id, json!({ "tools": [tool_schema()] })),
            "tools/call" => {
                let name = req.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
                if name != TOOL_NAME {
                    ok(id, deny_content(&format!("'{name}' no es una herramienta de este servidor")))
                } else {
                    let args = req.pointer("/params/arguments").cloned().unwrap_or(json!({}));
                    ok(id, call(task_id, &args, &mut send))
                }
            }
            _ => json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("método no soportado: {method}") }
            }),
        };

        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_schema() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": "Ask Control Code whether this tool use is allowed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
            },
            "required": ["tool_name", "input"],
        },
    })
}

/// Pregunta a la app y arma el bloque que el agente espera.
fn call<F>(task_id: &str, args: &Value, send: &mut F) -> Value
where
    F: FnMut(&str, Value) -> Result<Value, String>,
{
    let tool_name = args.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let input = args.get("input").cloned().unwrap_or(json!({}));

    let payload = json!({
        "taskId": task_id,
        "toolName": tool_name,
        "input": input,
        "timeout": APPROVAL_TIMEOUT_SECS,
    });

    match send("run.approve", payload) {
        Ok(data) => {
            let allow = data.get("allow").and_then(Value::as_bool).unwrap_or(false);
            if allow {
                // `updatedInput` va sin tocar: el broker todavía no edita lo que el agente
                // pidió, y devolver algo distinto de lo que se aprobó sería aprobar una
                // cosa y ejecutar otra.
                content(json!({ "behavior": "allow", "updatedInput": input }))
            } else {
                let reason = data
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("denegado desde Control Code");
                deny_content(reason)
            }
        }
        // Si la app no contesta (se cerró, se reinició), se DENIEGA. El agente corre sin
        // que nadie lo mire: ante la duda, que no toque nada.
        Err(e) => deny_content(&format!("Control Code no pudo responder: {e}")),
    }
}

fn content(payload: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": payload.to_string() }] })
}

fn deny_content(message: &str) -> Value {
    content(json!({ "behavior": "deny", "message": message }))
}
