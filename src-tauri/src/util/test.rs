//! Tests de las utilidades.

use std::process::Command;
use std::time::{Duration, Instant};

use super::output_with_timeout;

/// Un comando que termina normal se comporta como `Command::output()`.
#[test]
#[cfg(unix)]
fn un_comando_normal_devuelve_su_salida() {
    let out = output_with_timeout(
        Command::new("sh").arg("-c").arg("echo hola"),
        Duration::from_secs(5),
    )
    .expect("debería terminar sola");
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hola");
    assert!(out.status.success());
}

/// Lo que motivó el módulo: un binario que no termina no puede dejar esperando para
/// siempre a quien lo llamó (que puede estar sosteniendo el mutex de la base).
#[test]
#[cfg(unix)]
fn un_comando_colgado_se_mata_al_vencer_el_plazo() {
    let empezo = Instant::now();
    let err = output_with_timeout(
        Command::new("sh").arg("-c").arg("sleep 30"),
        Duration::from_millis(200),
    )
    .expect_err("tendría que vencer");

    assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
    assert!(empezo.elapsed() < Duration::from_secs(5), "no esperó al proceso: {:?}", empezo.elapsed());
}

/// El proceso puede llenar el buffer del pipe y quedarse bloqueado escribiendo. Si nadie
/// drena, "esperar a que termine" no termina nunca — ni con timeout se recuperaría la
/// salida.
#[test]
#[cfg(unix)]
fn una_salida_mas_grande_que_el_buffer_del_pipe_no_bloquea() {
    let out = output_with_timeout(
        Command::new("sh").arg("-c").arg("yes x | head -c 200000"),
        Duration::from_secs(10),
    )
    .expect("debería terminar sola");
    assert_eq!(out.stdout.len(), 200_000);
}

// ── `path_env`: el PATH con el que se buscan y se lanzan las TUIs ─────────────────

use super::path_env::{between_markers, find_in, known_dirs, merge};
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-path-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(unix)]
fn executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "#!/bin/sh\necho 1.0.0\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// El del shell manda (es el orden que eligió la persona), lo heredado completa y las
/// carpetas conocidas van al final: solo deciden si nada más encontró el programa.
#[test]
fn el_path_final_respeta_el_orden_del_shell_y_no_repite() {
    let merged = merge(
        Some("/home/u/.opencode/bin:/usr/bin"),
        std::ffi::OsStr::new("/usr/bin:/bin"),
        &[PathBuf::from("/home/u/.local/bin"), PathBuf::from("/usr/bin")],
    );
    assert_eq!(
        merged,
        ["/home/u/.opencode/bin", "/usr/bin", "/bin", "/home/u/.local/bin"].map(PathBuf::from)
    );
}

/// Una entrada vacía en un PATH significa "la carpeta actual": abrir una tab en un repo
/// ejecutaría un `opencode` suelto en su raíz en vez del instalado. No se deja pasar.
#[test]
fn una_entrada_vacia_no_llega_al_path() {
    let merged = merge(Some("/usr/bin::/bin:"), std::ffi::OsStr::new(":/opt/x"), &[]);
    assert!(merged.iter().all(|d| !d.as_os_str().is_empty()), "{merged:?}");
    assert_eq!(merged.len(), 3);
}

/// Si el shell no contestó, se sigue con lo heredado: la app abre igual.
#[test]
fn sin_shell_queda_lo_heredado_mas_lo_conocido() {
    let merged = merge(None, std::ffi::OsStr::new("/usr/bin"), &[PathBuf::from("/home/u/.opencode/bin")]);
    assert_eq!(merged, ["/usr/bin", "/home/u/.opencode/bin"].map(PathBuf::from));
}

/// Un shell interactivo imprime por su cuenta (saludos, avisos de job control). Lo que
/// vale es solo lo que quedó entre las marcas.
#[test]
fn el_path_se_saca_de_entre_las_marcas_aunque_el_perfil_imprima_de_mas() {
    let out = "Welcome to Ubuntu!\nbash: no job control in this shell\n__M__\n/a:/b\n__M__\nlogout\n";
    assert_eq!(between_markers(out, "__M__").as_deref(), Some("/a:/b"));
    assert_eq!(between_markers("__M__\n\n__M__", "__M__"), None);
    assert_eq!(between_markers("sin marcas", "__M__"), None);
}

/// Las carpetas del home se suman AUNQUE no existan: una TUI instalada con la app abierta
/// crea la suya en ese momento, y "volver a buscar" tiene que encontrarla sin reiniciar.
#[cfg(unix)]
#[test]
fn las_carpetas_de_instalacion_del_home_se_suman_aunque_no_existan_todavia() {
    let home = temp_dir("known");
    let dirs = known_dirs(&home);
    assert!(dirs.contains(&home.join(".opencode/bin")));
    assert!(dirs.contains(&home.join(".local/bin")));
    assert!(!home.join(".opencode/bin").exists());
    std::fs::remove_dir_all(&home).ok();
}

/// nvm: si el shell no contestó, la versión más nueva primero — la que tiene más chances
/// de tener instalada la TUI.
#[cfg(unix)]
#[test]
fn con_nvm_va_primero_la_version_mas_nueva() {
    let home = temp_dir("nvm");
    for v in ["v18.20.1", "v24.14.0", "v20.9.0"] {
        std::fs::create_dir_all(home.join(".nvm/versions/node").join(v).join("bin")).unwrap();
    }
    let dirs = known_dirs(&home);
    let nvm: Vec<_> = dirs.iter().filter(|d| d.to_string_lossy().contains(".nvm")).collect();
    assert!(nvm[0].ends_with("v24.14.0/bin"), "{nvm:?}");
    assert!(nvm[2].ends_with("v18.20.1/bin"), "{nvm:?}");
    std::fs::remove_dir_all(&home).ok();
}

/// Se busca en el disco y no con `which`, que en Arch base no existe. Y solo cuenta un
/// archivo ejecutable: una carpeta o un archivo sin permiso con ese nombre no es la TUI.
#[cfg(unix)]
#[test]
fn un_programa_se_encuentra_en_el_path_sin_which() {
    let root = temp_dir("find");
    let first = root.join("a");
    let second = root.join("b");
    executable(&second.join("opencode"));
    std::fs::create_dir_all(first.join("opencode")).unwrap(); // una carpeta, no el programa
    let path = std::env::join_paths([&first, &second]).unwrap();

    assert_eq!(find_in("opencode", Some(path.clone()), &[]), Some(second.join("opencode")));
    assert_eq!(find_in("claude", Some(path.clone()), &[]), None);

    // Sin permiso de ejecución no cuenta.
    std::fs::write(first.join("kimi"), "x").unwrap();
    assert_eq!(find_in("kimi", Some(path), &[]), None);
    std::fs::remove_dir_all(&root).ok();
}

/// En Windows npm deja `opencode.cmd`, no `opencode.exe`. Buscar con las extensiones de
/// `PATHEXT` es lo que permite lanzarlo: el `Command` de Rust solo completa `.exe`.
#[cfg(unix)]
#[test]
fn con_extensiones_se_encuentra_el_cmd_que_deja_npm() {
    let root = temp_dir("pathext");
    executable(&root.join("opencode.cmd"));
    let path = std::env::join_paths([&root]).unwrap();
    let exts = [".COM", ".EXE", ".BAT", ".CMD"].map(String::from);

    assert_eq!(find_in("opencode", Some(path.clone()), &exts), Some(root.join("opencode.cmd")));
    // Con la extensión ya puesta no se le agrega otra.
    assert_eq!(find_in("opencode.cmd", Some(path), &exts), Some(root.join("opencode.cmd")));
    std::fs::remove_dir_all(&root).ok();
}

/// El caso que había en Ubuntu, armado con los archivos que trae Ubuntu: su `~/.profile`
/// carga `~/.bashrc`, y su `~/.bashrc` se corta en la línea 6 si el shell no es
/// interactivo. El instalador de OpenCode deja su carpeta AL FINAL de ese `~/.bashrc`.
///
/// Un shell de login a secas no llega a esa línea; el interactivo sí. Si alguien cambia
/// los flags de la consulta, esto lo agarra.
#[cfg(unix)]
#[test]
fn en_ubuntu_se_encuentra_lo_que_el_instalador_dejo_al_final_del_bashrc() {
    if std::path::Path::new("/bin/bash").exists() {
        let home = temp_dir("ubuntu");
        std::fs::write(
            home.join(".profile"),
            "if [ -n \"$BASH_VERSION\" ]; then\n    if [ -f \"$HOME/.bashrc\" ]; then\n\t. \"$HOME/.bashrc\"\n    fi\nfi\n",
        )
        .unwrap();
        std::fs::write(
            home.join(".bashrc"),
            format!(
                "# ~/.bashrc\n\n# If not running interactively, don't do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n# opencode\nexport PATH={}/.opencode/bin:$PATH\n",
                home.display()
            ),
        )
        .unwrap();

        let home_os = home.as_os_str();
        let found = super::path_env::shell_path("/bin/bash", &[("HOME", home_os)]).expect("el shell contestó");
        assert!(
            found.contains(&format!("{}/.opencode/bin", home.display())),
            "el shell interactivo tendría que haber leído el final del .bashrc: {found}"
        );

        // Y el contraste: de login sin interactivo, como hacía todo antes, no llega.
        // Con un PATH de escritorio pelado, que es con lo que arranca la app desde el dock.
        let login_only = std::process::Command::new("/bin/bash")
            .args(["-l", "-c", "printenv PATH"])
            .env("HOME", home_os)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .output()
            .unwrap();
        let mine = format!("{}/.opencode/bin", home.display());
        assert!(!String::from_utf8_lossy(&login_only.stdout).contains(&mine));
        std::fs::remove_dir_all(&home).ok();
    }
}

/// Un perfil que no termina (un `exec tmux`, un `read`) no puede dejar la app sin abrir:
/// se corta al tope, con un error que dice qué pasó y cómo evitarlo.
#[cfg(unix)]
#[test]
fn un_perfil_que_se_cuelga_no_deja_colgada_la_app() {
    if std::path::Path::new("/bin/bash").exists() {
        let home = temp_dir("colgado");
        std::fs::write(home.join(".bash_profile"), "sleep 30\n").unwrap();
        let start = std::time::Instant::now();
        let result = super::path_env::shell_path("/bin/bash", &[("HOME", home.as_os_str())]);
        assert!(start.elapsed() < std::time::Duration::from_secs(8), "tardó {:?}", start.elapsed());
        let err = result.unwrap_err();
        assert!(err.contains(super::path_env::RESOLVING_ENV), "{err}");
        std::fs::remove_dir_all(&home).ok();
    }
}
