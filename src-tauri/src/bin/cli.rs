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
             [--pre <comando|guardado>]       · a ejecutar ANTES del agente; repetible
             [--pre-preset <nombre>]          · fuerza que sea un guardado, no un comando
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
  prelaunch [list]                            Qué poner en --pre
  skills                                      Qué poner en --skills (instaladas)
  skill search <texto>                        Busca en TODOS los repos, skills.sh incluido
                                              (tarda: el directorio se consulta por npx)
  skill install <nombre>                      Instala desde los repos habilitados
  skill show <nombre|id>                      Metadata + contenido del SKILL.md
  skill new <nombre>                          Crea una skill propia (origen local)
             [--description ...] [--categories a,b] [--agents a,b]
             [--file <ruta> | --content \"...\"]
  skill edit <nombre|id>                      Guarda contenido nuevo
             [--file <ruta> | --content \"...\"] [--name <nuevo>] [--copy]

OTROS
  app status                                  Versión y estado de la app
  --json-args '{...}'                         Pasa argumentos crudos en JSON

`agents`, `accounts` y `skills` son atajos de `agent list`, `account list` y `skill list`.
Editar una skill que vino de un repositorio NO la pisa: guarda una copia de origen local y
deja la original recibiendo actualizaciones. `--copy` fuerza esa copia también para una
skill propia. `--file` se lee desde el directorio donde corrés el comando.
Sin --account, la tab usa la cuenta principal (la de siempre).
--pre se repite sin límite y sus valores corren EN EL ORDEN ESCRITO; si uno falla, el
agente no arranca. Cada valor puede ser el nombre de un guardado o un comando literal:
  ccode tab create --cwd . --agent claude-code --pre \"entorno conda\" --pre \"nvm use\"

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
        Some(cmd) => {
            // `ccode prelaunch` y `ccode prelaunch list` son lo mismo. Escribir la accion
            // igual es lo natural para quien viene de `ccode account list`, y sin esto
            // fallaba con "argumento inesperado 'list'" — un error sin sentido para algo
            // que es exactamente lo que el atajo hace.
            let action = cmd.split('.').nth(1).unwrap_or("");
            let rest = match args.get(1) {
                Some(next) if next == action => &args[2..],
                _ => &args[1..],
            };
            (cmd.to_string(), rest)
        }
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

    // `--file` se resuelve ACÁ y viaja como `--content`: el archivo es relativo al cwd de
    // quien escribió el comando, no al de la app, y la app puede estar corriendo desde
    // cualquier otro lado. Además evita que el backend tenga que abrir rutas arbitrarias.
    let parsed = match inline_file(parsed) {
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
        "skill.show" | "skill.edit" => &["skill"],
        // `ccode skill new mi-skill` en vez de `--name mi-skill`.
        "skill.new" => &["name"],
        // `ccode skill search react` en vez de `--query react`.
        "skill.search" => &["query"],
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

        // `--pre` y `--pre-preset` son repetibles, sin tope, y comparten UNA lista: el
        // orden entre ellos es semántico (`nvm use` antes de lo que dependa de npm), así
        // que acumularlos en arrays separados perdería justamente eso.
        //
        // `--pre` acepta las dos cosas — el nombre de un guardado o un comando escrito a
        // mano — y se resuelve del lado de la app, que es donde están los guardados: si el
        // texto coincide con el nombre de uno, se usa ese; si no, se ejecuta tal cual.
        // `--pre-preset` es la forma explícita, para cuando un guardado se llama igual que
        // un comando que querés correr literal.
        if key == "pre" || key == "pre-preset" {
            let value = args
                .get(i + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or_else(|| format!("--{key} necesita un valor"))?;
            let step = if key == "pre" {
                json!({ "pre": value })
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

/// Reemplaza `--file <ruta>` por el contenido del archivo, en `content`.
///
/// Los dos no se pueden combinar: si vinieran juntos habría que elegir cuál gana, y
/// cualquier elección sería una sorpresa para quien mandó el otro.
fn inline_file(args: Value) -> Result<Value, String> {
    let Value::Object(mut map) = args else { return Ok(args) };
    let Some(file) = map.remove("file") else { return Ok(Value::Object(map)) };
    let Some(path) = file.as_str() else {
        return Err("--file necesita una ruta".to_string());
    };
    if map.contains_key("content") {
        return Err("Usá --file o --content, no los dos".to_string());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("No se pudo leer {path}: {e}"))?;
    map.insert("content".to_string(), Value::String(content));
    Ok(Value::Object(map))
}

fn value_for(key: &str, raw: &str) -> Value {
    match key {
        // Mismo trato que `--skills`: listas cortas separadas por coma.
        "skills" | "categories" | "agents" => Value::Array(
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

// El archivo vive fuera de `src/bin/` a propósito: el bundler de Tauri trata CADA entrada
// de ese directorio como un ejecutable a empaquetar, así que una carpeta `cli/` al lado de
// `cli.rs` le hacía buscar un binario `cli` que no existe y abortaba el empaquetado.
#[cfg(test)]
#[path = "../cli_test.rs"]
mod test;
