//! Tests de sesiones: descubrir la sesión real de una tab, su título y el export.

use std::path::{Path, PathBuf};

use std::fs;

use crate::database::{ArchivedSkill, SessionHistoryEntry, SiblingTab};

use super::export::*;
use super::title::*;

// ── Export a markdown ───────────────────────────────────────────


/// Muestra recortada de `opencode export` real (v1.18.4): la conversación vive en
/// `messages[].parts[]`, y solo las partes `text` son conversación — `step-start`,
/// `reasoning`, `tool` y `patch` son pasos internos que no van al markdown.
const OPENCODE_EXPORT: &str = r#"{
  "info": { "id": "ses_1", "title": "Refactor del parser" },
  "messages": [
    { "info": { "role": "user" },
      "parts": [ { "type": "text", "text": "arregla el parser" },
                 { "type": "file", "filename": "a.rs" } ] },
    { "info": { "role": "assistant" },
      "parts": [ { "type": "step-start" }, { "type": "reasoning", "text": "pensando" },
                 { "type": "tool", "tool": "edit" }, { "type": "step-finish" } ] },
    { "info": { "role": "assistant" },
      "parts": [ { "type": "text", "text": "Listo, cambié el lexer." },
                 { "type": "patch" } ] }
  ]
}"#;

#[test]
fn opencode_export_keeps_only_the_conversation() {
    let turns = parse_opencode_export(OPENCODE_EXPORT.as_bytes());

    // El mensaje del medio es puro paso interno (sin ninguna parte `text`) y no genera
    // un turno vacío; el siguiente del asistente sí, y no se fusiona con nada previo
    // porque en el medio no quedó ningún turno de assistant.
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].role, "user");
    assert_eq!(turns[0].text, "arregla el parser");
    assert_eq!(turns[1].role, "assistant");
    assert_eq!(turns[1].text, "Listo, cambié el lexer.");
}

#[test]
fn opencode_export_survives_garbage() {
    // Una instalación rota o una versión que cambie el formato devuelve vacío en vez de
    // reventar: el export igual se genera, solo que sin transcripción.
    assert!(parse_opencode_export(b"no soy json").is_empty());
    assert!(parse_opencode_export(b"{}").is_empty());
    assert!(parse_opencode_export(br#"{"messages":[]}"#).is_empty());
}

#[test]
fn transcript_reads_the_shapes_the_supported_clis_emit() {
    let dir = std::env::temp_dir().join(format!("cc-export-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("s.jsonl");
    std::fs::write(
        &path,
        concat!(
            // Claude Code: mensaje anidado bajo `message`, contenido como bloques.
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hola"}]}}"#, "\n",
            // Línea de metadata sin rol: se saltea.
            r#"{"type":"summary","summary":"algo"}"#, "\n",
            // Codex: rol plano, contenido string.
            r#"{"role":"assistant","content":"respuesta"}"#, "\n",
            // Streaming: dos líneas del mismo rol se unen en un turno.
            r#"{"role":"assistant","content":"continuada"}"#, "\n",
            // Rol que no interesa (tool): se saltea.
            r#"{"role":"tool","content":"salida de herramienta"}"#, "\n",
            // JSON inválido: se saltea sin romper.
            "no es json", "\n",
        ),
    ).unwrap();

    let turns = extract_transcript(&path);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].role, "user");
    assert_eq!(turns[0].text, "hola");
    assert_eq!(turns[1].role, "assistant");
    assert_eq!(turns[1].text, "respuesta\n\ncontinuada");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Gemini no escribe `role` en ningún lado: marca cada línea con `type: "user"|"gemini"`
/// y guarda el texto en `Part`s sin `type`. Con las dos cosas sin contemplar, el export
/// de una sesión de Gemini salía COMPLETAMENTE vacío.
#[test]
fn transcript_reads_gemini_sessions() {
    let dir = std::env::temp_dir().join(format!("cc-export-gem-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("session-a.jsonl");
    std::fs::write(
        &path,
        concat!(
            // Cabecera: sin rol ni contenido, se saltea sola.
            r#"{"sessionId":"ses-a","projectHash":"h","kind":"main"}"#, "\n",
            r#"{"id":"m1","type":"user","content":[{"text":"arreglá el login"}]}"#, "\n",
            // `gemini` es el rol del asistente, y un Part suelto (no lista) también vale.
            r#"{"id":"m2","type":"gemini","content":{"text":"Listo, cambié el guard."}}"#, "\n",
            // Un Part que no es texto (function call) no aporta turno.
            r#"{"id":"m3","type":"gemini","content":[{"functionCall":{"name":"edit"}}]}"#, "\n",
        ),
    )
    .unwrap();

    let turns = extract_transcript(&path);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].role, "user");
    assert_eq!(turns[0].text, "arreglá el login");
    assert_eq!(turns[1].role, "assistant");
    assert_eq!(turns[1].text, "Listo, cambié el guard.");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Claude Code también usa `type: "user"`, pero su rol real está en `message.role`. La
/// traducción de Gemini va última justamente para no pisarlo.
#[test]
fn gemini_role_mapping_does_not_hijack_other_agents() {
    let claude = serde_json::json!({
        "type": "user", "message": { "role": "user", "content": "hola" }
    });
    assert_eq!(role_of(&claude).as_deref(), Some("user"));

    let codex = serde_json::json!({ "type": "response_item", "payload": { "role": "assistant" } });
    assert_eq!(role_of(&codex).as_deref(), Some("assistant"));

    let meta = serde_json::json!({ "type": "session_meta", "payload": { "id": "x" } });
    assert_eq!(role_of(&meta), None);
}

/// Codex se inyecta contexto propio como si fuera el usuario; no es conversación.
#[test]
fn transcript_drops_the_context_codex_injects_as_the_user() {
    let dir = std::env::temp_dir().join(format!("cc-export-cdx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rollout.jsonl");
    std::fs::write(
        &path,
        concat!(
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\ncwd: /proj\n</environment_context>"}]}}"#, "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<user_instructions>usá tabs</user_instructions>"}]}}"#, "\n",
            r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"arreglá el parser"}]}}"#, "\n",
        ),
    )
    .unwrap();

    let turns = extract_transcript(&path);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].text, "arreglá el parser");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn timestamps_render_as_utc_iso() {
    assert_eq!(format_ts(0), "1970-01-01 00:00:00 UTC");
    assert_eq!(format_ts(1_700_000_000), "2023-11-14 22:13:20 UTC");
}

/// Sin transcripción legible el export no falla: sale la metadata y una nota.
#[test]
fn render_without_transcript_still_documents_the_session() {
    let entry = SessionHistoryEntry {
        id: "h1".into(),
        workspace_id: "ws".into(),
        agent_id: "claude-code".into(),
        agent_label: "Claude Code".into(),
        command: "claude".into(),
        cwd: "/proj".into(),
        title: Some("Mi sesión".into()),
        session_id: None,
        account_id: None,
        prelaunch: Vec::new(),
        skills: vec![ArchivedSkill {
            id: "s1".into(),
            name: "git-helper".into(),
            scope: "tab".into(),
        }],
        sibling_tabs: vec![SiblingTab {
            title: Some("Otra".into()),
            agent_label: "Gemini CLI".into(),
            cwd: "/proj/web".into(),
        }],
        opened_at: 0,
        closed_at: 60,
    };

    let md = render(&entry, Some("Mi WS"), &[]);
    assert!(md.starts_with("# Mi sesión"));
    assert!(md.contains("`git-helper` (tab)"));
    assert!(md.contains("Gemini CLI"));
    assert!(md.contains("No se pudo leer la conversación"));
}

// ── Títulos y descubrimiento de sesión ──────────────────────────


/// Con una cuenta alternativa, los transcripts NO están en `~/.claude`: viven dentro
/// del directorio de la cuenta (verificado: un `CLAUDE_CONFIG_DIR` nuevo se inicializa
/// autocontenido). Buscar en el home daría "sin sesión" para toda tab con cuenta
/// propia — ni título ni reanudación.
#[test]
fn claude_looks_for_transcripts_inside_the_account_profile() {
    let dir = claude_project_dir("/home/u/proj", Some(Path::new("/perfiles/trabajo")));
    assert_eq!(dir, PathBuf::from("/perfiles/trabajo/projects/-home-u-proj"));
}

#[test]
fn claude_without_account_uses_the_system_profile() {
    let dir = claude_project_dir("/home/u/proj", None);
    assert!(dir.ends_with(".claude/projects/-home-u-proj"), "{dir:?}");
}

/// El bug que dejaba sin sesión a proyectos enteros: la ruta con un espacio se traducía
/// a una carpeta inexistente, así que no se descubría nada. Verificado contra las
/// carpetas reales de una instalación de Claude Code.
#[test]
fn the_project_slug_replaces_everything_that_is_not_alphanumeric() {
    assert_eq!(
        claude_project_slug("/home/luis/Documents/proyecto wallet/pruebas/wallet"),
        "-home-luis-Documents-proyecto-wallet-pruebas-wallet"
    );
    assert_eq!(
        claude_project_slug("/home/u/mi_proyecto.v2"),
        "-home-u-mi-proyecto-v2"
    );
}

/// Las rutas sin caracteres raros dan lo mismo con la regla vieja y con la nueva — por
/// eso el bug pasó desapercibido tanto tiempo.
#[test]
fn plain_paths_are_unaffected_by_the_slug_rule() {
    let cwd = "/home/luis/Documents/XD/ControlCode";
    assert_eq!(claude_project_slug(cwd), cwd.replace('/', "-"));
}

/// Ninguno de los dos CLIs está instalado en la máquina de desarrollo, así que estos
/// tests son la única verificación posible: reproducen en disco el layout documentado
/// de cada uno y comprueban que el código lo lee. No prueban que la documentación sea
/// fiel al binario — eso solo lo confirma un Codex/Kimi real.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("cc-title-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn write(&self, rel: &str, body: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Cabecera real de un rollout de Codex, tal como la documenta el formato:
/// `{timestamp, type: "session_meta", payload: {id, cwd, …}}`.
fn codex_rollout(id: &str, cwd: &str, body: &str) -> String {
    format!(
        "{}\n{}",
        serde_json::json!({
            "timestamp": "2026-08-03T10:00:00Z",
            "type": "session_meta",
            "payload": { "id": id, "cwd": cwd, "source": "cli", "cli_version": "0.55.0" }
        }),
        body
    )
}

#[test]
fn codex_reads_id_and_cwd_from_the_session_meta_header() {
    let d = TempDir::new();
    let path = d.write("2026/08/03/rollout-a.jsonl", &codex_rollout("sess-a", "/proj", ""));

    let meta = codex_meta(&path).expect("la cabecera documentada debe parsearse");
    assert_eq!(meta.id.as_deref(), Some("sess-a"));
    assert_eq!(meta.cwd, Path::new("/proj"));
}

/// La regresión que motivó el cambio: el filtro anterior era `contenido.contains(cwd)`,
/// y `/proj` está contenido en `/proj2`, así que una tab de `/proj` podía adoptar el
/// session id de `/proj2` y reanudar la conversación de otro proyecto.
#[test]
fn codex_does_not_confuse_a_cwd_with_another_that_has_it_as_prefix() {
    let d = TempDir::new();
    d.write("2026/08/03/rollout-otro.jsonl", &codex_rollout("sess-otro", "/proj2", ""));

    assert_eq!(codex_session_file_in(&d.0, "/proj", None), None);

    let mine = d.write("2026/08/03/rollout-mio.jsonl", &codex_rollout("sess-mio", "/proj", ""));
    assert_eq!(codex_session_file_in(&d.0, "/proj", None), Some(mine));
}

#[test]
fn codex_finds_a_rollout_by_its_exact_session_id() {
    let d = TempDir::new();
    d.write("2026/08/03/a.jsonl", &codex_rollout("sess-a", "/proj", ""));
    let b = d.write("2026/08/03/b.jsonl", &codex_rollout("sess-b", "/proj", ""));

    // Se busca por id y no por "el más nuevo del cwd": con dos tabs en la misma carpeta
    // el más nuevo es el de la otra tab.
    let found = codex_rollouts_in(&d.0)
        .into_iter()
        .find(|p| codex_meta(p).and_then(|m| m.id).as_deref() == Some("sess-b"));
    assert_eq!(found, Some(b));
}

/// Codex se inyecta contexto propio con `role: "user"` al abrir la sesión. Si eso contara
/// como "primer mensaje", TODAS las tabs de Codex se llamarían `<environment_context>`.
#[test]
fn codex_title_skips_the_context_codex_injects_as_the_user() {
    let d = TempDir::new();
    let body = concat!(
        r#"{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>\n  cwd: /proj\n</environment_context>"}]}}"#,
        "\n",
        r#"{"timestamp":"t","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<user_instructions>usá tabs</user_instructions>"}]}}"#,
        "\n",
        r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"arreglá el parser"}}"#,
    );
    let path = d.write("r.jsonl", &codex_rollout("sess-a", "/proj", body));

    let result = codex_title(&path, "sin título");
    assert_eq!(result.title, "arreglá el parser");
    assert_eq!(result.source, "first_message");
}

#[test]
fn codex_falls_back_to_the_fallback_when_there_is_no_real_message() {
    let d = TempDir::new();
    let path = d.write("r.jsonl", &codex_rollout("sess-a", "/proj", ""));
    assert_eq!(codex_title(&path, "sin título").title, "sin título");
}

// ── Kimi Code ────────────────────────────────────────────────────

/// Layout documentado: `sessions/<workDirKey>/<sessionId>/state.json`.
#[test]
fn kimi_discovers_the_session_id_from_the_directory_name() {
    let d = TempDir::new();
    d.write(
        "wd_proj_0123456789ab/ses-42/state.json",
        r#"{"title":"Refactor del parser","workDir":"/proj"}"#,
    );

    let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).expect("debe encontrarla");
    assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-42"));
    assert_eq!(kimi_title(&dir, "sin título").title, "Refactor del parser");
}

/// El id es el nombre de la carpeta, no un campo: es lo que espera `kimi --session <id>`.
#[test]
fn kimi_filters_by_declared_cwd_when_state_declares_one() {
    let d = TempDir::new();
    d.write("wd_a_1/ses-a/state.json", r#"{"title":"A","workDir":"/otro"}"#);
    d.write("wd_b_2/ses-b/state.json", r#"{"title":"B","workDir":"/proj"}"#);

    let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).unwrap();
    assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-b"));
}

/// La doc no garantiza que `state.json` traiga el cwd. Cuando no lo trae, el filtro por
/// cwd no debe descartar la sesión — si lo hiciera, Kimi quedaría igual de roto que antes.
#[test]
fn kimi_keeps_sessions_that_do_not_declare_a_cwd() {
    let d = TempDir::new();
    d.write("wd_x_1/ses-x/state.json", r#"{"title":"Sin cwd"}"#);

    let dir = kimi_session_dir_in(&d.0, Some("/proj"), None).expect("no se debe descartar");
    assert_eq!(kimi_session_id(&dir).as_deref(), Some("ses-x"));
}

#[test]
fn kimi_uses_last_prompt_when_there_is_no_title_yet() {
    let d = TempDir::new();
    d.write("wd_x_1/ses-x/state.json", r#"{"title":"","lastPrompt":"corré los tests"}"#);
    let dir = kimi_session_dir_in(&d.0, None, None).unwrap();

    let result = kimi_title(&dir, "sin título");
    assert_eq!(result.title, "corré los tests");
    assert_eq!(result.source, "first_message");
}

/// Adentro de una sesión hay varios `.json` que NO son sesiones (`upcoming-goals.json`,
/// planes de agentes). Solo cuenta como sesión la carpeta con `state.json` propio.
#[test]
fn kimi_ignores_files_that_are_not_session_state() {
    let d = TempDir::new();
    d.write("wd_x_1/ses-x/state.json", r#"{"title":"Real"}"#);
    d.write("wd_x_1/ses-x/upcoming-goals.json", r#"{"goals":[]}"#);
    d.write("wd_x_1/ses-x/agents/main/plans/p1.json", r#"{"plan":"algo"}"#);

    assert_eq!(kimi_session_dirs_in(&d.0).len(), 1);
}

#[test]
fn kimi_points_the_transcript_at_the_main_agent_wire() {
    let d = TempDir::new();
    d.write("wd_x_1/ses-x/state.json", r#"{"title":"Real"}"#);
    let wire = d.write("wd_x_1/ses-x/agents/main/wire.jsonl", "");
    d.write("wd_x_1/ses-x/agents/agent-0/wire.jsonl", "");

    let dir = kimi_session_dir_in(&d.0, None, None).unwrap();
    assert_eq!(kimi_wire_file(&dir), Some(wire));
}

#[test]
fn kimi_survives_a_missing_or_broken_home() {
    let d = TempDir::new();
    assert!(kimi_session_dirs_in(&d.0.join("no-existe")).is_empty());

    d.write("wd_x_1/ses-x/state.json", "no soy json");
    let dir = kimi_session_dir_in(&d.0, None, None).unwrap();
    assert_eq!(kimi_title(&dir, "sin título").title, "sin título");
}

// ── Gemini CLI ───────────────────────────────────────────────────

/// Cabecera real de un archivo de chat de Gemini + una línea de mensaje.
fn gemini_chat(session_id: &str, kind: &str, body: &str) -> String {
    format!(
        "{}\n{}",
        serde_json::json!({
            "sessionId": session_id, "projectHash": "h",
            "startTime": "2026-08-03T10:00:00Z", "lastUpdated": "2026-08-03T10:05:00Z",
            "kind": kind
        }),
        body
    )
}

/// El slug de la carpeta es asignado por el registro de Gemini y NO se puede derivar del
/// cwd (`mi-proyecto`, `mi-proyecto-1` si choca), así que hay que consultarlo.
#[test]
fn gemini_resolves_the_project_dir_through_the_registry() {
    let d = TempDir::new();
    d.write("projects.json", r#"{"projects":{"/home/u/proj":"proj-1"}}"#);
    let chat = d.write("tmp/proj-1/chats/session-a.jsonl", &gemini_chat("ses-a", "main", ""));

    assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(chat));
}

/// Si el registro no ayuda (versión vieja, archivo corrupto), quedan los marcadores
/// `.project_root` que Gemini escribe en cada carpeta de proyecto.
#[test]
fn gemini_falls_back_to_the_project_root_markers() {
    let d = TempDir::new();
    d.write("tmp/proj-1/.project_root", "/home/u/proj\n");
    let chat = d.write("tmp/proj-1/chats/session-a.jsonl", &gemini_chat("ses-a", "main", ""));

    assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(chat));
}

/// Regresión: el filtro anterior era `contenido.contains(cwd)` sobre TODO `~/.gemini/tmp`,
/// y `/home/u/proj` está contenido en `/home/u/proj2`.
#[test]
fn gemini_does_not_pick_up_another_projects_session() {
    let d = TempDir::new();
    d.write("projects.json", r#"{"projects":{"/home/u/proj":"proj","/home/u/proj2":"proj2"}}"#);
    d.write("tmp/proj2/chats/session-otro.jsonl", &gemini_chat("ses-otro", "main", ""));
    let mine = d.write("tmp/proj/chats/session-mio.jsonl", &gemini_chat("ses-mio", "main", ""));

    assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(mine));
}

/// Los sub-agentes escriben su propio archivo en la misma carpeta `chats/`. Si la tab
/// adopta el id de un sub-agente, `--resume <id>` no devuelve a la conversación real.
#[test]
fn gemini_ignores_subagent_sessions() {
    let d = TempDir::new();
    d.write("tmp/proj/.project_root", "/home/u/proj");
    let main = d.write("tmp/proj/chats/session-main.jsonl", &gemini_chat("ses-main", "main", ""));
    // Se escribe después para que sea el más nuevo por mtime: sin el filtro, ganaría.
    d.write("tmp/proj/chats/session-sub.jsonl", &gemini_chat("ses-sub", "subagent", ""));

    assert_eq!(gemini_session_file_in(&d.0, "/home/u/proj", None), Some(main));
}

#[test]
fn gemini_reads_the_session_id_from_the_header() {
    let d = TempDir::new();
    let chat = d.write("c.jsonl", &gemini_chat("ses-42", "main", ""));
    assert_eq!(gemini_meta(&chat).unwrap().session_id.as_deref(), Some("ses-42"));
}

/// El contenido de Gemini es un `Part[]` sin campo `type` — antes solo se leía el caso
/// `content` string pelado, así que el título nunca salía del primer mensaje.
#[test]
fn gemini_title_reads_part_list_content() {
    let d = TempDir::new();
    let body = r#"{"id":"m1","type":"user","content":[{"text":"arreglá el login"}]}"#;
    let chat = d.write("c.jsonl", &gemini_chat("ses-a", "main", body));

    let result = gemini_title(&chat, "sin título");
    assert_eq!(result.title, "arreglá el login");
    assert_eq!(result.source, "first_message");
}

#[test]
fn gemini_title_prefers_the_summary() {
    let d = TempDir::new();
    let body = concat!(
        r#"{"id":"m1","type":"user","content":[{"text":"arreglá el login"}]}"#, "\n",
        r#"{"$set":{"summary":"Arreglo del login"}}"#,
    );
    let chat = d.write("c.jsonl", &gemini_chat("ses-a", "main", body));

    let result = gemini_title(&chat, "sin título");
    assert_eq!(result.title, "Arreglo del login");
    assert_eq!(result.source, "summary");
}
