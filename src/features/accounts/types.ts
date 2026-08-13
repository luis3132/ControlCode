/** Ver `accounts::AgentAccount` en Rust. */
export interface AgentAccount {
  id: string;
  agentId: string;
  /** Nombre simbólico elegido por el usuario; también es el nombre de la carpeta. */
  name: string;
  dir: string;
  /** Variable de entorno que apunta la TUI a esta cuenta (ej. `CLAUDE_CONFIG_DIR`). */
  envVar: string;
  /** Comando que abre el login de esa TUI. */
  loginCommand: string;
  /** Si la TUI dejó rastro de una sesión iniciada dentro de este perfil. */
  loggedIn: boolean;
  /** Mail (u otro identificador) de la cuenta, cuando la TUI lo expone. */
  label: string | null;
  createdAt: number;
}

/** TUI que soporta cuentas múltiples. Ver `accounts::AccountCapableAgent`. */
export interface AccountCapableAgent {
  agentId: string;
  label: string;
  envVar: string;
  installed: boolean;
}
