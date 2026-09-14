use std::sync::{Arc, Mutex};

use super::rendering::{gpu_compositing_enabled, GPU_COMPOSITING_KEY};
use crate::database::set_setting;

/// Sin nada guardado, el texto nítido: es lo que se ve bien en Linux, y quien necesite la
/// GPU la prende a propósito (ver `rendering.rs`).
#[test]
fn por_defecto_no_se_compone_por_gpu() {
    let db = Arc::new(Mutex::new(crate::database::test_db()));
    assert!(!gpu_compositing_enabled(&db));
}

#[test]
fn solo_un_uno_explicito_prende_la_composicion() {
    let db = Arc::new(Mutex::new(crate::database::test_db()));
    set_setting(&db, GPU_COMPOSITING_KEY, "1").unwrap();
    assert!(gpu_compositing_enabled(&db));
    set_setting(&db, GPU_COMPOSITING_KEY, "0").unwrap();
    assert!(!gpu_compositing_enabled(&db));
    set_setting(&db, GPU_COMPOSITING_KEY, "true").unwrap();
    assert!(!gpu_compositing_enabled(&db), "cualquier otra cosa no cuenta");
}
