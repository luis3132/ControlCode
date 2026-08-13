import { create } from "zustand";

import * as ipc from "./ipc";
import type { AccountCapableAgent, AgentAccount } from "./types";

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
    const [accounts, capable] = await Promise.all([ipc.listAccounts(), ipc.listCapableAgents()]);
    set({ accounts, capable, loaded: true });
  },

  create: async (agentId, name) => {
    const account = await ipc.createAccount(agentId, name);
    await get().load();
    return account;
  },

  remove: async (id, deleteFiles) => {
    await ipc.deleteAccount(id, deleteFiles);
    await get().load();
  },

  envFor: (accountId) => ipc.accountEnv(accountId),
}));
