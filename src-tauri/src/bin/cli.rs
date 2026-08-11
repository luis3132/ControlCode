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
use std::time::Duration;

const EXIT_OK: u8 = 0;
const EXIT_COMMAND_FAILED: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_NO_APP: u8 = 3;

const USAGE: &str = "\
ccode — controla la app Control Code desde la terminal

USO
  ccode <grupo> <acción> [valor] [--flag valor ...]

  El primer valor puede ir suelto, sin su flag:
    ccode skill install git-helper       =  ccode skill install --skill git-helper
    ccode tab send <id> \"corré los tests\" =  ccode tab send --tab <id> --text \"...\"

TABS
  tab list                                    Tabs abiertas ahora
  tab create <ruta> --agent <id>              Abre una tab nueva
             [--skills a,b]                   · skills a adjuntar, por nombre
             [--account <nombre>]             · cuenta de esa TUI (ver `accounts`)
             [--pre \"<comando>\"]              · comando a ejecutar ANTES del agente
             [--pre-preset <nombre>]          · ídem, guardado (ver `prelaunch`)
             [--initprompt \"...\"]             · prompt inicial, enviado con Enter
             [--window <label>]                 cuando la TUI terminó de arrancar
  tab close <id>                              Cierra una tab
  tab output <id> [--lines 40]                Lo NUEVO desde la lectura anterior,
             [--full] [--raw]                 comprimido (errores, warnings, cola)
  tab send <id> \"...\" [--no-enter]            Escribe en su terminal (+ Enter) —
                                              así se sigue la conversación con
                                              una tab que ya está abierta

OBSERVAR TABS (modo push — evita el polling)
  watch add <id> [--idle 20]                  Empieza a observar una tab
  watch remove <id>                           Deja de observarla
  watch list                                  Tabs observadas y el límite vigente
  watch wait [--timeout 300] [--max 20]       Espera a que alguna tenga novedades

VENTANAS
  window list                                 Ventanas abiertas
  window create                               Abre una ventana nueva

WORKSPACES
  workspace list                              Workspaces guardados
  workspace open <id|nombre>                  Abre uno
                 [--close-current]
  workspace status                            Qué hay abierto ahora

AGENTES, CUENTAS Y SKILLS
  agents                                      Qué poner en --agent (incluye las custom)
  accounts                                    Qué poner en --account, por TUI
  prelaunch                                   Qué poner en --pre-preset
  skills                                      Qué poner en --skills (instaladas)
  skill install <nombre>                      Instala desde los repos habilitados

OTROS
  app status                                  Versión y estado de la app
  --json-args '{...}'                         Pasa argumentos crudos en JSON

`agents`, `accounts` y `skills` son atajos de `agent list`, `account list` y `skill list`.
Sin --account, la tab usa la cuenta principal (la de siempre).
--pre y --pre-preset se pueden repetir y se ejecutan EN EL ORDEN ESCRITO, mezclados entre
sí; si uno falla, el agente no arranca. Ej.:
  ccode tab create --cwd . --agent claude-code --pre-preset \"entorno conda\" --pre \"nvm use\"

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

    // `ccode skills` / `ccode agents`: listar es lo único que se hace con ellos, y exigir
    // `skill list` para eso era ceremonia sin ganancia.
    let (command, flag_args) = match shortcut(&args[0]) {
        Some(cmd) => (cmd.to_string(), &args[1..]),
        None => {
            if args.len() < 2 {
                eprintln!("Falta la acción para '{}'. Probá: ccode --help", args[0]);
                return ExitCode::from(EXIT_USAGE);
            }
            (format!("{}.{}", args[0], args[1]), &args[2..])
        }
    };

    let parsed = match parse_flags(flag_args, positionals(&command)) {
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

/// Grupos que se escriben solos porque tienen una sola acción útil.
fn shortcut(word: &str) -> Option<&'static str> {
    match word {
        "agents" => Some("agent.list"),
        "accounts" => Some("account.list"),
        "prelaunch" => Some("prelaunch.list"),
        "skills" => Some("skill.list"),
        _ => None,
    }
}

/// Argumentos que se pueden escribir sueltos, en orden, sin su flag.
///
/// `ccode skill install git-helper` en vez de `--skill git-helper`. Solo se declara acá lo
/// que tiene un argumento obvio y único: si hubiera dudas sobre a qué flag corresponde un
/// valor suelto, es mejor exigir el flag que adivinar mal.
fn positionals(command: &str) -> &'static [&'static str] {
    match command {
        "skill.install" => &["skill"],
        // El texto va segundo: `ccode tab send <id> "corré los tests"`.
        "tab.send" => &["tab", "text"],
        "tab.output" | "tab.close" | "watch.add" | "watch.remove" => &["tab"],
        "tab.create" => &["cwd"],
        "workspace.open" => &["workspace"],
        _ => &[],
    }
}

/// `--flag valor` y `--flag` (booleano). Las claves se pasan a camelCase para que el
/// backend reciba los mismos nombres que usa el resto de la app (`--close-current` →
/// `closeCurrent`). `--skills a,b` se parte en array, que es lo que espera el frontend.
fn parse_flags(args: &[String], positionals: &[&str]) -> Result<Value, String> {
    let mut map = Map::new();
    let mut i = 0;

    // Valores sueltos al principio: `ccode skill install git-helper`. Solo al principio —
    // después de que aparece el primer `--flag`, una palabra suelta es casi siempre un
    // error de tipeo, y tragársela en silencio sería peor que rechazarla.
    let mut next = 0;
    while i < args.len() && !args[i].starts_with("--") {
        let Some(key) = positionals.get(next) else {
            return Err(format!(
                "Argumento inesperado '{}'. Este comando {}",
                args[i],
                if positionals.is_empty() {
                    "solo toma flags (empiezan con --)".to_string()
                } else {
                    format!("toma como máximo {} valor(es) suelto(s): {}", positionals.len(), positionals.join(", "))
                }
            ));
        };
        map.insert(key.to_string(), value_for(key, &args[i]));
        next += 1;
        i += 1;
    }

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

        // `--pre` y `--pre-preset` son repetibles y comparten UNA lista, porque el orden
        // entre ellos es semántico: `--pre-preset conda --pre "nvm use"` no es lo mismo que
        // al revés. Acumularlos en arrays separados perdería justamente eso.
        if key == "pre" || key == "pre-preset" {
            let value = args
                .get(i + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| format!("--{key} necesita un valor"))?;
            let step = if key == "pre" {
                json!({ "command": value })
            } else {
                json!({ "presetName": value })
            };
            match map.entry("prelaunch".to_string()) {
                serde_json::map::Entry::Occupied(mut e) => {
                    if let Some(list) = e.get_mut().as_array_mut() {
                        list.push(step);
                    }
                }
                serde_json::map::Entry::Vacant(e) => {
                    e.insert(Value::Array(vec![step]));
                }
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
        // Un número mal escrito se manda tal cual como string: el backend lo rechaza con
        // un mensaje que nombra el flag, mejor que un "0" silencioso acá.
        "lines" | "timeout" | "max" | "idle" => {
            raw.parse::<u64>().map(Value::from).unwrap_or_else(|_| Value::String(raw.into()))
        }
        _ => Value::String(raw.to_string()),
    }
}

/// Cuánto esperar la respuesta de la app.
///
/// Casi todos los comandos responden al instante. Dos no:
/// - `watch wait` bloquea a propósito hasta su timeout, así que la CLI tiene que esperar
///   más que él o cortaría justo la llamada cuya gracia es quedarse esperando.
/// - `tab create --initprompt` espera a que la TUI termine de arrancar antes de escribirle,
///   y eso puede llevarse varias decenas de segundos con un agente lento.
fn read_timeout_for(command: &str, args: &Value) -> Duration {
    const DEFAULT: u64 = 30;
    match command {
        "watch.wait" => {
            let requested = args.get("timeout").and_then(Value::as_u64).unwrap_or(300);
            Duration::from_secs(requested + 15)
        }
        // Los topes del backend suman ~40s (15 para que aparezca el PTY + 25 de arranque).
        "tab.create" if has_init_prompt(args) => Duration::from_secs(75),
        _ => Duration::from_secs(DEFAULT),
    }
}

fn has_init_prompt(args: &Value) -> bool {
    ["initPrompt", "initprompt"].iter().any(|k| args.get(k).and_then(Value::as_str).is_some())
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
    let _ = stream.set_read_timeout(Some(read_timeout_for(command, &args)));

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
        parse_flags(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &[]).unwrap()
    }

    /// `--pre` y `--pre-preset` son lo único repetible de la CLI, y su orden es
    /// semántico: `nvm use` antes que algo que dependa de npm. Si el parser los pisara
    /// (que es lo que hace con cualquier otro flag repetido) la cadena quedaría en un solo
    /// paso, sin aviso.
    #[test]
    fn los_pre_comandos_se_acumulan_en_una_sola_lista_ordenada() {
        let v = flags(&[
            "--pre-preset", "entorno conda",
            "--pre", "nvm use",
            "--pre-preset", "node del proyecto",
        ]);
        assert_eq!(
            v["prelaunch"],
            serde_json::json!([
                { "presetName": "entorno conda" },
                { "command": "nvm use" },
                { "presetName": "node del proyecto" },
            ])
        );
    }

    #[test]
    fn un_pre_sin_valor_es_error_de_uso_y_no_un_booleano() {
        // Sin este guardia, `--pre --agent claude` tomaría `--pre` como bandera y perdería
        // el comando en silencio.
        let args: Vec<String> = vec!["--pre".into(), "--agent".into(), "claude".into()];
        assert!(parse_flags(&args, &[]).is_err());
    }

    #[test]
    fn sin_pre_no_aparece_la_clave() {
        // La rama de pre-lanzamiento no tiene que tocar nada para quien no la usa.
        assert!(flags(&["--agent", "claude-code"]).get("prelaunch").is_none());
    }

    fn parse(command: &str, args: &[&str]) -> Result<Value, String> {
        parse_flags(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            positionals(command),
        )
    }

    /// Escribir `--skill` para pasar el único argumento que el comando tiene era ruido.
    #[test]
    fn the_first_loose_value_fills_the_commands_main_flag() {
        assert_eq!(parse("skill.install", &["git-helper"]).unwrap()["skill"], "git-helper");
        assert_eq!(parse("tab.output", &["t1"]).unwrap()["tab"], "t1");
        assert_eq!(parse("workspace.open", &["cliente"]).unwrap()["workspace"], "cliente");
        assert_eq!(parse("tab.create", &["/repo/api"]).unwrap()["cwd"], "/repo/api");
    }

    /// El caso de seguir la conversación con una tab abierta: id y texto, sin flags.
    #[test]
    fn tab_send_takes_the_tab_and_the_text_loose() {
        let v = parse("tab.send", &["t1", "corré los tests"]).unwrap();
        assert_eq!(v["tab"], "t1");
        assert_eq!(v["text"], "corré los tests");

        // Y se puede seguir mezclando con flags.
        let v = parse("tab.send", &["t1", "escape", "--no-enter"]).unwrap();
        assert_eq!(v["text"], "escape");
        assert_eq!(v["noEnter"], Value::Bool(true));
    }

    /// La forma con flags explícitos tiene que seguir funcionando: es la que ya está
    /// escrita en scripts y en la skill instalada de la gente.
    #[test]
    fn the_explicit_flag_form_still_works() {
        let v = parse("skill.install", &["--skill", "git-helper"]).unwrap();
        assert_eq!(v["skill"], "git-helper");
    }

    /// Un valor suelto de más no se traga en silencio: casi siempre es un flag mal escrito.
    #[test]
    fn extra_loose_values_are_rejected() {
        let err = parse("skill.install", &["a", "b"]).unwrap_err();
        assert!(err.contains("b"), "el error tiene que nombrar el argumento sobrante: {err}");

        let err = parse("tab.list", &["algo"]).unwrap_err();
        assert!(err.contains("solo toma flags"));
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

    /// `watch wait` bloquea hasta 300s por defecto. Con el timeout fijo de 30s de antes,
    /// la CLI cortaba la conexión mucho antes de que la app tuviera algo que contar y el
    /// modo push no habría funcionado nunca.
    #[test]
    fn watch_wait_gets_a_read_timeout_longer_than_its_own_wait() {
        let quick = read_timeout_for("tab.list", &json!({}));
        assert_eq!(quick, Duration::from_secs(30));

        let default_wait = read_timeout_for("watch.wait", &json!({}));
        assert!(default_wait > Duration::from_secs(300));

        let custom = read_timeout_for("watch.wait", &json!({ "timeout": 900 }));
        assert!(custom > Duration::from_secs(900));
    }

    /// `ccode skills` y `ccode agents` no llevan acción; el resto sigue exigiéndola.
    #[test]
    fn single_word_groups_map_to_their_list_action() {
        assert_eq!(shortcut("skills"), Some("skill.list"));
        assert_eq!(shortcut("agents"), Some("agent.list"));
        assert_eq!(shortcut("tab"), None);
        assert_eq!(shortcut("skill"), None, "'skill install' necesita su acción");
    }

    /// Crear una tab con prompt inicial espera a que arranque la TUI. Con el timeout de
    /// 30s la CLI cortaba antes de que el backend terminara, y el usuario veía un fallo
    /// pese a que la tab quedaba creada y el prompt se mandaba igual.
    #[test]
    fn creating_a_tab_with_an_init_prompt_waits_longer() {
        assert_eq!(read_timeout_for("tab.create", &json!({ "cwd": "/x" })), Duration::from_secs(30));

        for key in ["initPrompt", "initprompt"] {
            let args = json!({ "cwd": "/x", key: "hola" });
            assert!(
                read_timeout_for("tab.create", &args) > Duration::from_secs(40),
                "{key} tiene que ampliar la espera"
            );
        }
    }

    /// El prompt casi siempre trae espacios y acentos; tiene que llegar íntegro y como un
    /// solo argumento.
    #[test]
    fn an_init_prompt_survives_the_flag_parser_intact() {
        let v = flags(&["--initprompt", "corré los tests y resumí los fallos"]);
        assert_eq!(v["initprompt"], "corré los tests y resumí los fallos");

        let v = flags(&["--init-prompt", "otro"]);
        assert_eq!(v["initPrompt"], "otro", "la variante con guión llega en camelCase");
    }

    #[test]
    fn numeric_flags_of_the_watch_commands_are_parsed_as_numbers() {
        let v = flags(&["--timeout", "600", "--max", "5", "--idle", "45"]);
        assert_eq!(v["timeout"], json!(600));
        assert_eq!(v["max"], json!(5));
        assert_eq!(v["idle"], json!(45));
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
        assert!(parse_flags(&args, &[]).is_err());
        // Y después de un flag tampoco, aunque el comando acepte valores sueltos.
        assert!(parse("tab.send", &["t1", "hola", "oops"]).is_err());
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
