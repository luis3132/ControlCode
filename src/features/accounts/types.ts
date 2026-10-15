import type { Quota } from "@/features/runs/types";

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

/** El cupo de una cuenta de Codex, según su `app-server` (ver `accounts/codex_usage.rs`). */
export interface CodexUsage {
  email: string | null;
  /** `plus`, `pro`, `free`… */
  plan: string | null;
  /** `chatgpt` o `apiKey`. Con API key no hay ventanas: se cobra por uso. */
  auth: string | null;
  quota: Quota | null;
  /** Epoch en segundos de la consulta. 0 = nunca se preguntó. */
  fetchedAt: number;
}
