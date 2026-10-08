//! Tests de las TUIs que el usuario agrega a mano.

use super::custom::SessionIdSource;


#[test]
fn session_id_source_parses_both_forms() {
    assert_eq!(SessionIdSource::parse("filename"), SessionIdSource::Filename);
    assert_eq!(
        SessionIdSource::parse("field:session_id"),
        SessionIdSource::Field("session_id".to_string())
    );
    assert_eq!(SessionIdSource::parse("field: id "), SessionIdSource::Field("id".to_string()));
    // Formas inválidas caen al default en vez de romper: el descubrimiento por nombre
    // de archivo es el que funciona sin conocer nada del formato interno.
    assert_eq!(SessionIdSource::parse("field:"), SessionIdSource::Filename);
    assert_eq!(SessionIdSource::parse("cualquier cosa"), SessionIdSource::Filename);
}

// ── El registro único ───────────────────────────────────────────

use super::registry::{agent_def, AGENTS};
use super::SessionSource;

/// Los valores que el registro tiene que seguir devolviendo, TUI por TUI.
///
/// Antes de unificarlo, esta tabla estaba repartida en cuatro archivos (el catálogo acá,
/// la carpeta de skills en `skills/links.rs`, la variable de cuenta en
/// `accounts/profiles.rs` y los flags de reanudación en TypeScript). Este test es el que
/// hace revisable esa mudanza: si un valor cambió al moverlo, falla acá y no meses después
/// como "esta TUI no guarda las sesiones".
#[test]
fn el_registro_conserva_los_valores_que_estaban_repartidos() {
    struct Esperado {
        id: &'static str,
        command: &'static str,
        skills_dir: Option<&'static str>,
        env_var: Option<&'static str>,
        resume: Option<&'static str>,
    }
    const fn e(
        id: &'static str,
        command: &'static str,
        skills_dir: Option<&'static str>,
        env_var: Option<&'static str>,
        resume: Option<&'static str>,
    ) -> Esperado {
        Esperado { id, command, skills_dir, env_var, resume }
    }

    let esperado = [
        e("claude-code", "claude", Some(".claude/skills"), Some("CLAUDE_CONFIG_DIR"), Some("--resume {session}")),
        e("gemini-cli", "gemini", Some(".agents/skills"), None, Some("--resume {session}")),
        // `resume` es SUBCOMANDO en codex, no flag: con `--resume` abriría una sesión
        // nueva en silencio.
        e("codex", "codex", Some(".agents/skills"), Some("CODEX_HOME"), Some("resume {session}")),
        e("opencode", "opencode", Some(".agents/skills"), Some("XDG_DATA_HOME"), Some("--session {session}")),
        e("kimi-code", "kimi", Some(".agents/skills"), None, Some("--session {session}")),
        // bash no es una TUI de agente: no gestiona skills, ni cuentas, ni sesiones.
        e("bash", "bash", None, None, None),
    ];

    assert_eq!(AGENTS.len(), esperado.len(), "cambió la cantidad de TUIs de fábrica");

    for want in &esperado {
        let id = want.id;
        let def = agent_def(id).unwrap_or_else(|| panic!("falta {id} en el registro"));
        assert_eq!(def.command, want.command, "comando de {id}");
        assert_eq!(def.skills_dir, want.skills_dir, "carpeta de skills de {id}");
        assert_eq!(def.profile.map(|p| p.env_var), want.env_var, "variable de cuenta de {id}");
        assert_eq!(def.resume, want.resume, "args de reanudación de {id}");
    }
}

/// Los consumidores derivados tienen que ver lo mismo que la tabla: son los cuatro que
/// antes tenían su propia copia.
#[test]
fn los_consumidores_leen_del_registro() {
    // skills/links.rs
    assert_eq!(
        crate::skills::links_dir_for("/tmp/proyecto", "claude-code"),
        Some(std::path::PathBuf::from("/tmp/proyecto/.claude/skills"))
    );
    assert_eq!(
        crate::skills::links_dir_for("/tmp/proyecto", "codex"),
        Some(std::path::PathBuf::from("/tmp/proyecto/.agents/skills"))
    );
    // bash no declara carpeta, así que no reclama ningún symlink.
    assert_eq!(crate::skills::links_dir_for("/tmp/proyecto", "bash"), None);

    // agents/detector.rs
    assert_eq!(crate::agents::agent_label("kimi-code"), Some("Kimi Code"));
    assert_eq!(crate::agents::agent_command("kimi-code"), Some("kimi"));
    assert_eq!(crate::agents::agent_label("no-existe"), None);

    // El catálogo que ve el frontend arrastra los mismos valores.
    let front = crate::agents::agent_registry();
    let codex = front.iter().find(|a| a.id == "codex").expect("falta codex");
    assert_eq!(codex.resume.as_deref(), Some("resume {session}"));
    assert!(codex.supports_accounts);
    assert!(!front.iter().any(|a| a.id == "bash" && a.supports_accounts));
}

/// Cada TUI que sabe reanudar tiene que decir de dónde leer sus sesiones, y solo `bash`
/// puede no saber. Una TUI con `resume` pero sin estrategia sería una que la app ofrece
/// reanudar sin poder descubrir nunca el id — la reanudación no llegaría a activarse.
#[test]
fn toda_tui_que_reanuda_declara_donde_viven_sus_sesiones() {
    for def in AGENTS {
        if def.resume.is_some() {
            assert_ne!(def.sessions, SessionSource::None, "{} reanuda pero no dice de dónde", def.id);
        }
    }
}

/// El prefijo sale del catálogo y no de un `if` con un id adentro: mientras estuvo
/// escrito en `Terminal.tsx`, OpenCode arrancaba sin las tools y sin decir por qué.
///
/// El de OpenCode NO es cosmético: registra las tools de un servidor MCP con el nombre del
/// servidor delante, así que un texto que lo mande a `browser_marked` lo manda a una tool
/// que en su lista no existe.
#[test]
fn cada_tui_dice_como_recibe_el_mcp_y_como_nombra_sus_tools() {
    use crate::agents::McpStyle;
    use crate::ipc::mcp::tool_prefix;

    let style = |id: &str| crate::agents::agent_def(id).expect(id).mcp;
    assert_eq!(style("claude-code"), McpStyle::ClaudeFlags);
    assert_eq!(style("opencode"), McpStyle::OpencodeConfig);
    // Una salida a la terminal no es un agente: no hay a quién enchufarle nada.
    assert_eq!(style("bash"), McpStyle::None);

    assert_eq!(tool_prefix(McpStyle::OpencodeConfig), "controlcode_");
    assert_eq!(tool_prefix(McpStyle::ClaudeFlags), "");
    assert_eq!(tool_prefix(McpStyle::None), "");

    // El catálogo que ve el frontend lo arrastra: es de ahí de donde lo lee.
    let front = crate::agents::agent_registry();
    assert_eq!(front.iter().find(|a| a.id == "opencode").expect("falta opencode").mcp, McpStyle::OpencodeConfig);
}


/// Los niveles de esfuerzo salen del `--help` de la TUI instalada, no de una lista escrita
/// en el código. El texto es el de `claude --help` de la 2.1.293, con el envoltorio de
/// línea que mete la CLI justo en el medio de la lista.
#[test]
fn los_esfuerzos_se_leen_del_help() {
    let help = "  --debug [filter]                      Enable debug mode\n  --effort <level>                      Effort level for the current session\n\
                                        (low, medium, high, xhigh, max)\n  --environment <environment_id>        Create a new cloud session\n";
    assert_eq!(super::parse_effort_levels(help), ["low", "medium", "high", "xhigh", "max"]);

    // Una TUI que no habla de esfuerzo no ofrece el control, en vez de inventarle niveles.
    assert!(super::parse_effort_levels("  --model <model>  Model for the session\n").is_empty());
    assert!(super::parse_effort_levels("  --effort <level>  sin lista\n").is_empty());
}


/// Las palabras del "trabajando" se leen de la tira larga que trae el binario de la TUI, no
/// de una lista escrita acá. El buffer imita cómo quedan en el bundle: la palabra, unos
/// bytes de cabecera, la siguiente.
#[test]
fn las_palabras_salen_de_una_tira_larga() {
    const LISTA: [&str; 21] = [
        "Accomplishing", "Actioning", "Baking", "Beaming", "Booping", "Brewing", "Churning",
        "Conjuring", "Dancing", "Doodling", "Effecting", "Fermenting", "Frolicking", "Galloping",
        "Herding", "Hyperspacing", "Ideating", "Julienning", "Kneading", "Levitating", "Manifesting",
    ];
    /// La tira tal como la deja el bundle: cabecera corta y palabra, una detrás de otra.
    fn tira(words: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for w in words {
            out.extend_from_slice(&[0x0c, 0, 0, 0x80, 0x11, 0x22, 0x33, 0]);
            out.extend_from_slice(w.as_bytes());
        }
        out
    }

    let mut buf: Vec<u8> = b"ruido suelto Loading y mas de dieciseis bytes de distancia".to_vec();
    buf.extend_from_slice(&tira(&LISTA));
    buf.extend_from_slice(b"\0\0 y despues, bien lejos de la tira, otra cosa Compiling");

    assert_eq!(super::scan_words(&buf[..]), LISTA, "la tira entera, en orden y sin lo de alrededor");

    // Una palabra suelta no es una lista: sin tira larga no se devuelve nada, y la UI se
    // queda con su texto de siempre.
    assert!(super::scan_words(&b"Loading... Processing... Thinking..."[..]).is_empty());

    // Lo que SÍ puede pasar, y se acepta: una palabra pegada a la tira entra con ella. Es
    // una de más en un sorteo de doscientas, no vale pagarlo con un parser frágil.
    let mut pegada = tira(&["Rebooting"]);
    pegada.extend_from_slice(&tira(&LISTA));
    assert_eq!(super::scan_words(&pegada[..]).first().map(String::as_str), Some("Rebooting"));
}
