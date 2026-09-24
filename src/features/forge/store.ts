import { create } from "zustand";

import * as ipc from "./ipc";
import type { ForgeKindInfo, GitAccount } from "./types";

interface ForgeState {
  accounts: GitAccount[];
  kinds: ForgeKindInfo[];
  loaded: boolean;
  load: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Las cuentas de git. Las comparten la pantalla de Cuentas, el panel de control de
 *  versiones y el clonar del inicio: iniciar sesión en uno se ve en los otros. */
export const useForgeStore = create<ForgeState>()((set, get) => ({
  accounts: [],
  kinds: [],
  loaded: false,

  load: async () => {
    const [accounts, kinds] = await Promise.all([ipc.forgeAccounts(), ipc.forgeKinds()]);
    set({ accounts, kinds, loaded: true });
  },

  remove: async (id) => {
    await ipc.forgeRemoveAccount(id);
    await get().load();
  },
}));
