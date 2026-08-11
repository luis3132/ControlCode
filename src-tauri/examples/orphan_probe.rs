//! Diagnóstico: ¿sobreviven los nietos cuando se cierra una tab?
//!
//! Reproduce la cadena real —ControlCode lanza el agente, el agente lanza un servidor de
//! desarrollo— y después mata exactamente como lo hace `pty_kill` (pty_manager.rs:252),
//! para ver si el nieto queda huérfano.
//!
//!   cargo run --example orphan_probe              # cómo mataba ANTES: solo al hijo directo
//!   cargo run --example orphan_probe -- killpg    # SIGHUP a todo el grupo (unix; se midió
//!                                                 # insuficiente, queda como evidencia)
//!   cargo run --example orphan_probe -- contained # el arreglo real: `ProcessGroup`
//!
//! El módulo de contención se incluye por `#[path]` en vez de por `controlcode_lib` a
//! propósito: así este probe no enlaza la lib. En Windows el binario de tests de la lib no
//! llega ni a cargar (STATUS_ENTRYPOINT_NOT_FOUND, por algo ajeno a esto), y sin este
//! rodeo no habría forma de verificar el arreglo en esa plataforma.
#[path = "../src/terminal/containment.rs"]
mod containment;

use containment::ProcessGroup;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::time::{Duration, Instant};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "kill".into());

    let pty = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    // El hijo directo del PTY hace de agente: lanza algo en segundo plano (el "npm run
    // dev") y se queda vivo. Se usa `sh` no interactivo a propósito: un shell interactivo
    // hace job control y podría matar sus jobs al morir, que es justo lo que un agente
    // real NO hace.
    //
    // `ORPHAN_PROBE_NIETO` cambia CÓMO se lanza ese proceso en segundo plano, porque de eso
    // depende si la red de seguridad de POSIX lo alcanza o no:
    //   plain  (default) mismo grupo de procesos que el agente
    //   nohup            ignora SIGHUP (servidores que se blindan contra el cierre del tty)
    //   setsid           sesión propia: fuera del alcance del hangup del terminal
    let mut cmd = agente_cmd();
    cmd.env("TERM", "xterm-256color");

    // En modo `contained` se replica el orden de `pty_create`: el grupo existe antes del
    // spawn y adopta al proceso apenas nace.
    let mut group = (mode == "contained").then(|| ProcessGroup::new(0));

    let mut child = pty.slave.spawn_command(cmd).expect("spawn");
    let agente = child.process_id().expect("pid del hijo directo");
    if let Some(g) = &mut group {
        g.adopt(&*child);
    }
    println!("agente (hijo directo del PTY) = {agente}");

    // Leer hasta que el "agente" reporte el pid del nieto.
    let mut reader = pty.master.try_clone_reader().expect("reader");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut acc = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some(pid) = parse_nieto(&acc) {
                        let _ = tx.send(pid);
                        break;
                    }
                }
            }
        }
    });

    let nieto = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("el proceso nunca reportó el pid del nieto");
    println!("nieto (lo que lanzó el agente) = {nieto}");
    println!("ambos vivos antes de matar: agente={} nieto={}", vivo(agente), vivo(nieto));

    // ── Lo que hace pty_kill hoy ────────────────────────────────────────────────────
    println!("\nmodo: {mode}");
    match mode.as_str() {
        // Mismo orden que `pty_kill`: primero el grupo (el respaldo por ppid necesita al
        // padre vivo), después el hijo directo.
        "contained" => {
            group.as_mut().expect("grupo").kill_all();
            let _ = child.kill();
        }
        "killpg" => matar_grupo(agente),
        _ => {
            // portable-pty manda SIGHUP SOLO a este pid (lib.rs:315).
            child.kill().expect("kill");
        }
    }
    let _ = child.wait();

    // `pty_kill` saca la sesión del registry, así que el master se dropea y el pty se
    // cierra. Se replica para no medir de menos: el cierre del pty puede llevarse gente
    // por rebote.
    drop(pty);

    esperar(Duration::from_millis(500));

    println!("\n--- después de cerrar la tab ---");
    println!("agente {agente}: {}", estado(agente));
    println!("nieto  {nieto}: {}", estado(nieto));

    if vivo(nieto) {
        println!("\n>>> FUGA CONFIRMADA: el nieto quedó huérfano corriendo.");
        limpiar(nieto);
    } else {
        println!("\n>>> sin fuga: el nieto murió junto con la tab.");
    }
}

/// El hijo directo del PTY hace de agente: lanza algo en segundo plano (el "npm run dev")
/// y se queda vivo. Se usa un shell NO interactivo a propósito: uno interactivo hace job
/// control y podría matar sus jobs al morir, que es justo lo que un agente real no hace.
///
/// `ORPHAN_PROBE_NIETO` cambia CÓMO se lanza ese proceso en segundo plano, porque de eso
/// depende si la red de seguridad de POSIX lo alcanza o no:
///   plain  (default) mismo grupo de procesos que el agente
///   nohup            ignora SIGHUP (servidores blindados contra el cierre del tty)
///   setsid           sesión propia: fuera del alcance del hangup del terminal
#[cfg(unix)]
fn agente_cmd() -> CommandBuilder {
    let nieto = match std::env::var("ORPHAN_PROBE_NIETO").unwrap_or_default().as_str() {
        "nohup" => "nohup sleep 600 >/dev/null 2>&1 & echo NIETO=$!; sleep 900",
        "setsid" => "setsid sleep 600 & sleep 0.3; pgrep -n -x sleep | sed 's/^/NIETO=/'; sleep 900",
        _ => "sleep 600 & echo NIETO=$!; sleep 900",
    };
    let mut cmd = CommandBuilder::new("sh");
    cmd.arg("-c");
    cmd.arg(nieto);
    cmd
}

/// Windows no tiene `sh`, así que el "agente" es PowerShell. `-PassThru` devuelve el
/// objeto del proceso lanzado, que es de donde sale el pid del nieto.
///
/// No hay variantes acá: Windows no tiene `setsid` ni `SIGHUP`. Un hijo normal ya es
/// suficiente para medir lo que importa — si `TerminateProcess` sobre el hijo directo
/// (lib.rs:295) deja vivo al nieto.
#[cfg(windows)]
fn agente_cmd() -> CommandBuilder {
    let mut cmd = CommandBuilder::new("powershell");
    cmd.arg("-NoProfile");
    cmd.arg("-Command");
    cmd.arg(
        "$p = Start-Process -PassThru -WindowStyle Hidden ping \
         -ArgumentList '-n','600','127.0.0.1'; \
         Write-Output \"NIETO=$($p.Id)\"; Start-Sleep 900",
    );
    cmd
}

fn parse_nieto(acc: &str) -> Option<u32> {
    let idx = acc.find("NIETO=")?;
    let resto = &acc[idx + "NIETO=".len()..];
    let fin = resto.find(|c: char| !c.is_ascii_digit())?;
    resto[..fin].parse().ok()
}

fn esperar(d: Duration) {
    let hasta = Instant::now() + d;
    while Instant::now() < hasta {
        std::thread::yield_now();
    }
}

fn estado(pid: u32) -> &'static str {
    if vivo(pid) {
        "VIVO"
    } else {
        "muerto"
    }
}

#[cfg(unix)]
fn vivo(pid: u32) -> bool {
    // signal 0 no manda nada: solo consulta si el proceso existe y es señalable.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
fn matar_grupo(pid: u32) {
    // El hijo del PTY es líder de sesión (portable-pty llama setsid, unix.rs:220), así que
    // su pid es también el id de su grupo de procesos.
    unsafe {
        libc::killpg(pid as i32, libc::SIGHUP);
    }
}

#[cfg(unix)]
fn limpiar(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn vivo(pid: u32) -> bool {
    // Se consulta con tasklist para no depender de winapi en un ejemplo de diagnóstico.
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(windows)]
fn matar_grupo(pid: u32) {
    println!("(en Windows no hay grupos de procesos POSIX; el equivalente es un Job Object)");
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
}

#[cfg(windows)]
fn limpiar(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();
}
