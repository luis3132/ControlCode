//! Fuente `skillssh` — el directorio abierto de skills de <https://skills.sh>.
//!
//! A diferencia de `local` y `github`, acá NO se habla con ninguna API: todo pasa por la
//! CLI oficial (`npx skills …`), que es la vía pública y gratuita del proyecto. Eso deja
//! la integración atada a un contrato que ellos mantienen y documentan, en vez de a
//! endpoints internos que pueden cambiar sin aviso.
//!
//! Dos comandos alcanzan:
//!
//! - `npx skills find <query>` — con query en la línea de comandos imprime la lista y
//!   termina; sin query abre un buscador interactivo, que acá no serviría de nada.
//! - `npx skills add <owner/repo@slug>` — instala la skill.
//!
//! `add` no tiene forma de elegir el destino: escribe siempre relativo a su directorio de
//! trabajo (`./.claude/skills/<slug>/`). Se aprovecha eso corriéndolo con el cwd apuntando
//! a una carpeta temporal nuestra, y de ahí el `SKILL.md` resultante entra por el mismo
//! pipeline de instalación que usa cualquier otra fuente. Así una skill de skills.sh queda
//! indistinguible del resto: misma copia global, mismos symlinks, mismo desinstalador.
//!
//! Requiere Node instalado. Cuando no está, el error lo dice con todas las letras en vez
//! de dejar un "no se encontró el programa" del sistema operativo — ver [`ensure_npx`].

use std::path::{Path, PathBuf};
use std::process::Command;

/// Cuánto puede tardar `npx skills add` clonando el repo de origen antes de rendirse.
/// La CLI clona el repo entero para sacar una sola skill, así que un repo grande con una
/// conexión lenta necesita bastante más que un fetch normal.
const CLONE_TIMEOUT_MS: &str = "180000";

/// El identificador de Claude Code dentro de la CLI de skills — define en qué carpeta deja
/// la skill instalada (`.claude/skills/`). No es el mismo string que el `agent_id` de
/// ControlCode; se fija acá porque lo único que importa es dónde aterriza el archivo, y de
/// esa carpeta lo levantamos nosotros.
const SKILLS_AGENT: &str = "claude-code";

/// Carpeta, relativa al cwd con el que se corrió `npx skills add`, donde deja lo instalado.
const INSTALL_SUBDIR: &str = ".claude/skills";

/// Una skill del directorio, tal como sale de `npx skills find`.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillsShHit {
    /// `owner/repo/slug` — identifica la skill de forma única en todo el directorio.
    pub id: String,
    /// `owner/repo` del repositorio de GitHub que la publica.
    pub source: String,
    pub slug: String,
    /// Instalaciones acumuladas, ya formateadas por la CLI (`"3.3K"`, `"1.2M"`). Se guarda
    /// el texto y no un número porque es lo único que la CLI expone, y es exactamente lo
    /// que se quiere mostrar.
    pub installs: Option<String>,
}

/// Traduce un id del directorio (`owner/repo/slug`) a la forma que `npx skills add`
/// espera para instalar una skill puntual (`owner/repo@slug`).
///
/// Vive acá y no en quien instala porque es parte del contrato con la CLI: el id es lo
/// único que se guarda en el cache, y esta es la única forma de volver de ahí al comando.
pub fn add_target(id: &str) -> Option<String> {
    let (source, slug) = id.rsplit_once('/')?;
    if source.is_empty() || slug.is_empty() || !source.contains('/') {
        return None;
    }
    Some(format!("{source}@{slug}"))
}

// ── Ejecución de la CLI ──────────────────────────────────────────

/// `npx` no es un ejecutable en Windows sino un `.cmd`, y `CreateProcess` (lo que usa
/// `Command` por debajo) no sabe correr scripts de shell: hay que pasar por `cmd`.
fn npx_command() -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "npx"]);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new("npx")
    }
}

/// Variables comunes a toda invocación de la CLI.
///
/// `CI=1` es la parte importante: sin eso la CLI decide si puede preguntar mirando si su
/// entrada es una terminal, y al lanzarla desde una app de escritorio esa heurística puede
/// dejarla esperando una respuesta que nunca va a llegar. Con `CI` puesto se comporta
/// siempre de forma no interactiva, que es la única que sirve acá.
fn with_env(cmd: &mut Command) {
    cmd.env("CI", "1");
    cmd.env("SKILLS_CLONE_TIMEOUT_MS", CLONE_TIMEOUT_MS);
    // Sin esto la CLI puede pintar de colores incluso redirigida, y el parser tendría que
    // lidiar con secuencias ANSI. Igual se limpian por las dudas (ver `strip_ansi`).
    cmd.env("NO_COLOR", "1");
    cmd.env("FORCE_COLOR", "0");
    // `npx` pregunta antes de bajar un paquete que no está en cache; sin esto la primera
    // búsqueda de la máquina se colgaría esperando un "sí".
    cmd.env("npm_config_yes", "true");
}

/// Verifica que se pueda ejecutar `npx` antes de intentar nada más.
///
/// Es la diferencia entre "Node.js no está instalado" y un críptico "No such file or
/// directory (os error 2)" saliendo del sistema operativo. Se llama al refrescar el
/// repositorio, así el problema se ve en la pantalla de repositorios y no recién cuando
/// alguien busca algo.
pub fn ensure_npx() -> Result<(), String> {
    let mut cmd = npx_command();
    with_env(&mut cmd);
    match cmd.arg("--version").output() {
        Ok(out) if out.status.success() => Ok(()),
        // `npx` existe pero devolvió error: raro, pero es un entorno de Node roto, no uno
        // ausente — conviene decir cuál de las dos cosas es.
        Ok(out) => Err(format!(
            "`npx` está instalado pero falló al ejecutarse ({}). {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        Err(_) => Err(NPX_MISSING.to_string()),
    }
}

pub const NPX_MISSING: &str = "skills.sh necesita Node.js instalado: usa su CLI oficial \
    (`npx skills`) en vez de una API. Instalá Node.js desde https://nodejs.org y volvé a \
    refrescar este repositorio. Si ya lo tenés, puede que la app no vea tu PATH — probá \
    abrirla desde una terminal.";

/// Quita las secuencias de escape ANSI (colores, movimientos de cursor) de la salida.
///
/// La CLI dibuja spinners y colorea resultados; el parser necesita el texto pelado. Se
/// implementa a mano en vez de sumar una dependencia: el subconjunto que hace falta —
/// `ESC [ … letra` — se resuelve en unas pocas líneas.
fn strip_ansi(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // Tras el ESC viene un byte que indica el tipo de secuencia; para `[` (la familia
        // CSI, que es la que usa la CLI) el final es la primera letra que aparezca.
        // Cualquier otra secuencia queda descartada con haber consumido ese byte.
        if chars.next() == Some('[') {
            for f in chars.by_ref() {
                if f.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

// ── Búsqueda ─────────────────────────────────────────────────────

/// Parsea la salida de `npx skills find`. Cada resultado ocupa dos líneas:
///
/// ```text
/// callstack/react-native-testing-library@react-native-testing 3.3K installs
/// └ https://skills.sh/callstack/react-native-testing-library/react-native-testing
/// ```
///
/// El ancla es la línea del link, no la del nombre: de ahí sale el `owner/repo/slug`
/// completo y sin ambigüedad (un slug puede tener guiones, y el `@` del nombre no alcanza
/// para separar si el repo tuviera uno). La línea de arriba solo aporta las instalaciones.
fn parse_find_output(raw: &str) -> Vec<SkillsShHit> {
    const LINK: &str = "https://skills.sh/";
    let clean = strip_ansi(raw);
    let lines: Vec<&str> = clean.lines().map(str::trim).collect();

    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(pos) = line.find(LINK) else { continue };
        let id = line[pos + LINK.len()..].trim().trim_end_matches('/');

        // `owner/repo/slug`: menos partes es un link a otra cosa (el home, un pack), más
        // partes no lo produce esta salida.
        let parts: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() != 3 {
            continue;
        }

        // Las instalaciones vienen en la línea anterior, después del nombre. Que falten no
        // invalida el resultado: la CLI las omite cuando son cero.
        let installs = i
            .checked_sub(1)
            .and_then(|p| lines.get(p))
            .and_then(|prev| prev.split_once(" installs"))
            .and_then(|(head, _)| head.rsplit(char::is_whitespace).next())
            .filter(|s| !s.is_empty() && s.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .map(|s| s.to_string());

        out.push(SkillsShHit {
            id: parts.join("/"),
            source: format!("{}/{}", parts[0], parts[1]),
            slug: parts[2].to_string(),
            installs,
        });
    }
    out
}

/// Busca en el directorio de skills.sh. `owner` restringe a un publicador puntual.
///
/// Bloquea el hilo hasta que la CLI termina — quien la llame desde un contexto async tiene
/// que sacarla del hilo del runtime (ver `marketplace::search_remote_registries`).
pub fn search(query: &str, owner: Option<&str>) -> Result<Vec<SkillsShHit>, String> {
    let query = query.trim();
    // Menos de dos caracteres los rechaza el buscador del propio servicio; cortar acá evita
    // un `npx` entero para recibir un error.
    if query.len() < 2 {
        return Ok(Vec::new());
    }

    let mut cmd = npx_command();
    with_env(&mut cmd);
    cmd.args(["-y", "skills", "find", query]);
    if let Some(owner) = owner.map(str::trim).filter(|o| !o.is_empty()) {
        cmd.args(["--owner", owner]);
    }

    let out = cmd.output().map_err(|_| NPX_MISSING.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "`npx skills find` falló: {}",
            strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim()
        ));
    }
    Ok(parse_find_output(&String::from_utf8_lossy(&out.stdout)))
}

// ── Instalación ──────────────────────────────────────────────────

/// Corre `npx skills add` con el cwd apuntando a `staging` y devuelve la carpeta donde
/// quedó la skill — la que contiene su `SKILL.md`.
///
/// `--copy` es deliberado: por defecto la CLI puede dejar symlinks a su propia cache, y
/// acá la carpeta temporal se borra apenas termina la instalación. Se necesitan archivos
/// de verdad para poder copiarlos a la biblioteca global.
pub fn install_into(staging: &Path, target: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(staging).map_err(|e| e.to_string())?;

    let mut cmd = npx_command();
    with_env(&mut cmd);
    cmd.current_dir(staging);
    cmd.args(["-y", "skills", "add", target, "--agent", SKILLS_AGENT, "--yes", "--copy"]);

    let out = cmd.output().map_err(|_| NPX_MISSING.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "`npx skills add {target}` falló: {}",
            strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim()
        ));
    }

    let installed = staging.join(INSTALL_SUBDIR);
    let slug = target.rsplit('@').next().unwrap_or(target);
    find_installed_skill(&installed, slug).ok_or_else(|| {
        // La CLI puede terminar con éxito sin instalar nada (un slug que ya no existe en el
        // repo, por ejemplo); su propio mensaje es la mejor pista que tenemos.
        let detail = strip_ansi(&String::from_utf8_lossy(&out.stdout));
        let tail: Vec<&str> = detail.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        format!(
            "`npx skills add {target}` no dejó ningún SKILL.md. Última salida: {}",
            tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" · ")
        )
    })
}

/// Busca la carpeta instalada dentro de `.claude/skills/`. Se prefiere la que coincide con
/// el slug pedido, pero si la CLI la nombró distinto y hay una sola, se toma esa.
fn find_installed_skill(dir: &Path, slug: &str) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("SKILL.md").is_file())
        .collect();

    candidates
        .iter()
        .find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(slug)))
        .or_else(|| candidates.first())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_parser_saca_las_skills_de_la_salida_real() {
        // Salida textual de `npx skills find "react testing"`, con los colores que la CLI
        // emite incluso redirigida.
        let raw = "\u{1b}[38;5;102mInstall with\u{1b}[0m npx skills add <owner/repo@skill>\n\n\
            \u{1b}[38;5;145mcallstack/react-native-testing-library@react-native-testing\u{1b}[0m \u{1b}[36m3.3K installs\u{1b}[0m\n\
            \u{1b}[38;5;102m└ https://skills.sh/callstack/react-native-testing-library/react-native-testing\u{1b}[0m\n\n\
            \u{1b}[38;5;145mgithub/awesome-copilot@react19-test-patterns\u{1b}[0m \u{1b}[36m1.1K installs\u{1b}[0m\n\
            \u{1b}[38;5;102m└ https://skills.sh/github/awesome-copilot/react19-test-patterns\u{1b}[0m\n";

        let hits = parse_find_output(raw);
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0],
            SkillsShHit {
                id: "callstack/react-native-testing-library/react-native-testing".into(),
                source: "callstack/react-native-testing-library".into(),
                slug: "react-native-testing".into(),
                installs: Some("3.3K".into()),
            }
        );
        assert_eq!(hits[1].source, "github/awesome-copilot");
        assert_eq!(hits[1].installs.as_deref(), Some("1.1K"));
    }

    /// Lo que se le pasa a `add` es `owner/repo@slug`, no el id con barras.
    #[test]
    fn el_id_se_traduce_al_target_que_espera_la_cli() {
        assert_eq!(
            add_target("callstack/react-native-testing-library/react-native-testing").as_deref(),
            Some("callstack/react-native-testing-library@react-native-testing")
        );
        // Un id incompleto no puede convertirse en un comando: mejor fallar que ejecutar
        // `npx skills add` con algo que no identifica ninguna skill.
        for bad in ["", "solo-slug", "owner/repo", "owner/repo/"] {
            assert!(add_target(bad).is_none(), "debería fallar: {bad:?}");
        }
    }

    /// La línea de encabezado del propio comando también contiene "skills.sh"; no debe
    /// colarse como resultado. Lo mismo cualquier link que no sea de tres segmentos.
    #[test]
    fn el_parser_ignora_links_que_no_son_una_skill() {
        let raw = "Browse at https://skills.sh/\n\
            └ https://skills.sh/owner\n\
            └ https://skills.sh/owner/repo\n\
            └ https://skills.sh/a/b/c/d\n";
        assert!(parse_find_output(raw).is_empty());
    }

    #[test]
    fn una_skill_sin_instalaciones_igual_se_lista() {
        let raw = "someone/repo@nueva\n└ https://skills.sh/someone/repo/nueva\n";
        let hits = parse_find_output(raw);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].installs, None);
    }

    #[test]
    fn strip_ansi_deja_solo_el_texto() {
        assert_eq!(strip_ansi("\u{1b}[36mhola\u{1b}[0m"), "hola");
        assert_eq!(strip_ansi("a\u{1b}[1G\u{1b}[Jb"), "ab");
        assert_eq!(strip_ansi("sin escapes"), "sin escapes");
    }

    #[test]
    fn una_busqueda_demasiado_corta_no_llega_a_ejecutar_nada() {
        // El servicio exige dos caracteres; devolver vacío sin lanzar el proceso es la
        // diferencia entre no hacer nada y arrancar un `npx` por cada tecla.
        assert_eq!(search("a", None).unwrap(), Vec::new());
        assert_eq!(search("   ", None).unwrap(), Vec::new());
    }

    /// Contrato real con la CLI: busca e instala de verdad.
    ///
    /// Va con `#[ignore]` porque necesita red y Node instalado — no puede correr en la
    /// suite normal. Es la única prueba que detecta que `npx skills` cambió el formato de
    /// su salida o el nombre de sus flags, así que conviene correrla al tocar este módulo:
    ///
    /// ```text
    /// cargo test --lib skillssh -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "necesita red y Node.js instalado"]
    fn e2e_la_cli_responde_como_espera_el_parser() {
        ensure_npx().expect("npx tiene que estar disponible para esta prueba");

        let hits = search("react testing", None).expect("la búsqueda debe funcionar");
        assert!(!hits.is_empty(), "el directorio tiene que devolver algo para 'react testing'");
        for h in &hits {
            assert_eq!(h.id.split('/').count(), 3, "id mal parseado: {}", h.id);
            assert!(add_target(&h.id).is_some(), "id no instalable: {}", h.id);
        }

        // Un publicador que no existe no es un error: es una búsqueda sin resultados.
        assert!(search("react testing", Some("no-existe-este-publicador-xyz")).unwrap().is_empty());

        let tmp = std::env::temp_dir().join(format!("cc-skillssh-e2e-{}", uuid::Uuid::new_v4()));
        let dir = install_into(&tmp, "anthropics/skills@webapp-testing").expect("debe instalar");
        assert!(dir.join("SKILL.md").is_file(), "la skill instalada necesita su SKILL.md");
        // `--copy` tiene que dejar archivos reales: la carpeta temporal se borra enseguida.
        assert!(!dir.join("SKILL.md").symlink_metadata().unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn se_elige_la_carpeta_que_coincide_con_el_slug() {
        let tmp = std::env::temp_dir().join(format!("cc-skillssh-{}", uuid::Uuid::new_v4()));
        for name in ["otra", "buscada"] {
            let dir = tmp.join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        }
        // Sin SKILL.md no es una skill instalada, aunque la carpeta exista.
        std::fs::create_dir_all(tmp.join("vacia")).unwrap();

        let found = find_installed_skill(&tmp, "buscada").unwrap();
        assert_eq!(found.file_name().unwrap(), "buscada");
        assert!(find_installed_skill(&tmp, "inexistente").is_some(), "cae a la única/primera");
        assert!(find_installed_skill(&tmp.join("nada"), "x").is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
