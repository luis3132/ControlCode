//! Tests de cuentas: nombres de carpeta y lectura de la identidad desde el disco.

use std::path::Path;

use super::profiles::{read_identity, spec_for, ProfileSpec};
use super::store::validate_name;

/// Un directorio propio por test, que se borra solo.
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("cc-accounts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn write(&self, rel: &str, body: &str) {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spec(agent: &str) -> &'static ProfileSpec {
    spec_for(agent).unwrap()
}

/// El nombre ES el nombre de la carpeta: tiene que rechazar todo lo que escaparía del
/// almacén, lo que Windows no deja crear, y lo que no da una carpeta usable.
#[test]
fn rechaza_los_nombres_que_no_pueden_ser_una_carpeta() {
    for malo in ["..", "../otra", "con/con", ".oculta", "NUL", "com1", "   "] {
        assert!(validate_name(malo).is_err(), "debería rechazar {malo:?}");
    }
    assert!(validate_name(&"a".repeat(41)).is_err(), "demasiado largo");
}

#[test]
fn acepta_los_nombres_corrientes() {
    for bueno in ["trabajo", "cuenta-2", "luis_personal", "v1.0"] {
        assert!(validate_name(bueno).is_ok(), "debería aceptar {bueno:?}");
    }
}

/// El caso real, verificado: `.claude.json` se crea en el primer arranque, mucho antes de
/// que haya login. Contar eso —o un JSON roto, o una carpeta vacía— como cuenta activa
/// mostraría cuentas fantasma.
#[test]
fn sin_login_de_verdad_la_cuenta_no_figura_como_activa() {
    let dir = TempDir::new();
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "carpeta vacía");

    dir.write(".claude.json", r#"{"autoUpdates":true}"#);
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "archivo sin login");

    dir.write(".claude.json", "{no es json");
    assert_eq!(read_identity(dir.path(), spec("claude-code")), (false, None), "JSON roto");
}

#[test]
fn el_perfil_de_claude_reporta_el_mail_de_la_cuenta() {
    let dir = TempDir::new();
    dir.write(".claude.json", r#"{"oauthAccount":{"emailAddress":"vos@ejemplo.com"}}"#);
    assert_eq!(
        read_identity(dir.path(), spec("claude-code")),
        (true, Some("vos@ejemplo.com".to_string()))
    );
}

/// Sin campo conocido solo se puede decir SI hay login: un `{}` es el archivo que deja la
/// TUI al arrancar sin loguearse, así que no cuenta.
#[test]
fn el_perfil_de_opencode_distingue_un_auth_vacio_de_uno_con_credenciales() {
    let dir = TempDir::new();
    dir.write("opencode/auth.json", "{}");
    assert_eq!(read_identity(dir.path(), spec("opencode")), (false, None));

    dir.write("opencode/auth.json", r#"{"anthropic":{"type":"oauth"}}"#);
    assert_eq!(read_identity(dir.path(), spec("opencode")), (true, None));
}
