//! Contención de procesos por tab: agrupa al proceso lanzado **y a toda su descendencia**
//! para poder matarlos juntos al cerrar la tab.
//!
//! # Por qué no alcanza con matar al proceso que lanzamos
//!
//! `portable-pty` mata solo al hijo directo: `SIGHUP` a un pid en unix (lib.rs:315) y
//! `TerminateProcess` en Windows (lib.rs:295). Ninguno de los dos toca a los nietos. Un
//! agente que levanta `npm run dev` deja el servidor corriendo cuando se cierra la tab.
//!
//! En unix hay una red de seguridad del kernel que tapa el caso más común: cuando muere el
//! líder de sesión, el terminal cuelga y el grupo en primer plano recibe `SIGHUP`. Medido
//! con `examples/orphan_probe.rs`, eso alcanza para un `sleep 600 &` normal e incluso para
//! uno con `nohup` — pero **no** para un proceso que se va a su propia sesión con `setsid`,
//! que sobrevive. `killpg` tampoco lo alcanza, justamente porque ya no está en ese grupo.
//! En Windows no existe siquiera esa red.
//!
//! # Cómo se resuelve en cada plataforma
//!
//! | Plataforma | Mecanismo | Alcanza a la descendencia completa |
//! |---|---|---|
//! | Linux | cgroup v2 propio por tab + `cgroup.kill` | sí, la pertenencia se hereda y no se puede escapar |
//! | Windows | Job Object + `TerminateJobObject` | sí, ídem |
//! | macOS | recorrido del árbol por `ppid` | best-effort (ver más abajo) |
//!
//! macOS no tiene ningún equivalente a cgroups ni a los Job Objects, así que ahí se
//! enumera el árbol por `ppid` y se mata de las hojas hacia la raíz. Es best-effort a
//! propósito: un proceso que ya fue reasignado a `init` pierde el vínculo con su padre y
//! el recorrido no lo encuentra. Se usa el mismo camino como respaldo en Linux si los
//! cgroups no están disponibles (contenedor sin delegación, cgroup v1, etc.).
//!
//! El `Drop` mata el grupo, así que cubre por igual los dos caminos por los que una sesión
//! sale del registry: el cierre explícito (`pty_kill`) y la muerte natural del proceso.
//!
//! # Qué habilita esto hacia adelante
//!
//! Con el grupo en su lugar, un proceso envoltorio deja de ser un problema. Eso importa
//! para los pre-comandos de lanzamiento (`conda activate` y compañía), que obligan a
//! delegar en un shell: en unix el `exec` final hace que el envoltorio se convierta en el
//! agente y conserve su pid, pero **Windows no tiene `exec`**, así que ahí el agente queda
//! sí o sí como hijo del `cmd` que lo lanzó. Sin el Job Object, matar la tab dejaría vivo
//! al agente; con él, el envoltorio es indistinto.

/// Contenedor de ciclo de vida de una tab.
///
/// Se crea **antes** de lanzar el proceso, para que exista ya cuando el hijo empiece a
/// tener descendencia propia.
pub struct ProcessGroup {
    pub(crate) imp: imp::Group,
}

impl ProcessGroup {
    /// `id` es el del PTY; solo se usa para darle un nombre legible al grupo.
    pub fn new(id: u32) -> Self {
        Self { imp: imp::create(id) }
    }

    /// Mete al proceso recién lanzado en el grupo. Sus hijos futuros entran solos: tanto
    /// los cgroups como los Job Objects se heredan al crear un proceso.
    ///
    /// Hay una carrera inevitable acá: el proceso ya está corriendo cuando lo adoptamos, y
    /// en teoría podría haber lanzado un hijo en ese intervalo. Es la misma ventana que
    /// aceptan VS Code y node, y no se puede cerrar sin `CREATE_SUSPENDED`/`posix_spawn`
    /// propios, que `portable-pty` no expone.
    pub fn adopt<C: portable_pty::Child + ?Sized>(&mut self, child: &C) {
        imp::adopt(&mut self.imp, child);
    }

    /// Mata todo lo que quede adentro. Idempotente: se llama explícitamente al cerrar una
    /// tab y otra vez desde `Drop`.
    pub fn kill_all(&mut self) {
        imp::kill_all(&mut self.imp);
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill_all();
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Linux — cgroup v2
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "linux")]
pub(crate) mod imp {
    use std::path::PathBuf;

    pub struct Group {
        /// `None` si no se pudo crear el cgroup; ahí se cae al respaldo por `ppid`.
        dir: Option<PathBuf>,
        leader: Option<u32>,
    }

    /// El cgroup de la propia app, leído de `/proc/self/cgroup`. En cgroup v2 hay una sola
    /// línea con el formato `0::/ruta/relativa/a/la/raiz`.
    fn own_cgroup() -> Option<PathBuf> {
        let raw = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let rel = raw.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
        Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
    }

    pub fn create(id: u32) -> Group {
        // Se crea un cgroup HIJO del de la app y no un hermano: así queda colgado del
        // scope de systemd de esta instancia y desaparece solo si la app muere sin
        // limpiar. No hace falta tocar `cgroup.subtree_control` porque `cgroup.kill` es un
        // archivo del core, no de un controlador — y sin controladores habilitados no
        // aplica la restricción de "nada de procesos en nodos internos", así que los hilos
        // de la app pueden seguir viviendo en el cgroup padre.
        let dir = own_cgroup()
            .map(|own| own.join(format!("cc-tab-{id}")))
            .filter(|d| std::fs::create_dir(d).is_ok());
        Group { dir, leader: None }
    }

    pub fn adopt<C: portable_pty::Child + ?Sized>(g: &mut Group, child: &C) {
        let Some(pid) = child.process_id() else { return };
        g.leader = Some(pid);
        if let Some(dir) = &g.dir {
            // Mover el pid al cgroup arrastra al proceso entero; lo que nazca de él
            // después hereda la pertenencia y no puede salirse.
            if std::fs::write(dir.join("cgroup.procs"), pid.to_string()).is_err() {
                // El cgroup existe pero no nos deja mover procesos: no sirve de nada
                // conservarlo. Queda el recorrido por `ppid` como único mecanismo.
                let _ = std::fs::remove_dir(dir);
                g.dir = None;
            }
        }
    }

    pub fn kill_all(g: &mut Group) {
        // Los dos mecanismos se usan juntos, y en este orden, porque cada uno tapa el
        // agujero del otro:
        //
        //  - El recorrido por `ppid` alcanza a lo que nació en la ventana de adopción
        //    (entre el spawn y el momento en que movemos al líder al cgroup), que quedó
        //    afuera del cgroup. Medido: `sh -c 'setsid sleep 30 & ...'` lanza el nieto
        //    antes de que lleguemos a adoptarlo.
        //  - El cgroup alcanza a lo que el recorrido no puede ver: procesos ya reasignados
        //    a `init`, o nacidos mientras el recorrido estaba a mitad de camino.
        //
        // Además el recorrido manda SIGHUP y no SIGKILL, así que un agente bien portado
        // alcanza a cerrar sus archivos — importa, porque las TUIs escriben su transcript
        // al salir y de ahí sale el título de la sesión.
        if let Some(pid) = g.leader.take() {
            super::unix_tree::kill_tree(pid);
        }
        let Some(dir) = g.dir.take() else { return };

        // Se espera a que el cgroup se vacíe solo por el SIGHUP anterior, y recién si
        // queda alguien se recurre al SIGKILL de `cgroup.kill`. En el caso normal esto
        // sale del bucle en pocos milisegundos sin matar nada a la fuerza.
        let limite = std::time::Instant::now() + GRACIA;
        while std::time::Instant::now() < limite {
            match std::fs::read_to_string(dir.join("cgroup.procs")) {
                Ok(s) if s.trim().is_empty() => break,
                Ok(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break, // el cgroup ya no está
            }
        }
        let _ = std::fs::write(dir.join("cgroup.kill"), "1");
        // El rmdir solo funciona con el cgroup ya vacío; si algo quedó, se lo lleva la
        // muerte del scope de systemd de la app.
        let _ = std::fs::remove_dir(&dir);
    }

    /// Cuánto se espera a que los procesos se vayan por las buenas antes del SIGKILL.
    /// Corto a propósito: esto corre al cerrar una tab, con el usuario mirando.
    const GRACIA: std::time::Duration = std::time::Duration::from_millis(300);

    #[cfg(test)]
    pub fn usa_cgroup(g: &Group) -> bool {
        g.dir.is_some()
    }

    #[cfg(test)]
    pub fn dir_de(g: &Group) -> Option<PathBuf> {
        g.dir.clone()
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// macOS — recorrido del árbol por ppid
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) mod imp {
    pub struct Group {
        leader: Option<u32>,
    }

    pub fn create(_id: u32) -> Group {
        Group { leader: None }
    }

    pub fn adopt<C: portable_pty::Child + ?Sized>(g: &mut Group, child: &C) {
        g.leader = child.process_id();
    }

    pub fn kill_all(g: &mut Group) {
        if let Some(pid) = g.leader.take() {
            super::unix_tree::kill_tree(pid);
        }
    }
}

/// Respaldo para unix sin cgroups: se enumera el árbol por `ppid` y se mata de las hojas
/// hacia la raíz, para que un padre no alcance a lanzar hijos nuevos mientras cae.
///
/// El recorrido tiene que hacerse **antes** de matar a nadie: una vez que el padre muere,
/// el kernel reasigna a sus hijos y el vínculo que los identificaba se pierde.
#[cfg(unix)]
pub(crate) mod unix_tree {
    /// `(pid, ppid)` de todos los procesos del sistema. Se usa `ps` y no `/proc` porque
    /// este camino existe sobre todo para macOS, que no tiene `/proc`.
    fn snapshot() -> Vec<(u32, u32)> {
        let out = match std::process::Command::new("ps").args(["-eo", "pid=,ppid="]).output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .collect()
    }

    /// Descendientes de `root`, en orden de profundidad creciente (la raíz no va incluida).
    pub(crate) fn descendants(root: u32, procs: &[(u32, u32)]) -> Vec<u32> {
        let mut found = vec![root];
        let mut i = 0;
        while i < found.len() {
            let parent = found[i];
            for (pid, ppid) in procs {
                // El guardia contra `found.contains` evita un bucle infinito si `ps`
                // devuelve un ciclo por reutilización de pids entre lecturas.
                if *ppid == parent && !found.contains(pid) {
                    found.push(*pid);
                }
            }
            i += 1;
        }
        found.remove(0);
        found
    }

    pub fn kill_tree(root: u32) {
        let procs = snapshot();
        let mut victims = descendants(root, &procs);
        victims.reverse(); // hojas primero
        victims.push(root);
        for pid in victims {
            unsafe {
                libc::kill(pid as i32, libc::SIGHUP);
            }
        }
    }
}

/// El test de arriba pasaría igual si el cgroup no funcionara, porque el recorrido por
/// `ppid` solo ya alcanza para ese caso. Estos verifican el mecanismo de Linux por
/// separado, para que no quede como código muerto que nadie ejercita.
// ─────────────────────────────────────────────────────────────────────────────────────
// Windows — Job Object
// ─────────────────────────────────────────────────────────────────────────────────────
#[cfg(windows)]
pub(crate) mod imp {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Group {
        job: HANDLE,
    }

    // El handle del job es propiedad exclusiva de esta struct y solo se toca detrás del
    // mutex del registry; nada lo comparte entre hilos por su cuenta.
    unsafe impl Send for Group {}

    pub fn create(_id: u32) -> Group {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if !job.is_null() {
            // KILL_ON_JOB_CLOSE es lo que hace que esto sobreviva a un cierre que NO pase
            // por nuestro código: si matan ControlCode desde el Administrador de tareas o
            // panica, el kernel cierra igual los handles del proceso muerto, y al cerrarse
            // el último handle del job se lleva a todos sus miembros.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
        }
        Group { job }
    }

    pub fn adopt<C: portable_pty::Child + ?Sized>(g: &mut Group, child: &C) {
        if g.job.is_null() {
            return;
        }
        // Se usa el handle que ya tiene `portable-pty` en vez de reabrir por pid: evita la
        // carrera de que ese pid haya sido reutilizado, que en Windows pasa seguido.
        let Some(handle) = child.as_raw_handle() else { return };
        unsafe {
            AssignProcessToJobObject(g.job, handle as RawHandle as HANDLE);
        }
    }

    pub fn kill_all(g: &mut Group) {
        if g.job.is_null() {
            return;
        }
        unsafe {
            TerminateJobObject(g.job, 1);
            CloseHandle(g.job);
        }
        g.job = std::ptr::null_mut();
    }

    #[cfg(test)]
    pub fn usa_job(g: &Group) -> bool {
        !g.job.is_null()
    }
}
