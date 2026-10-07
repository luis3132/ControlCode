//! CPU y memoria de cada subproceso, sumando a toda su descendencia: un `npm run dev` es
//! un shell que lanza node, que lanza esbuild; lo que pesa es el árbol, no el primero.
//!
//! El sistema se lee solo cuando alguien pregunta (la sección abierta, un agente que lista)
//! y se guarda entre lecturas: la CPU es "cuánto usó desde la vez anterior", así que la
//! primera lectura de un proceso da 0.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Porcentaje de un núcleo, como `top`: dos núcleos al máximo son 200.
    pub cpu: f32,
    /// Memoria residente, en bytes.
    pub memory: u64,
    /// Cuántos procesos tiene el árbol, contando al primero.
    pub processes: usize,
}

lazy_static::lazy_static! {
    static ref SYSTEM: Mutex<Option<System>> = Mutex::new(None);
}

/// Los descendientes de `root` (sin incluirlo), a partir de `(pid, padre)`.
pub(crate) fn descendants(root: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &parent) in parents {
        children.entry(parent).or_default().push(pid);
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
            // Un ciclo por pids reusados entre lecturas no puede colgar el recorrido.
            if child != root && !out.contains(&child) {
                out.push(child);
                stack.push(child);
            }
        }
    }
    out
}

/// El uso de cada árbol, por el pid de su raíz.
pub fn usage_of(roots: &[u32]) -> HashMap<u32, Usage> {
    let mut guard = SYSTEM.lock().unwrap_or_else(|e| e.into_inner());
    let system = guard.get_or_insert_with(|| {
        // En Linux sysinfo deja abiertos los `stat` de cada proceso para leer más rápido:
        // con cientos de procesos en el sistema son cientos de descriptores de la app.
        sysinfo::set_open_files_limit(0);
        System::new()
    });
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory());

    let parents: HashMap<u32, u32> = system
        .processes()
        .iter()
        .filter_map(|(pid, p)| p.parent().map(|parent| (pid.as_u32(), parent.as_u32())))
        .collect();

    roots
        .iter()
        .map(|&root| {
            let mut usage = Usage::default();
            for pid in std::iter::once(root).chain(descendants(root, &parents)) {
                if let Some(p) = system.process(Pid::from_u32(pid)) {
                    usage.cpu += p.cpu_usage();
                    usage.memory += p.memory();
                    usage.processes += 1;
                }
            }
            (root, usage)
        })
        .collect()
}
