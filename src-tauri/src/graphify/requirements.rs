//! Lo que hay que tener ANTES de instalar graphify, y cómo se consigue en cada sistema.
//!
//! El paso 1 del instalador (`uv tool install graphifyy`) supone que `uv` existe, y en una
//! máquina recién armada no existe. Sin esto, el primer botón de la sección contesta
//! `uv: command not found` y no hay nada más que hacer desde la app.
//!
//! Los comandos son los de la tabla *Prerequisites* del README de graphify, uno por
//! sistema. Se muestra el del sistema donde corre la app y los otros quedan a la vista,
//! porque quien trabaja en dos máquinas quiere ver los dos.
//!
//! ## Lo que esto NO hace
//!
//! No instala nada solo, y el de `uv` en Linux/macOS es
//! `curl -LsSf https://astral.sh/uv/install.sh | sh`: bajar un script y ejecutarlo. Eso se
//! muestra tal como lo documenta graphify y lo aprieta la persona si quiere — no es algo
//! que la app vaya a hacer por su cuenta, ni un valor que convenga esconder detrás de un
//! botón que diga "instalar".

use serde::Serialize;

/// Un requisito: cómo se pregunta si está y cómo se instala en cada sistema.
struct Requirement {
    id: &'static str,
    /// El binario que se busca, y el flag con el que dice su versión.
    command: &'static str,
    version_flag: &'static str,
    docs_url: &'static str,
    /// Comando de instalación por sistema: `(sistema, comando)`. El sistema es el de
    /// `std::env::consts::OS` (`linux`, `macos`, `windows`), y `""` = sirve en cualquiera.
    installs: &'static [(&'static str, &'static str)],
}

/// Los tres de la tabla *Prerequisites*, en el orden en que hacen falta.
const REQUIREMENTS: &[Requirement] = &[
    Requirement {
        // Python no se instala con una línea en todos lados, y en Windows el instalador es
        // un `.exe` del sitio: por eso la fila lleva el link y solo comandos donde existen.
        id: "python",
        command: "python3",
        version_flag: "--version",
        docs_url: "https://www.python.org/downloads/",
        installs: &[
            ("macos", "brew install python@3.12"),
            ("linux", "sudo apt install python3.12 python3-pip"),
        ],
    },
    Requirement {
        id: "uv",
        command: "uv",
        version_flag: "--version",
        docs_url: "https://docs.astral.sh/uv/",
        installs: &[
            ("macos", "brew install uv"),
            ("windows", "winget install astral-sh.uv"),
            ("", "curl -LsSf https://astral.sh/uv/install.sh | sh"),
        ],
    },
    Requirement {
        id: "pipx",
        command: "pipx",
        version_flag: "--version",
        docs_url: "https://pipx.pypa.io/",
        installs: &[("linux", "sudo apt install pipx"), ("", "pip install pipx")],
    },
];

/// Un requisito con lo que se encontró en esta máquina.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyRequirement {
    pub id: String,
    pub command: String,
    pub docs_url: String,
    /// Lo que contestó `<command> --version`. `None` = no está en el PATH.
    pub version: Option<String>,
    /// El comando de instalación de ESTE sistema, ya elegido.
    pub install: Option<String>,
    /// Los de los otros sistemas, por si la máquina de al lado es otra.
    pub other_installs: Vec<String>,
}

/// La primera línea de lo que imprime un `--version`, que es donde va la versión.
///
/// Se devuelve entera (`Python 3.14.7`, `uv 0.5.11`) en vez de intentar sacarle el número:
/// cada programa la escribe distinto y lo único que hace falta es mostrarla.
pub fn first_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// El comando de instalación que le toca a este sistema, y los demás aparte.
///
/// Se separa del sondeo para poder probarlo sin depender del sistema donde corre el test.
fn for_os(requirement: &Requirement, os: &str) -> (Option<String>, Vec<String>) {
    // El del sistema exacto gana; si no hay, el genérico (`""`), que es el que sirve en
    // cualquier lado. El resto se ofrece como referencia, sin repetir el elegido.
    let chosen = requirement
        .installs
        .iter()
        .find(|(system, _)| *system == os)
        .or_else(|| requirement.installs.iter().find(|(system, _)| system.is_empty()))
        .map(|(_, command)| command.to_string());
    let others = requirement
        .installs
        .iter()
        .map(|(_, command)| command.to_string())
        .filter(|command| Some(command) != chosen.as_ref())
        .collect();
    (chosen, others)
}

/// Los requisitos, sondeando cada uno en el shell del usuario.
///
/// El sondeo va por el mismo shell de login que los pasos (ver [`super::shell_command`]):
/// una app abierta desde el menú del escritorio no hereda el PATH de la terminal, y sin
/// eso `uv` recién instalado aparecería como faltante.
pub fn probe(os: &str) -> Vec<GraphifyRequirement> {
    REQUIREMENTS
        .iter()
        .map(|requirement| {
            let version = super::probe_version(requirement.command, requirement.version_flag);
            let (install, other_installs) = for_os(requirement, os);
            GraphifyRequirement {
                id: requirement.id.to_string(),
                command: requirement.command.to_string(),
                docs_url: requirement.docs_url.to_string(),
                version,
                install,
                other_installs,
            }
        })
        .collect()
}

#[cfg(test)]
mod test {
    use super::*;

    /// El comando que se ofrece es el del sistema donde corre la app. El genérico es el
    /// respaldo, no el primero: en macOS `brew install uv` es mejor que bajar un script.
    #[test]
    fn cada_sistema_ve_su_comando_y_los_otros_quedan_a_la_vista() {
        let uv = &REQUIREMENTS[1];
        assert_eq!(for_os(uv, "macos").0.as_deref(), Some("brew install uv"));
        assert_eq!(for_os(uv, "windows").0.as_deref(), Some("winget install astral-sh.uv"));
        // Linux no tiene fila propia: le toca el genérico del README.
        assert_eq!(for_os(uv, "linux").0.as_deref(), Some("curl -LsSf https://astral.sh/uv/install.sh | sh"));
        // Y el elegido no se repite entre los otros.
        let (chosen, others) = for_os(uv, "macos");
        assert!(!others.contains(chosen.as_ref().unwrap()));
        assert_eq!(others.len(), uv.installs.len() - 1);
    }

    /// Python en Windows no se instala con una línea: se baja del sitio. La fila tiene que
    /// poder quedarse sin comando en vez de inventar uno.
    #[test]
    fn un_requisito_puede_no_tener_comando_en_un_sistema() {
        let python = &REQUIREMENTS[0];
        assert_eq!(for_os(python, "windows").0, None);
        assert!(!python.docs_url.is_empty());
        assert_eq!(for_os(python, "linux").0.as_deref(), Some("sudo apt install python3.12 python3-pip"));
    }

    #[test]
    fn la_version_es_la_primera_linea_con_texto() {
        assert_eq!(first_line("\nPython 3.14.7\n").as_deref(), Some("Python 3.14.7"));
        assert_eq!(first_line("uv 0.5.11 (abc 2026-01-01)").as_deref(), Some("uv 0.5.11 (abc 2026-01-01)"));
        assert_eq!(first_line("   \n  "), None);
    }
}
