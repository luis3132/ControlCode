//! Los comandos del panel, fuera del hilo de la ventana.
//!
//! Un `#[tauri::command]` síncrono corre en el hilo principal, y mientras corre la
//! ventana entera espera: leer una carpeta en un disco lento, copiar un árbol grande o los
//! `git` de `explorer_repo_info` (con hasta 4 s cada uno) congelaban toda la app, y además
//! en fila con cualquier otro comando síncrono. Acá cada uno corre en un hilo de bloqueo,
//! como ya hacen los de `scm`. La lógica queda en las funciones síncronas de cada módulo,
//! que son las que prueban los tests.

use super::{DirEntry, FileContent, FileStat, RepoInfo, WriteOutcome};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn explorer_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || super::explorer_read_dir(path)).await
}

#[tauri::command]
pub async fn explorer_repo_info(path: String) -> Result<RepoInfo, String> {
    blocking(move || super::explorer_repo_info(path)).await
}

#[tauri::command]
pub async fn explorer_read_file(path: String) -> Result<FileContent, String> {
    blocking(move || super::explorer_read_file(path)).await
}

#[tauri::command]
pub async fn explorer_file_stat(path: String) -> Result<Option<FileStat>, String> {
    blocking(move || super::explorer_file_stat(path)).await
}

#[tauri::command]
pub async fn explorer_write_file(path: String, content: String, expected_mtime: Option<i64>) -> Result<WriteOutcome, String> {
    blocking(move || super::explorer_write_file(path, content, expected_mtime)).await
}

#[tauri::command]
pub async fn explorer_create_file(dir: String, name: String) -> Result<String, String> {
    blocking(move || super::explorer_create_file(dir, name)).await
}

#[tauri::command]
pub async fn explorer_create_dir(dir: String, name: String) -> Result<String, String> {
    blocking(move || super::explorer_create_dir(dir, name)).await
}

#[tauri::command]
pub async fn explorer_rename(path: String, name: String) -> Result<String, String> {
    blocking(move || super::explorer_rename(path, name)).await
}

#[tauri::command]
pub async fn explorer_copy(path: String, dir: String) -> Result<String, String> {
    blocking(move || super::explorer_copy(path, dir)).await
}

#[tauri::command]
pub async fn explorer_move(path: String, dir: String) -> Result<String, String> {
    blocking(move || super::explorer_move(path, dir)).await
}

#[tauri::command]
pub async fn explorer_trash(paths: Vec<String>) -> Result<(), String> {
    blocking(move || super::explorer_trash(paths)).await
}
