//! Ejecutar un programa externo sin quedar colgado si no termina.
//!
//! `Command::output()` espera para siempre. Eso es aceptable en un script, no acá: varios
//! de estos comandos (`opencode session list`, `npx skills …`) corren en caminos donde un
//! cuelgue no se nota como cuelgue — se nota como "la app dejó de responder", porque el
//! llamador puede estar sosteniendo el mutex de la base mientras espera.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Cada cuánto se pregunta si el proceso ya terminó. Lo bastante seguido para no agregar
/// latencia perceptible, lo bastante espaciado para no gastar CPU esperando.
const POLL: Duration = Duration::from_millis(25);

/// Como `Command::output()`, pero mata el proceso si pasa de `limit`.
///
/// En ese caso devuelve un error `TimedOut` en vez de una salida vacía: "tardó demasiado"
/// y "no encontró nada" son cosas distintas, y confundirlas haría que un binario colgado
/// se vea como una sesión inexistente.
pub fn output_with_timeout(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).spawn()?;

    // Los pipes se drenan en threads propios: si el proceso llena el buffer del pipe y
    // nadie lee, se bloquea escribiendo y nunca termina — un timeout que espera a que
    // termine no serviría de nada.
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("el comando no terminó en {}s", limit.as_secs_f32()),
                ));
            }
            None => std::thread::sleep(POLL),
        }
    };

    Ok(Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}
