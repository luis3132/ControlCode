//! Limpieza cuando la app termina por una señal del sistema y no por su propio menú.

/// Limpieza cuando la app termina por una SEÑAL y no por su propio menú.
///
/// `RunEvent::Exit` solo dispara en un cierre normal. Un `kill`, cerrar la sesión del
/// escritorio o apagar el sistema mandan `SIGTERM`, y ahí Tauri no llega a correr nada
/// nuestro: los agentes —y todo lo que hayan lanzado— quedaban vivos. Medido con
/// `ccode` contra una app real antes de esto.
///
/// La limpieza NO puede correr dentro del handler: escribe archivos de cgroup y ejecuta
/// `ps`, y nada de eso es async-signal-safe. Se usa el truco del self-pipe — el handler
/// solo escribe un byte (una syscall `write`, que sí lo es) y despierta a un hilo normal
/// que hace el trabajo de verdad.
///
/// Se descartó la variante con `sigwait` + máscara bloqueada: **se probó y no funciona
/// acá**. La máscara se hereda al crear un hilo, pero GTK/WebKit levantan los suyos y
/// alguno queda con la señal desbloqueada, así que el kernel se la entrega a ese y se
/// aplica la acción por defecto (terminar) antes de que nadie limpie. Un handler es
/// process-wide y no depende de qué hilo la reciba.
///
/// Queda un caso fuera del alcance, y no hay forma de cubrirlo: `SIGKILL` no se puede
/// interceptar. En Windows no hace falta nada de esto, porque ahí limpia el kernel al
/// cerrar el handle del Job Object.
#[cfg(unix)]
pub(super) fn cleanup_on_signals() {
    use std::sync::atomic::{AtomicI32, Ordering};

    static RECEIVED: AtomicI32 = AtomicI32::new(0);
    /// Extremo de escritura del self-pipe. `-1` = todavía sin instalar.
    static WAKE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(sig: libc::c_int) {
        // Lo único que pasa acá: dejar el número de señal y despertar al hilo. Un store
        // atómico y un `write` son de lo poco que se puede hacer sin riesgo desde un
        // handler.
        RECEIVED.store(sig, Ordering::SeqCst);
        let fd = WAKE_FD.load(Ordering::SeqCst);
        if fd >= 0 {
            unsafe { libc::write(fd, [1u8].as_ptr() as *const libc::c_void, 1) };
        }
    }

    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);
    WAKE_FD.store(write_fd, Ordering::SeqCst);

    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaction(sig, &action, std::ptr::null_mut());
        }
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 1];
        // Bloquea hasta que el handler escriba. Un `read` corto o interrumpido se reintenta
        // solo por el bucle.
        while unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, 1) } <= 0 {}

        crate::terminal::kill_all_sessions();
        crate::ipc::cleanup();
        // Código de salida convencional para una muerte por señal, para que quien mandó el
        // kill vea lo que espera.
        std::process::exit(128 + RECEIVED.load(Ordering::SeqCst));
    });
}

#[cfg(not(unix))]
pub(super) fn cleanup_on_signals() {}
