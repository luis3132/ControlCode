//! Comandos que corren ANTES de lanzar el agente, en el mismo proceso.
//!
//! ## Para qué
//!
//! Un agente ejecuta comandos por vos. Si arranca en el entorno equivocado no falla de
//! forma obvia: falla de forma confusa. Sin el venv activo, `pytest` tira
//! `ModuleNotFoundError` y el agente se pone a "arreglar" una dependencia que en realidad
//! está instalada. Esto deja preparar el entorno primero: `conda activate ml`,
//! `nvm use`, `source .venv/bin/activate`, `eval "$(direnv export bash)"`.
//!
//! ## Por qué no se pueden correr como procesos aparte
//!
//! Las variables de entorno se heredan de padre a hijo en el momento del spawn, y en una
//! sola dirección. `conda activate` no es un binario: es una función que muta el entorno
//! del shell que la ejecuta. Corrida en un proceso aparte, su efecto muere con ese proceso
//! y el agente —que no es su hijo— jamás se entera.
//!
//! Por eso la cadena se ejecuta DENTRO del mismo shell que después se convierte en el
//! agente (ver `terminal::pty_manager::launch_script`).
//!
//! ## El modelo
//!
//! Una cadena es una lista ORDENADA de pasos, y el orden es semántico: `nvm use 18` tiene
//! que correr antes de cualquier cosa que dependa de npm. Cada paso es o un comando suelto
//! escrito en el momento, o una referencia a un preset guardado en Configuración.
//!
//! Se guarda la REFERENCIA al preset y no su texto ya resuelto, por el mismo motivo que
//! con las cuentas: si después editás el preset, las tabs restauradas usan la versión
//! nueva en vez de quedarse con una copia vieja. Y si el preset fue borrado, lanzar
//! **falla con mensaje** en vez de arrancar sin él — arrancar en el entorno equivocado y
//! en silencio es justo lo que esta feature viene a evitar.

mod presets;
mod resolve;
mod steps;
#[cfg(test)]
mod test;

pub use presets::*;
pub use resolve::*;
pub use steps::*;
