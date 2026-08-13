//! La única definición de "ahora" de la app.

/// Segundos desde epoch. Es la escala de TODAS las columnas de tiempo de la base, así que
/// vive en un solo lugar: antes había una copia por módulo y no eran idénticas — algunas
/// hacían `.unwrap()` sobre el `SystemTime`, que puede fallar si el reloj del sistema está
/// antes de 1970, y ahí el módulo entero se caía.
pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
