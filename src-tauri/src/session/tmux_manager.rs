use std::process::Command;

fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Verifica si tmux está instalado en el sistema.
#[tauri::command]
pub fn tmux_check() -> bool {
    tmux_available()
}

/// Crea una sesión tmux desacoplada (detached) con el comando dado.
#[tauri::command]
pub fn tmux_create_session(session_id: String, command: String, cwd: String) -> Result<(), String> {
    if !tmux_available() {
        return Err("tmux not found in PATH".to_string());
    }

    let status = Command::new("tmux")
        .args(["new-session", "-d", "-s", &session_id, "-c", &cwd])
        .status()
        .map_err(|e| format!("Failed to create tmux session: {e}"))?;

    if !status.success() {
        return Err(format!("tmux new-session failed for '{session_id}'"));
    }

    if !command.is_empty() {
        Command::new("tmux")
            .args(["send-keys", "-t", &session_id, &command, "Enter"])
            .status()
            .map_err(|e| format!("Failed to send command to tmux: {e}"))?;
    }

    Ok(())
}

/// Lista las sesiones tmux activas.
#[tauri::command]
pub fn tmux_list_sessions() -> Result<Vec<String>, String> {
    if !tmux_available() {
        return Ok(vec![]);
    }

    let output = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .map_err(|e| format!("Failed to list tmux sessions: {e}"))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let sessions = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.to_string())
        .collect();

    Ok(sessions)
}

/// Mata una sesión tmux.
#[tauri::command]
pub fn tmux_kill_session(session_id: String) -> Result<(), String> {
    if !tmux_available() {
        return Err("tmux not found in PATH".to_string());
    }

    Command::new("tmux")
        .args(["kill-session", "-t", &session_id])
        .status()
        .map_err(|e| format!("Failed to kill tmux session: {e}"))?;

    Ok(())
}
