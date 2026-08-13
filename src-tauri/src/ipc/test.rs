//! Tests del IPC: el formato del cable, la resolución de nombres que hace la CLI y la
//! instalación del binario.

use serde_json::json;

use super::commands::{
    init_prompt, match_account_id, match_preset_id, match_skill_ids, skill_names, InstalledSkill,
};
use super::install::{is_installed, target_dir};
use super::protocol::{arg_str, Handshake, Request, Response, PROTOCOL_VERSION};

// ── Formato del cable ───────────────────────────────────────────

/// El handshake y las requests son el contrato entre dos binarios que se compilan juntos
/// pero corren por separado: tienen que sobrevivir el ida y vuelta. Y `args` es opcional —
/// un comando sin flags no debería tener que mandar un objeto vacío explícito.
#[test]
fn el_formato_del_cable_sobrevive_el_ida_y_vuelta() {
    let hs = Handshake { port: 45123, token: "tok".into(), pid: 42, protocol: PROTOCOL_VERSION };
    let back: Handshake = serde_json::from_str(&serde_json::to_string(&hs).unwrap()).unwrap();
    assert_eq!(back.port, 45123);
    assert_eq!(back.token, "tok");
    assert_eq!(back.protocol, PROTOCOL_VERSION);

    let req = Request {
        token: "tok".into(),
        command: "tab.create".into(),
        args: json!({ "cwd": "/repo", "skills": ["a", "b"] }),
    };
    let back: Request = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
    assert_eq!(back.command, "tab.create");
    assert_eq!(back.args["skills"][1], "b");

    let sin_args: Request =
        serde_json::from_str(r#"{"token":"t","command":"tab.list"}"#).unwrap();
    assert!(sin_args.args.is_null());
}

/// Las respuestas omiten el campo que no aplica, para que la CLI pueda distinguir
/// "sin datos" de "hubo error" sin mirar `ok`.
#[test]
fn las_respuestas_omiten_el_campo_que_no_aplica() {
    let ok = serde_json::to_string(&Response::ok(json!({ "tabs": [] }))).unwrap();
    assert!(ok.contains("\"data\""));
    assert!(!ok.contains("\"error\""));

    let err = serde_json::to_string(&Response::err("no existe")).unwrap();
    assert!(err.contains("\"error\":\"no existe\""));
    assert!(!err.contains("\"data\""));
}

#[test]
fn un_argumento_faltante_nombra_el_flag_que_se_olvido() {
    let err = arg_str(&json!({}), "cwd").unwrap_err();
    assert_eq!(err, "Falta el argumento --cwd");
    assert_eq!(arg_str(&json!({ "cwd": "/x" }), "cwd").unwrap(), "/x");
}

// ── Resolución de nombres ───────────────────────────────────────

fn presets() -> Vec<(String, String)> {
    vec![("p1".into(), "entorno conda".into()), ("p2".into(), "node del proyecto".into())]
}

/// El texto de `--pre` se resuelve contra los guardados sin distinguir mayúsculas ni
/// espacios de más; si no coincide con ninguno se ejecuta tal cual.
#[test]
fn el_nombre_del_preset_se_resuelve_sin_distinguir_mayusculas() {
    assert_eq!(match_preset_id(&presets(), "Entorno Conda").unwrap(), "p1");
    assert_eq!(match_preset_id(&presets(), "  entorno conda  ").unwrap(), "p1");
    assert!(match_preset_id(&presets(), "nvm use").is_err(), "sin coincidencia, es literal");
}

/// El error tiene que decir qué SÍ existe: quien escribió mal un nombre no debería
/// tener que ir a la UI a mirarlo. Y sin nada guardado, dónde crearlos.
#[test]
fn un_preset_inexistente_lista_los_que_hay() {
    let err = match_preset_id(&presets(), "conda").unwrap_err();
    assert!(err.contains("entorno conda"), "{err}");
    assert!(err.contains("node del proyecto"), "{err}");

    let err = match_preset_id(&[], "conda").unwrap_err();
    assert!(err.contains("Configuración"), "{err}");
}

/// Cuentas de prueba: `(id, agente, nombre)`, como salen de `agent_accounts`.
fn accounts() -> Vec<(String, String, String)> {
    vec![
        ("a1".into(), "claude-code".into(), "trabajo".into()),
        ("a2".into(), "claude-code".into(), "personal".into()),
        ("a3".into(), "opencode".into(), "trabajo".into()),
    ]
}

/// Una cuenta se resuelve por nombre o por id, sin distinguir mayúsculas, y siempre
/// dentro de SU TUI: el mismo nombre en otra TUI es otra cuenta.
#[test]
fn una_cuenta_se_resuelve_dentro_de_su_propia_tui() {
    assert_eq!(match_account_id(&accounts(), "claude-code", "trabajo").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "opencode", "trabajo").unwrap(), "a3");
    assert_eq!(match_account_id(&accounts(), "claude-code", "A1").unwrap(), "a1");
    assert_eq!(match_account_id(&accounts(), "claude-code", "Personal").unwrap(), "a2");
}

/// El error más fácil de cometer, y el que en silencio abriría la tab con la cuenta
/// del sistema: pedir una cuenta que existe pero es de otra TUI.
#[test]
fn una_cuenta_de_otro_agente_se_rechaza_por_nombre() {
    let err = match_account_id(&accounts(), "opencode", "personal").unwrap_err();
    assert!(err.contains("es de 'claude-code'"), "{err}");
}

/// Un nombre desconocido lista las que hay; si esa TUI no tiene ninguna, explica dónde
/// se crean.
#[test]
fn una_cuenta_desconocida_explica_que_opciones_existen() {
    let err = match_account_id(&accounts(), "claude-code", "qa").unwrap_err();
    assert!(err.contains("trabajo") && err.contains("personal"), "{err}");

    let err = match_account_id(&accounts(), "codex", "qa").unwrap_err();
    assert!(err.contains("no tiene ninguna cuenta creada"), "{err}");
}

fn skill(id: &str, name: &str, author: Option<&str>, registry: Option<&str>) -> InstalledSkill {
    InstalledSkill {
        id: id.to_string(),
        name: name.to_string(),
        author: author.map(str::to_string),
        registry_name: registry.map(str::to_string),
    }
}

fn installed() -> Vec<InstalledSkill> {
    vec![
        skill("11111111-aaaa", "git-helper", None, None),
        skill("22222222-bbbb", "Testing Pro", None, None),
    ]
}

/// `--skills` toma NOMBRES, que es lo único que un humano (o un agente) puede escribir:
/// el id es un UUID. Pasarlos derecho a `attach_skill` no adjuntaba nada.
#[test]
fn los_nombres_de_skill_se_resuelven_a_sus_ids() {
    assert_eq!(
        match_skill_ids(&installed(), &["git-helper".to_string()]).unwrap(),
        vec!["11111111-aaaa"]
    );

    let requested = vec!["TESTING pro".to_string(), "11111111-aaaa".to_string()];
    assert_eq!(
        match_skill_ids(&installed(), &requested).unwrap(),
        vec!["22222222-bbbb", "11111111-aaaa"],
        "sin distinguir mayúsculas, y el id derecho también vale"
    );
}

/// Un nombre inventado tiene que fallar diciendo qué SÍ hay: la alternativa era una
/// tab creada en silencio sin las skills que se pidieron.
#[test]
fn una_skill_desconocida_nombra_las_instaladas() {
    let err = match_skill_ids(&installed(), &["no-existe".to_string()]).unwrap_err();
    assert!(err.contains("no-existe"));
    assert!(err.contains("git-helper") && err.contains("Testing Pro"));

    let err = match_skill_ids(&[], &["git-helper".to_string()]).unwrap_err();
    assert!(err.contains("skill install"), "el error tiene que decir el próximo paso: {err}");
}

/// Las dos grafías del flag son el mismo para el usuario, y un prompt en blanco no
/// debería disparar toda la espera de arranque para no mandar nada.
#[test]
fn el_flag_del_prompt_inicial_acepta_las_dos_grafias_e_ignora_los_blancos() {
    assert_eq!(init_prompt(&json!({ "initprompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "hola" })).as_deref(), Some("hola"));
    assert_eq!(init_prompt(&json!({ "initPrompt": "   " })), None);
    assert_eq!(init_prompt(&json!({})), None);
}

#[test]
fn los_nombres_de_skill_se_leen_del_array_que_manda_la_cli() {
    assert_eq!(
        skill_names(&json!({ "skills": ["a", "b"] })),
        Some(vec!["a".to_string(), "b".to_string()])
    );
    assert_eq!(skill_names(&json!({ "skills": [] })), None);
    assert_eq!(skill_names(&json!({})), None);
}

// ── Instalación del binario ─────────────────────────────────────

/// Instalar la CLI no puede pedir permisos de administrador.
#[test]
fn el_destino_es_una_carpeta_del_usuario() {
    let dir = target_dir().expect("debería resolverse en cualquier sistema con HOME");
    let home = dirs::home_dir().unwrap();
    assert!(dir.starts_with(&home), "el destino tiene que estar dentro del home del usuario");
}

/// Un symlink que quedó de una instalación anterior apunta a un binario viejo: tiene que
/// pedir reinstalación en vez de darse por instalado.
#[test]
fn un_symlink_que_apunta_a_otro_lado_no_cuenta_como_instalado() {
    let base = std::env::temp_dir().join(format!("cc-cli-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();

    let current = base.join("ccode-nuevo");
    let old = base.join("ccode-viejo");
    std::fs::write(&current, b"#!/bin/sh\n").unwrap();
    std::fs::write(&old, b"#!/bin/sh\n").unwrap();

    let link = base.join("link");
    assert!(!is_installed(&link, Some(&current)), "sin nada en el destino, no está instalado");

    symlink::symlink_file(&old, &link).unwrap();
    assert!(!is_installed(&link, Some(&current)));

    let _ = symlink::remove_symlink_auto(&link);
    symlink::symlink_file(&current, &link).unwrap();
    assert!(is_installed(&link, Some(&current)));

    let _ = std::fs::remove_dir_all(&base);
}

/// EL bug: dos skills instaladas con el mismo nombre y autores distintos. Quedarse con la
/// primera que devuelva SQLite le monta a la tab una skill que el usuario no pidió, sin
/// decir nada. Tiene que fallar y explicar cómo desambiguar.
#[test]
fn un_nombre_ambiguo_es_un_error_y_no_una_ruleta() {
    let dos = vec![
        skill("aaa", "testing", Some("anthropics"), Some("anthropics/skills")),
        skill("bbb", "testing", Some("midudev"), Some("autoskills")),
    ];

    let err = match_skill_ids(&dos, &["testing".to_string()]).unwrap_err();
    assert!(err.contains("aaa") && err.contains("bbb"), "tiene que listar las dos: {err}");
    assert!(err.contains("anthropics") && err.contains("midudev"), "y sus autores: {err}");

    // Con el id no hay ambigüedad posible.
    assert_eq!(match_skill_ids(&dos, &["bbb".to_string()]).unwrap(), vec!["bbb"]);
}

/// Con una sola instalada con ese nombre no hay nada que preguntar.
#[test]
fn un_nombre_sin_homonimas_se_resuelve_derecho() {
    let una = vec![skill("aaa", "testing", Some("anthropics"), None)];
    assert_eq!(match_skill_ids(&una, &["TESTING".to_string()]).unwrap(), vec!["aaa"]);
}

// ── El contrato entre `ccode` y el despachador ──────────────────

/// Los comandos que el binario `ccode` sabe nombrar, sacados de sus propias tablas.
fn cli_commands() -> Vec<String> {
    let src = include_str!("../bin/cli.rs");
    let mut out = Vec::new();
    // `shortcut()`: `"skills" => Some("skill.list"),`
    for cap in src.split("Some(\"").skip(1) {
        if let Some(cmd) = cap.split('"').next() {
            if cmd.contains('.') {
                out.push(cmd.to_string());
            }
        }
    }
    // `positionals()`: `"skill.show" | "skill.edit" => &["skill"],`
    for line in src.lines() {
        let line = line.trim();
        if !line.contains("=> &[") {
            continue;
        }
        for part in line.split("=>").next().unwrap_or("").split('|') {
            let name = part.trim().trim_matches(|c| c == '"' || c == ' ');
            if name.contains('.') {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Los comandos que el despachador atiende, sacados de su `match`.
fn dispatched_commands() -> Vec<String> {
    include_str!("commands/dispatch.rs")
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix('"')?;
            let (name, tail) = rest.split_once('"')?;
            tail.trim_start().starts_with("=>").then(|| name.to_string())
        })
        .filter(|c| c.contains('.'))
        .collect()
}

/// Que `ccode` nombre un comando que el backend ya no atiende no rompe nada en compilación
/// —son dos tablas de strings, en archivos distintos— y solo se nota cuando alguien lo
/// ejecuta y recibe "Comando desconocido". Este test es lo que ata las dos puntas.
#[test]
fn todo_lo_que_la_cli_sabe_nombrar_lo_atiende_el_despachador() {
    let dispatched = dispatched_commands();
    assert!(dispatched.len() > 15, "no se pudieron leer los comandos del despachador");

    let huerfanos: Vec<String> =
        cli_commands().into_iter().filter(|c| !dispatched.contains(c)).collect();
    assert!(huerfanos.is_empty(), "la CLI ofrece comandos que nadie atiende: {huerfanos:?}");
}

/// Y la contracara: un comando del backend que la ayuda de `ccode` no menciona es un
/// comando que nadie va a encontrar.
#[test]
fn la_ayuda_de_la_cli_menciona_los_comandos_de_skills() {
    let src = include_str!("../bin/cli.rs");
    for verbo in ["skill show", "skill new", "skill edit", "skill install", "skill search"] {
        assert!(src.contains(verbo), "la ayuda no menciona '{verbo}'");
    }
}
