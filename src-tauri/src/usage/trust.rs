//! Dónde se abre el sondeo del cupo, y por qué esa carpeta no pregunta nada.
//!
//! Claude Code pregunta "¿confiás en esta carpeta?" la primera vez que se abre en una.
//! Dentro de una PTY que nadie está mirando, ese diálogo es el sondeo colgado hasta que
//! vence el tiempo.
//!
//! Antes se esquivaba buscando entre las carpetas que la cuenta YA había aceptado y
//! abriendo el sondeo en una de ellas. Eso dependía de que hubiera alguna —una cuenta
//! recién creada no confía en ninguna— y encima leía la lista del lugar equivocado para la
//! cuenta principal (ver [`config_file`]), así que el panel se quedaba en "todavía no
//! confía en ninguna carpeta" sin nada que el usuario pudiera hacer al respecto.
//!
//! Ahora el sondeo tiene carpeta propia —una, vacía, de la app— y se la pre-aprueba en el
//! `.claude.json` de la cuenta antes de abrir. Es exactamente lo que habría quedado
//! escrito si el usuario aceptara el diálogo, sobre una carpeta que no tiene nada adentro:
//! no se le están dando permisos sobre ningún proyecto suyo. De paso el sondeo arranca más
//! rápido y más parejo, porque en una carpeta vacía no hay CLAUDE.md que leer ni MCP que
//! levantar.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// La carpeta donde se abre el sondeo: vacía, de la app, la misma para todas las cuentas.
///
/// Vive junto al resto de lo que la app guarda (`~/.controlcode`) y no en un temporal
/// porque tiene que ser ESTABLE: la ruta queda escrita como aceptada en la config de cada
/// cuenta, y una carpeta distinta en cada arranque iría dejando entradas muertas ahí.
pub(super) fn probe_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("No se pudo resolver la carpeta del usuario")?;
    let dir = home.join(".controlcode").join("usage-probe");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;

    // Resuelta a la ruta física: la TUI apunta sus proyectos por el `cwd` que le informa el
    // sistema, que ya viene sin symlinks. Si el home del usuario pasa por uno, la ruta que
    // dejamos aceptada y la que la TUI va a buscar serían dos strings distintos y el
    // diálogo volvería a aparecer.
    #[cfg(unix)]
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);

    Ok(dir)
}

/// El `.claude.json` de una cuenta.
///
/// No está donde la simetría haría pensar: con `CLAUDE_CONFIG_DIR` apuntado a un perfil el
/// archivo vive ADENTRO de ese directorio, pero la cuenta principal lo tiene en el home
/// (`~/.claude.json`), al lado de `~/.claude/` y no adentro. Buscarlo en
/// `~/.claude/.claude.json` era leer un archivo que no existe: por eso la cuenta principal
/// figuraba como que no confiaba en ninguna carpeta teniendo decenas aceptadas.
pub(super) fn config_file(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir {
        Some(dir) => Some(Path::new(dir).join(".claude.json")),
        None => dirs::home_dir().map(|home| home.join(".claude.json")),
    }
}

/// La config con `dir` marcada como aceptada, o `None` si ya lo estaba.
///
/// Devolver `None` no es un detalle: es lo que hace que la app escriba el archivo una sola
/// vez por cuenta en vez de en cada sondeo. Esa config la escribe también la propia TUI
/// mientras corre, y cada escritura nuestra es una chance de pisarle algo.
pub(super) fn with_trusted(config: &Value, dir: &str) -> Option<Value> {
    let accepted = config
        .get("projects")
        .and_then(|p| p.get(dir))
        .and_then(|entry| entry.get("hasTrustDialogAccepted"))
        .and_then(Value::as_bool);
    if accepted == Some(true) {
        return None;
    }

    let mut next = if config.is_object() { config.clone() } else { json!({}) };
    {
        let root = next.as_object_mut()?;
        let projects = root.entry("projects").or_insert_with(|| json!({}));
        if !projects.is_object() {
            *projects = json!({});
        }
        let entry = projects
            .as_object_mut()?
            .entry(dir.to_string())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        let entry = entry.as_object_mut()?;
        entry.insert("hasTrustDialogAccepted".into(), json!(true));
        // El paseo de bienvenida de una carpeta nueva es otro diálogo que nadie puede
        // contestar desde la PTY del sondeo.
        entry.insert("projectOnboardingSeenCount".into(), json!(1));
    }
    Some(next)
}

/// Deja `dir` pre-aprobada para esa cuenta. No hace nada si ya lo estaba.
pub(super) fn trust_dir(config_path: &Path, dir: &str) -> Result<(), String> {
    // Que el archivo no exista es el caso normal de una cuenta recién creada.
    let raw = std::fs::read_to_string(config_path).unwrap_or_else(|_| "{}".to_string());
    // Si existe y no se puede parsear, no se toca: es la configuración del usuario, con su
    // login adentro, y reemplazarla por un objeto nuevo sería borrársela por un sondeo.
    let config: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("No se pudo leer {}: {e}", config_path.display()))?;

    let Some(next) = with_trusted(&config, dir) else {
        return Ok(());
    };

    let body = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    write_atomic(config_path, &body)
}

/// Escribe reemplazando el archivo entero de una sola vez.
///
/// Primero a un temporal al lado y después un `rename`: si la app se cae a mitad de la
/// escritura, el original queda intacto en vez de truncado. Y el temporal hereda los
/// permisos del original —`~/.claude.json` es 0600 y guarda credenciales—, porque un
/// archivo nuevo saldría con los permisos por defecto y el `rename` dejaría el login de la
/// cuenta legible para todo el sistema.
fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("controlcode-{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("No se pudo escribir {}: {e}", tmp.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("No se pudieron ajustar los permisos de {}: {e}", tmp.display()));
        }
    }

    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("No se pudo actualizar {}: {e}", path.display())
    })
}
