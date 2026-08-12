//! Tests de la terminal: cómo se arma el lanzamiento y cómo se contiene el árbol de
//! procesos de una tab.

use super::pty_manager::{build_launch, launch_script};

// ── Lanzamiento del agente ──────────────────────────────────────


#[test]
fn un_solo_paso_precede_al_agente() {
    let script = launch_script("claude", &["conda activate ml".into()]);
    assert!(script.starts_with("conda activate ml && "), "{script}");
    assert!(script.ends_with("claude"), "{script}");
}

#[test]
fn los_pasos_conservan_el_orden() {
    // El orden es semántico: `nvm use` tiene que correr antes de nada que dependa de
    // npm, y el venv antes de un export que use una ruta suya.
    let script = launch_script(
        "codex",
        &["nvm use 18".into(), "source .venv/bin/activate".into()],
    );
    let nvm = script.find("nvm use 18").unwrap();
    let venv = script.find("source .venv").unwrap();
    let agente = script.find("codex").unwrap();
    assert!(nvm < venv && venv < agente, "{script}");
}

#[test]
fn los_pasos_se_encadenan_con_and_para_que_un_fallo_no_lance_el_agente() {
    let script = launch_script("claude", &["a".into(), "b".into()]);
    assert_eq!(script.matches("&&").count(), 2, "{script}");
    assert!(!script.contains(';'), "un `;` dejaría arrancar el agente igual: {script}");
}

#[cfg(unix)]
#[test]
fn en_unix_el_agente_reemplaza_al_shell() {
    // Sin `exec` el shell quedaría de padre y `pty_kill` apuntaría a él en vez de al
    // agente.
    assert!(launch_script("claude", &["x".into()]).contains("&& exec claude"));
}

#[test]
fn el_comando_de_reanudacion_llega_entero() {
    // El `--resume <id>` lo arma el frontend antes de llegar acá; el envoltorio no
    // puede partirlo.
    let script = launch_script("claude --resume abc-123", &["nvm use".into()]);
    assert!(script.ends_with("claude --resume abc-123"), "{script}");
}

/// Sin pre-comandos el spawn tiene que quedar IDÉNTICO al de siempre: nada de shells
/// de por medio. Es la garantía de que esta feature no puede romper a quien no la usa.
#[test]
fn sin_pasos_se_lanza_el_binario_directo_sin_shell() {
    let cmd = build_launch("claude --resume abc", &[]);
    let argv: Vec<String> =
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(argv, vec!["claude", "--resume", "abc"]);
}

/// Con pre-comandos, el comando entero viaja como UN argumento del shell. Eso también
/// hace que el `split_whitespace` de arriba no llegue a partirlo.
#[test]
fn con_pasos_el_comando_viaja_entero_como_argumento_del_shell() {
    let cmd = build_launch("claude --resume abc", &["nvm use".into()]);
    let argv: Vec<String> =
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let script = argv.last().expect("el script va último");
    assert!(script.contains("nvm use"), "{script}");
    assert!(script.ends_with("claude --resume abc"), "{script}");
    assert!(argv.len() >= 2, "tendría que haber flags de shell antes del script: {argv:?}");
}

// ── Recorrido del árbol de procesos (unix) ──────────────────────

#[cfg(unix)]
mod arbol {
    use crate::terminal::containment::unix_tree::descendants;


    #[test]
    fn recorre_el_arbol_completo_y_no_toca_ramas_ajenas() {
        // 100 ─ 200 ─ 300
        //     └ 201
        // 900 ─ 901   (rama ajena)
        let procs = [(200, 100), (300, 200), (201, 100), (901, 900), (100, 1)];
        let mut got = descendants(100, &procs);
        got.sort();
        assert_eq!(got, vec![200, 201, 300]);
    }

    #[test]
    fn los_hijos_salen_antes_que_los_nietos() {
        let procs = [(300, 200), (200, 100)];
        // El orden importa: `kill_tree` lo invierte para matar hojas primero.
        assert_eq!(descendants(100, &procs), vec![200, 300]);
    }

    #[test]
    fn un_ciclo_de_pids_no_cuelga_el_recorrido() {
        let procs = [(200, 100), (100, 200)];
        assert_eq!(descendants(100, &procs), vec![200]);
    }

    #[test]
    fn una_hoja_sin_hijos_no_devuelve_nada() {
        assert_eq!(descendants(100, &[(901, 900)]), Vec::<u32>::new());
    }
}

// ── Fin a fin: matar la tab se lleva su descendencia ────────────

/// Regresión del caso que motivó este módulo, reproducido punta a punta contra procesos
/// reales: un "agente" que lanza algo con `setsid`, o sea fuera de su grupo y de su sesión.
///
/// Es justo el que `examples/orphan_probe.rs` mide sobreviviendo tanto al `SIGHUP` que
/// manda `portable-pty` como a un `killpg`. Si este test se vuelve verde por accidente
/// —porque el nieto muriera por el colgado del terminal en vez de por el grupo— dejaría de
/// probar nada, así que el nieto se lanza con `setsid` precisamente para quedar fuera del
/// alcance de esa red de seguridad.
#[cfg(all(test, unix))]
mod tests_e2e {
    use crate::terminal::containment::ProcessGroup;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn vivo(pid: u32) -> bool {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn matar_una_tab_se_lleva_a_un_nieto_que_se_fue_a_su_propia_sesion() {
        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        // `setsid` deja al nieto en su propia sesión: ni el hangup del tty ni un killpg
        // sobre el grupo del agente lo alcanzan.
        cmd.arg("setsid sleep 30 & sleep 0.3; pgrep -n -x sleep; sleep 30");

        let mut group = ProcessGroup::new(9_999);
        let child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);

        // El agente imprime el pid del nieto por el pty.
        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(pid) = acc.split_whitespace().find_map(|w| w.parse::<u32>().ok()) {
                    let _ = tx.send(pid);
                    break;
                }
            }
        });
        let nieto = rx.recv_timeout(Duration::from_secs(10)).expect("pid del nieto");
        assert!(vivo(nieto), "el nieto tendría que estar vivo antes de matar el grupo");

        group.kill_all();
        drop(pty);

        // La muerte no es instantánea: se le da margen antes de declararla fuga.
        let limite = Instant::now() + Duration::from_secs(5);
        while vivo(nieto) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }

        let sobrevivio = vivo(nieto);
        if sobrevivio {
            unsafe { libc::kill(nieto as i32, libc::SIGKILL) };
        }
        assert!(!sobrevivio, "el nieto {nieto} quedó huérfano tras matar el grupo");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests_cgroup {
    use crate::terminal::containment::{imp, ProcessGroup};

    fn cgroup_de(pid: u32) -> String {
        std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
            .unwrap_or_default()
            .lines()
            .find_map(|l| l.strip_prefix("0::").map(str::to_string))
            .unwrap_or_default()
    }

    #[test]
    fn adoptar_mueve_al_proceso_a_un_cgroup_propio() {
        let antes = cgroup_de(std::process::id());
        let mut hijo = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn");
        let pid = hijo.id();

        let mut group = ProcessGroup::new(9_001);
        // Se adopta un `std::process::Child`, que implementa el mismo trait que el hijo
        // del PTY, así se ejercita `adopt` sin montar un pty entero.
        group.adopt(&hijo);

        let despues = cgroup_de(pid);
        // Si el entorno no permite cgroups (contenedor sin delegación, cgroup v1) el
        // módulo cae al recorrido por `ppid` y no hay nada que verificar acá.
        if imp::usa_cgroup(&group.imp) {
            assert_ne!(despues, antes, "el proceso tendría que haber cambiado de cgroup");
            assert!(
                despues.ends_with("/cc-tab-9001"),
                "quedó en {despues}, no en el cgroup de la tab"
            );
        }

        group.kill_all();
        let _ = hijo.kill();
        let _ = hijo.wait();
    }

    #[test]
    fn el_cgroup_de_la_tab_se_borra_al_matarla() {
        let mut group = ProcessGroup::new(9_002);
        let dir: Option<std::path::PathBuf> = imp::dir_de(&group.imp);
        if let Some(d) = &dir {
            assert!(d.exists(), "el cgroup tendría que existir tras crear el grupo");
        }
        group.kill_all();
        if let Some(d) = &dir {
            assert!(!d.exists(), "el cgroup quedó colgado tras matar la tab");
        }
    }
}

/// Regresión del caso que `examples/orphan_probe.rs` midió fugando en Windows: un hijo
/// **normal** del agente (ni siquiera hace falta que se desprenda de nada) sobrevive al
/// cierre de la tab, porque `TerminateProcess` no toca a los descendientes y allá no
/// existe la red del kernel que en unix tapa este caso.
#[cfg(all(test, windows))]
mod tests_e2e {
    use crate::terminal::containment::{imp, ProcessGroup};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn vivo(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    #[test]
    fn matar_una_tab_se_lleva_al_proceso_que_lanzo_el_agente() {
        let pty = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        // PowerShell hace de agente: lanza un proceso aparte y reporta su pid.
        let mut cmd = CommandBuilder::new("powershell");
        cmd.arg("-NoProfile");
        cmd.arg("-Command");
        cmd.arg(
            "$p = Start-Process -PassThru -WindowStyle Hidden ping \
             -ArgumentList '-n','60','127.0.0.1'; \
             Write-Output \"NIETO=$($p.Id)\"; Start-Sleep 60",
        );

        let mut group = ProcessGroup::new(9_003);
        let child = pty.slave.spawn_command(cmd).expect("spawn");
        group.adopt(&*child);
        assert!(imp::usa_job(&group.imp), "no se pudo crear el Job Object");

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut acc = String::new();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(rest) = acc.split("NIETO=").nth(1) {
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    // Se espera a ver un separador para no leer un pid cortado a la mitad
                    // por el chunk.
                    if digits.len() < rest.len() {
                        if let Ok(pid) = digits.parse::<u32>() {
                            let _ = tx.send(pid);
                            break;
                        }
                    }
                }
            }
        });
        let nieto = rx.recv_timeout(Duration::from_secs(30)).expect("pid del nieto");
        assert!(vivo(nieto), "el nieto tendría que estar vivo antes de matar el grupo");

        group.kill_all();
        drop(pty);

        let limite = Instant::now() + Duration::from_secs(5);
        while vivo(nieto) && Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }

        let sobrevivio = vivo(nieto);
        if sobrevivio {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &nieto.to_string()])
                .output();
        }
        assert!(!sobrevivio, "el nieto {nieto} quedó huérfano tras matar el grupo");
    }
}
