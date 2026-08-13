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
