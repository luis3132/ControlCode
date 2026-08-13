import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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

interface AccountsState {
  accounts: AgentAccount[];
  capable: AccountCapableAgent[];
  loaded: boolean;

  load: () => Promise<void>;
  create: (agentId: string, name: string) => Promise<AgentAccount>;
  remove: (id: string, deleteFiles: boolean) => Promise<void>;
  /** Variables con las que hay que lanzar un proceso para que corra con esta cuenta. */
  envFor: (accountId: string) => Promise<Record<string, string>>;
}

export const useAccountsStore = create<AccountsState>()((set, get) => ({
  accounts: [],
  capable: [],
  loaded: false,

  load: async () => {
    // El estado de login se lee del disco en cada consulta (no se cachea en la base): el
    // login pasa dentro de la TUI, fuera del alcance de la app, y puede caducar sin aviso.
    const [accounts, capable] = await Promise.all([
      invoke<AgentAccount[]>("list_agent_accounts"),
      invoke<AccountCapableAgent[]>("account_capable_agents"),
    ]);
    set({ accounts, capable, loaded: true });
  },

  create: async (agentId, name) => {
    const account = await invoke<AgentAccount>("create_agent_account", { agentId, name });
    await get().load();
    return account;
  },

  remove: async (id, deleteFiles) => {
    await invoke("delete_agent_account", { id, deleteFiles });
    await get().load();
  },

  envFor: (accountId) => invoke<Record<string, string>>("agent_account_env", { accountId }),
}));
