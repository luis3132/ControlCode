//! CLI `controlcode` — Fase 8.
//!
//! Habla con la instancia de la app que esté corriendo (ver `ipc::protocol`). Toda la
//! salida va a stdout como JSON en una línea, para que un agente la parsee sin heurísticas;
//! los mensajes para humanos (ayuda, errores de uso) van a stderr.
//!
//! El código de salida distingue los casos que a un agente le importan: 0 todo bien,
//! 1 la app rechazó el comando, 2 error de uso, 3 la app no está corriendo.

use controlcode_lib::ipc::protocol::{handshake_path, Handshake, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::ExitCode;

const EXIT_OK: u8 = 0;
const EXIT_COMMAND_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_NO_APP: u8 = 3;

const USAGE: &str = "\
ccode — controla la app Control Code desde la terminal

USO
  ccode <grupo> <acción> [--flag valor ...]

TABS
  tab list                                    Tabs abiertas ahora
  tab create --cwd <ruta> --agent <id>        Abre una tab nueva
              [--window <label>] [--skills a,b]
  tab close --tab <id>                        Cierra una tab
  tab output --tab <id> [--lines 200]         Últimas líneas de su terminal
  tab send --tab <id> --text \"...\"            Escribe en su terminal (+ Enter)
           [--no-enter]

VENTANAS
  window list                                 Ventanas abiertas
  window create                               Abre una ventana nueva

WORKSPACES
  workspace list                              Workspaces guardados
  workspace open --workspace <id|nombre>      Abre uno
                 [--close-current]
  workspace status                            Qué hay abierto ahora

SKILLS
  skill list                                  Instaladas + disponibles en repos
  skill install --skill <nombre|id>           Instala desde los repos habilitados

OTROS
  app status                                  Versión y estado de la app
  --json-args '{...}'                         Pasa argumentos crudos en JSON

La salida siempre es una línea JSON en stdout.
Códigos de salida: 0 ok · 1 el comando falló · 2 uso incorrecto · 3 la app no corre
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
        eprint!("{USAGE}");
        return ExitCode::from(if args.is_empty() { EXIT_USAGE } else { EXIT_OK });
    }
    if args[0] == "--version" || args[0] == "-V" {
        println!("{}", json!({ "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION }));
        return ExitCode::from(EXIT_OK);
    }

    if args.len() < 2 {
        eprintln!("Falta la acción para '{}'. Probá: ccode --help", args[0]);
        return ExitCode::from(EXIT_USAGE);
    }

    let command = format!("{}.{}", args[0], args[1]);
    let parsed = match parse_flags(&args[2..]) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(EXIT_USAGE);
        }
    };

    match send(&command, parsed) {
        Ok(response) => {
            let body = if response.ok {
                response.data.unwrap_or(Value::Null)
            } else {
                json!({ "error": response.error.unwrap_or_default() })
            };
            println!("{body}");
            ExitCode::from(if response.ok { EXIT_OK } else { EXIT_COMMAND_FAILED })
        }
        Err(e) => {
            println!("{}", json!({ "error": e.message }));
            ExitCode::from(e.code)
        }
    }
}

struct CliError {
    message: String,
    code: u8,
}

/// `--flag valor` y `--flag` (booleano). Las claves se pasan a camelCase para que el
/// backend reciba los mismos nombres que usa el resto de la app (`--close-current` →
/// `closeCurrent`). `--skills a,b` se parte en array, que es lo que espera el frontend.
fn parse_flags(args: &[String]) -> Result<Value, String> {
    let mut map = Map::new();
    let mut i = 0;

    while i < args.len() {
        let raw = &args[i];
        let Some(key) = raw.strip_prefix("--") else {
            return Err(format!("Argumento inesperado '{raw}' (los flags empiezan con --)"));
        };

        // Escotilla para lo que el parseo simple no cubra (objetos anidados, etc.).
        if key == "json-args" {
            let value = args.get(i + 1).ok_or("--json-args necesita un valor")?;
            let extra: Value = serde_json::from_str(value)
                .map_err(|e| format!("--json-args no es JSON válido: {e}"))?;
            if let Value::Object(obj) = extra {
                map.extend(obj);
            } else {
                return Err("--json-args tiene que ser un objeto JSON".to_string());
            }
            i += 2;
            continue;
        }

        let camel = to_camel_case(key);
        match args.get(i + 1) {
            // El siguiente token es otro flag (o no hay ninguno) → este es booleano.
            Some(next) if !next.starts_with("--") => {
                map.insert(camel.clone(), value_for(&camel, next));
                i += 2;
            }
            _ => {
                map.insert(camel, Value::Bool(true));
                i += 1;
            }
        }
    }

    Ok(Value::Object(map))
}

fn value_for(key: &str, raw: &str) -> Value {
    match key {
        "skills" => Value::Array(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.to_string()))
                .collect(),
        ),
        "lines" => raw.parse::<u64>().map(Value::from).unwrap_or_else(|_| Value::String(raw.into())),
        _ => Value::String(raw.to_string()),
    }
}

fn to_camel_case(flag: &str) -> String {
    let mut out = String::with_capacity(flag.len());
    let mut upper_next = false;
    for c in flag.chars() {
        if c == '-' {
            upper_next = true;
        } else if upper_next {
            out.extend(c.to_uppercase());
            upper_next = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn send(command: &str, args: Value) -> Result<Response, CliError> {
    let path = handshake_path();
    let raw = std::fs::read_to_string(&path).map_err(|_| CliError {
        message: format!(
            "Control Code no parece estar corriendo (no se encontró {}). Abrí la app y volvé a intentar.",
            path.display()
        ),
        code: EXIT_NO_APP,
    })?;

    let handshake: Handshake = serde_json::from_str(&raw).map_err(|e| CliError {
        message: format!("El archivo de handshake está corrupto ({e}); reiniciá la app"),
        code: EXIT_NO_APP,
    })?;

    if handshake.protocol != PROTOCOL_VERSION {
        return Err(CliError {
            message: format!(
                "La app habla el protocolo v{} y esta CLI la v{PROTOCOL_VERSION}. Actualizá la que haya quedado vieja.",
                handshake.protocol
            ),
            code: EXIT_NO_APP,
        });
    }

    let stream = TcpStream::connect(("127.0.0.1", handshake.port)).map_err(|_| CliError {
        message: format!(
            "No se pudo conectar al puerto {} (la app con PID {} pudo haber cerrado). Reiniciá la app.",
            handshake.port, handshake.pid
        ),
        code: EXIT_NO_APP,
    })?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));

    let request = Request { token: handshake.token, command: command.to_string(), args };
    let payload = serde_json::to_string(&request).map_err(|e| CliError {
        message: e.to_string(),
        code: EXIT_USAGE,
    })?;

    let mut writer = stream.try_clone().map_err(|e| CliError {
        message: e.to_string(),
        code: EXIT_NO_APP,
    })?;
    writeln!(writer, "{payload}").and_then(|_| writer.flush()).map_err(|e| CliError {
        message: format!("No se pudo enviar el comando: {e}"),
        code: EXIT_NO_APP,
    })?;

    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| CliError {
        message: format!("No llegó respuesta: {e}"),
        code: EXIT_NO_APP,
    })?;

    serde_json::from_str(&line).map_err(|e| CliError {
        message: format!("Respuesta ilegible de la app: {e}"),
        code: EXIT_NO_APP,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(args: &[&str]) -> Value {
        parse_flags(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn kebab_flags_become_camel_case_keys() {
        // El backend usa los mismos nombres que el resto de la app (camelCase), pero en
        // una terminal lo natural es escribir kebab-case.
        assert_eq!(to_camel_case("close-current"), "closeCurrent");
        assert_eq!(to_camel_case("no-enter"), "noEnter");
        assert_eq!(to_camel_case("tab"), "tab");

        let v = flags(&["--close-current"]);
        assert_eq!(v["closeCurrent"], Value::Bool(true));
    }

    #[test]
    fn value_and_boolean_flags_are_told_apart() {
        let v = flags(&["--tab", "abc", "--no-enter", "--text", "hola"]);
        assert_eq!(v["tab"], "abc");
        assert_eq!(v["noEnter"], Value::Bool(true));
        assert_eq!(v["text"], "hola");
    }

    #[test]
    fn typed_flags_are_converted() {
        let v = flags(&["--skills", "a, b ,c", "--lines", "50"]);
        assert_eq!(v["skills"], serde_json::json!(["a", "b", "c"]));
        assert_eq!(v["lines"], serde_json::json!(50));
    }

    #[test]
    fn json_args_escape_hatch_merges_into_the_map() {
        let v = flags(&["--tab", "t1", "--json-args", r#"{"nested":{"a":1}}"#]);
        assert_eq!(v["tab"], "t1");
        assert_eq!(v["nested"]["a"], 1);
    }

    #[test]
    fn a_bare_word_is_a_usage_error_not_a_silent_drop() {
        let args: Vec<String> = vec!["oops".into()];
        assert!(parse_flags(&args).is_err());
    }

    /// Un valor que arranca con `--` se lee como el flag siguiente, no como valor. Es la
    /// limitación conocida del parser; `--json-args` es la salida para esos casos.
    #[test]
    fn dash_prefixed_values_need_the_json_escape_hatch() {
        let v = flags(&["--text", "--algo"]);
        assert_eq!(v["text"], Value::Bool(true));
        assert_eq!(v["algo"], Value::Bool(true));

        let v = flags(&["--json-args", r#"{"text":"--algo"}"#]);
        assert_eq!(v["text"], "--algo");
    }
}
