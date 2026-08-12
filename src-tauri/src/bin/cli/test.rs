//! Tests del parser de flags de la CLI.

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
            { "pre": "nvm use" },
            { "presetName": "node del proyecto" },
        ])
    );
}

/// `--pre` manda el texto sin decidir: si es el nombre de un guardado o un comando
/// literal lo resuelve la app, que es donde está la base.
#[test]
fn pre_manda_el_texto_sin_interpretarlo() {
    let v = flags(&["--pre", "entorno conda", "--pre", "nvm use"]);
    assert_eq!(
        v["prelaunch"],
        serde_json::json!([{ "pre": "entorno conda" }, { "pre": "nvm use" }])
    );
}

#[test]
fn pre_preset_marca_el_paso_como_guardado_obligatorio() {
    let v = flags(&["--pre-preset", "entorno conda"]);
    assert_eq!(v["prelaunch"], serde_json::json!([{ "presetName": "entorno conda" }]));
}

#[test]
fn no_hay_tope_de_pasos() {
    let mut args: Vec<&str> = Vec::new();
    for _ in 0..12 {
        args.push("--pre");
        args.push("x");
    }
    assert_eq!(flags(&args)["prelaunch"].as_array().unwrap().len(), 12);
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
    // Buscar es la única forma de llegar a lo que hay en skills.sh: su directorio no se
    // puede listar de antemano, así que el texto suelto tiene que funcionar igual que
    // en `install`.
    assert_eq!(parse("skill.search", &["react testing"]).unwrap()["query"], "react testing");
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
