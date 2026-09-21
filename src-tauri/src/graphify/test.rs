use super::targets::{install_command, target_count, target_dir, targets, Scope};
use super::{merge_steps, parse_version, run_output, GraphifyStep, DEFAULT_STEPS};

fn step(id: &str, command: &str) -> GraphifyStep {
    GraphifyStep { id: id.into(), command: command.into() }
}

/// Los comandos son del usuario; la lista de pasos es del instalador. Si una versión
/// futura agrega un paso, tiene que aparecer aunque esta máquina ya tenga los suyos
/// editados — y un id que ya no existe tiene que irse, no quedar como un botón muerto.
#[test]
fn se_conserva_el_comando_editado_pero_la_lista_la_pone_la_app() {
    let saved = vec![step("cli", "pipx install graphifyy"), step("viejo", "lo que sea")];
    let merged = merge_steps(&saved);

    assert_eq!(merged.len(), DEFAULT_STEPS.len());
    assert_eq!(merged[0], step("cli", "pipx install graphifyy"));
    assert_eq!(merged[1].id, "skill");
    assert_eq!(merged[1].command, DEFAULT_STEPS[1].1, "el paso que no editó queda de fábrica");
    assert!(!merged.iter().any(|s| s.id == "viejo"));
}

/// Un campo que quedó vacío no es "no instales nada": es un paso sin comando, y ejecutarlo
/// no haría nada sin decir por qué. Vuelve al de fábrica.
#[test]
fn un_comando_vacio_vuelve_al_de_fabrica() {
    let merged = merge_steps(&[step("cli", "   ")]);
    assert_eq!(merged[0].command, DEFAULT_STEPS[0].1);
}

#[test]
fn la_version_sale_de_lo_que_imprime_el_comando() {
    assert_eq!(parse_version("graphify 8.3.1\n").as_deref(), Some("8.3.1"));
    // Si cambia el formato, se devuelve la línea entera: saber que está instalado no
    // puede depender de acertarle.
    assert_eq!(parse_version("v8.3.1").as_deref(), Some("v8.3.1"));
    assert_eq!(parse_version("\n\n").as_deref(), None);
}

/// Un instalador imprime cientos de líneas de progreso y el error está en la última: lo
/// que se recorta es el principio, no el final.
#[test]
fn de_una_salida_larga_se_guarda_el_final() {
    let largo: String = (0..5000).map(|i| format!("línea {i}\n")).collect();
    let salida = run_output(largo.as_bytes(), b"error: no such option --xyz");
    assert!(salida.ends_with("error: no such option --xyz"));
    assert!(salida.starts_with("[…]\n"));
    assert!(!salida.contains("línea 0\n"));
    assert!(salida.chars().count() < largo.len());

    // Y una salida corta sale tal cual, con las dos partes en orden.
    assert_eq!(run_output(b"todo bien\n", b""), "todo bien");
    assert_eq!(run_output(b"", "falló".as_bytes()), "falló");
}

/// Graphify elige la carpeta por PLATAFORMA, no por el estándar abierto: la misma skill va
/// a `.claude/skills` o a `.opencode/skills` según a quién se la instales, y en el alcance
/// global algunas ni siquiera usan la misma carpeta que en el de proyecto. Esto es lo que
/// hace que el paso 2 no pueda ser un comando fijo.
#[test]
fn cada_plataforma_de_graphify_deja_la_skill_en_otra_carpeta() {
    let home = std::path::Path::new("/home/u");
    let cwd = std::path::Path::new("/repo");

    let global = targets(Scope::Global, home, cwd);
    let project = targets(Scope::Project, home, cwd);
    assert_eq!(global.len(), target_count());

    let path_of = |list: &[super::GraphifyTarget], platform: Option<&str>| {
        list.iter()
            .find(|t| t.platform.as_deref() == platform)
            .unwrap_or_else(|| panic!("falta la plataforma {platform:?}"))
            .path
            .clone()
    };

    assert_eq!(path_of(&global, None), "/home/u/.claude/skills/graphify");
    assert_eq!(path_of(&project, None), "/repo/.claude/skills/graphify");
    // OpenCode: global y proyecto NO son la misma carpeta.
    assert_eq!(path_of(&global, Some("opencode")), "/home/u/.config/opencode/skills/graphify");
    assert_eq!(path_of(&project, Some("opencode")), "/repo/.opencode/skills/graphify");
    assert_eq!(path_of(&project, Some("agents")), "/repo/.agents/skills/graphify");
}

/// Las dos carpetas donde la app monta sus propios symlinks (`skills::links`) son
/// `.claude/skills` y `.agents/skills`, y solo adentro del repo. Son los destinos donde la
/// skill de graphify va a convivir con las de la app, y es lo que hay que poder ver antes
/// de elegir.
#[test]
fn se_sabe_que_destinos_comparten_carpeta_con_las_skills_de_la_app() {
    let home = std::path::Path::new("/home/u");
    let cwd = std::path::Path::new("/repo");

    let compartidos = |scope| {
        targets(scope, home, cwd)
            .into_iter()
            .filter(|t| t.shared_with_app)
            .map(|t| t.platform.unwrap_or_else(|| "claude".into()))
            .collect::<Vec<_>>()
    };
    assert_eq!(compartidos(Scope::Project), vec!["claude", "agents"]);
    // En el home la app no monta nada, así que ahí no comparte con nadie.
    assert!(compartidos(Scope::Global).is_empty());

    // Y las carpetas coinciden de verdad con las que usa `skills::links`.
    let claude = crate::skills::links_dir_for("/repo", "claude-code").unwrap();
    let agentes = crate::skills::links_dir_for("/repo", "opencode").unwrap();
    let project = targets(Scope::Project, home, cwd);
    let path = |p: Option<&str>| {
        project.iter().find(|t| t.platform.as_deref() == p).unwrap().path.clone()
    };
    assert!(path(None).starts_with(claude.to_str().unwrap()));
    assert!(path(Some("agents")).starts_with(agentes.to_str().unwrap()));
}

/// El comando se arma entero y no se parchea el anterior: los flags van después del
/// subcomando, y reescribir una línea ya editada terminaba dejando dos `--platform`.
#[test]
fn el_comando_del_paso_2_sale_del_destino_elegido() {
    assert_eq!(install_command(None, Scope::Global), "graphify install");
    assert_eq!(install_command(None, Scope::Project), "graphify install --project");
    assert_eq!(
        install_command(Some("opencode"), Scope::Project),
        "graphify install --platform opencode --project"
    );
    // El de fábrica del paso 2 es exactamente el destino por defecto.
    assert_eq!(install_command(None, Scope::Global), DEFAULT_STEPS[1].1);
}

/// Una skill instalada se reconoce por su `SKILL.md`, y la versión sale del sello que
/// graphify deja al lado. Es lo que permite avisar que el paquete se actualizó y la skill
/// en disco quedó vieja, que es el caso que graphify avisa a mitad de una sesión.
#[test]
fn una_skill_instalada_se_reconoce_y_dice_con_que_version_se_escribio() {
    let tmp = std::env::temp_dir().join(format!("cc-graphify-{}", uuid::Uuid::new_v4()));
    let home = tmp.join("home");
    let cwd = tmp.join("repo");
    let dir = target_dir(0, Scope::Project, &home, &cwd).unwrap();
    std::fs::create_dir_all(&dir).unwrap();

    let leer = || {
        targets(Scope::Project, &home, &cwd)
            .into_iter()
            .find(|t| t.platform.is_none())
            .unwrap()
    };

    // La carpeta existe pero está vacía: no hay skill.
    assert_eq!(leer().installed_version, None);

    std::fs::write(dir.join("SKILL.md"), "# graphify").unwrap();
    std::fs::write(dir.join(".graphify_version"), "8.3.1\n").unwrap();
    assert_eq!(leer().installed_version.as_deref(), Some("8.3.1"));

    // Sin sello sigue estando instalada, solo que no se sabe de cuándo.
    std::fs::remove_file(dir.join(".graphify_version")).unwrap();
    assert_eq!(leer().installed_version, None);

    std::fs::remove_dir_all(&tmp).ok();
}

/// El alcance viaja como string desde el frontend (`"global"` / `"project"`). Si el
/// nombre no coincide, el comando falla en runtime y no al compilar — Configuración
/// quedaría en blanco sin decir por qué.
#[test]
fn el_alcance_se_lee_tal_como_lo_manda_el_frontend() {
    assert_eq!(serde_json::from_str::<Scope>("\"global\"").unwrap(), Scope::Global);
    assert_eq!(serde_json::from_str::<Scope>("\"project\"").unwrap(), Scope::Project);
    assert!(serde_json::from_str::<Scope>("\"Global\"").is_err());
}

/// Los extras (`graphifyy[pdf,video]`) van ENTRE COMILLAS: sin ellas zsh trata los
/// corchetes como un glob, no encuentra nada y aborta con un error que no los menciona.
/// Y se reemplaza el paquete donde esté, no se arma el comando de cero: así vale igual
/// para `uv tool install`, para `pipx install` o para lo que haya escrito la persona.
#[test]
fn los_extras_se_le_agregan_al_comando_que_haya() {
    use super::graphify_package_command as build;

    assert_eq!(build("uv tool install graphifyy".into(), vec![]), "uv tool install graphifyy");
    assert_eq!(
        build("uv tool install graphifyy".into(), vec!["pdf".into(), "video".into()]),
        "uv tool install \"graphifyy[pdf,video]\""
    );
    assert_eq!(
        build("pipx install graphifyy".into(), vec!["all".into()]),
        "pipx install \"graphifyy[all]\""
    );
    // Cambiar de extras no acumula: se reemplaza lo que ya estaba.
    assert_eq!(
        build("uv tool install \"graphifyy[pdf]\"".into(), vec!["mcp".into()]),
        "uv tool install \"graphifyy[mcp]\""
    );
    assert_eq!(
        build("uv tool install \"graphifyy[pdf]\"".into(), vec![]),
        "uv tool install graphifyy"
    );
    // Un comando con flags propios no se toca más allá del paquete.
    assert_eq!(
        build("pip install --user graphifyy".into(), vec!["sql".into()]),
        "pip install --user \"graphifyy[sql]\""
    );
}
