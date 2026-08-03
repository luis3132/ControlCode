//! Diagnóstico: lanza un comando en un PTY exactamente como lo hace `pty_create` y
//! reporta qué escribe y cuándo.
//!
//! Sirve para separar dos cosas que desde la UI se ven igual ("terminal negra"): que el
//! proceso no arranque / no escriba nada, o que escriba y sea el render el que falla.
//!
//!   cargo run --example pty_probe -- opencode /ruta/al/proyecto 8
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::time::{Duration, Instant};

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "bash".into());
    let cwd = args.next().unwrap_or_else(|| ".".into());
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(8);

    let pty = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    // Mismo armado que pty_create.
    let mut cmd = CommandBuilder::new(&command);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = match pty.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            println!("SPAWN FALLÓ: {e}");
            println!("PATH visto por este proceso: {:?}", std::env::var("PATH"));
            return;
        }
    };
    println!("spawn OK (pid {:?})", child.process_id());

    let mut reader = pty.master.try_clone_reader().expect("reader");
    let answers: Vec<String> = std::env::var("PTY_PROBE_ANSWER")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let writer = std::sync::Arc::new(std::sync::Mutex::new(
        pty.master.take_writer().expect("writer"),
    ));
    let writer_replies = writer.clone();

    let start = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let reply = build_reply(&buf[..n], &answers);
                    if !reply.is_empty() {
                        use std::io::Write;
                        if let Ok(mut w) = writer_replies.lock() {
                            let _ = w.write_all(reply.as_bytes());
                            let _ = w.flush();
                        }
                    }
                    if tx.send((start.elapsed(), buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Reproduce lo que hace `submit_prompt`: texto y Enter en escrituras separadas, o
    // pegados si PTY_PROBE_GLUED=1 (la forma vieja, para comparar).
    if let Ok(text) = std::env::var("PTY_PROBE_SEND") {
        let glued = std::env::var("PTY_PROBE_GLUED").is_ok();
        let w2 = writer.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            std::thread::sleep(Duration::from_secs(6)); // que la TUI termine de arrancar
            let write = |bytes: &[u8]| {
                if let Ok(mut w) = w2.lock() {
                    let _ = w.write_all(bytes);
                    let _ = w.flush();
                }
            };
            if glued {
                write(format!("{text}\r").as_bytes());
            } else {
                write(text.as_bytes());
                std::thread::sleep(Duration::from_millis(600));
                write(b"\r");
            }
        });
    }

    let deadline = Duration::from_secs(secs);
    let mut total = 0usize;
    let mut chunks = 0usize;
    let mut first: Option<Duration> = None;
    let mut last_at = Duration::ZERO;
    let mut sample = Vec::new();
    let mut all: Vec<u8> = Vec::new();

    while start.elapsed() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok((at, chunk)) => {
                if first.is_none() {
                    first = Some(at);
                }
                last_at = at;
                total += chunk.len();
                all.extend_from_slice(&chunk);
                chunks += 1;
                if sample.len() < 400 {
                    sample.extend_from_slice(&chunk);
                }
            }
            Err(_) => continue,
        }
    }

    println!("--- {secs}s después ---");
    println!("bytes: {total} en {chunks} chunk(s)");
    match first {
        Some(t) => println!("primer byte a los {:.2}s · último a los {:.2}s", t.as_secs_f32(), last_at.as_secs_f32()),
        None => println!("NUNCA ESCRIBIÓ NADA"),
    }
    println!("¿sigue vivo?: {:?}", child.try_wait().map(|s| s.is_none()));
    println!("primeros bytes: {:?}", String::from_utf8_lossy(&sample[..sample.len().min(400)]));

    if let Ok(path) = std::env::var("PTY_PROBE_DUMP") {
        std::fs::write(&path, &all).expect("dump");
        println!("crudo completo en {path}");
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// Arma la respuesta a las consultas de capacidades presentes en `chunk`.
/// `answers` selecciona cuáles se contestan, para poder bisecar cuál es la que bloquea.
fn build_reply(chunk: &[u8], answers: &[String]) -> String {
    let text = String::from_utf8_lossy(chunk);
    let on = |name: &str| answers.iter().any(|a| a == name || a == "all");
    let mut out = String::new();

    if on("cpr") && text.contains("\x1b[6n") {
        for _ in 0..text.matches("\x1b[6n").count() {
            out.push_str("\x1b[1;1R");
        }
    }
    if on("osc11") && text.contains("\x1b]11;?") {
        out.push_str("\x1b]11;rgb:0d0d/1111/1717\x1b\\");
    }
    if on("osc10") && text.contains("\x1b]10;?") {
        out.push_str("\x1b]10;rgb:e6e6/eded/f3f3\x1b\\");
    }
    if on("osc4") && text.contains("\x1b]4;0;?") {
        out.push_str("\x1b]4;0;rgb:0000/0000/0000\x1b\\");
    }
    if on("xtgettcap") && text.contains("\x1bP+q") {
        out.push_str("\x1bP0+q\x1b\\");
    }
    if on("decrqm") {
        for mode in ["1016", "2027", "2031", "1004", "2004", "2026"] {
            if text.contains(&format!("\x1b[?{mode}$p")) {
                out.push_str(&format!("\x1b[?{mode};0$y"));
            }
        }
    }
    if on("xtversion") && text.contains("\x1b[>0q") {
        out.push_str("\x1bP>|xterm.js\x1b\\");
    }
    if on("kitty") && text.contains("\x1b[?u") {
        out.push_str("\x1b[?0u");
    }
    if on("winsize") && text.contains("\x1b[14t") {
        out.push_str("\x1b[4;600;800t");
    }
    out
}
