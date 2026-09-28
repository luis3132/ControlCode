import { create } from "zustand";

import * as ipc from "./ipc";
import type { SshConnection, SshConnectionDraft } from "./types";

interface ConnectionsState {
  connections: SshConnection[];
  loaded: boolean;

  load: () => Promise<void>;
  save: (draft: SshConnectionDraft) => Promise<SshConnection>;
  remove: (id: string) => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsState>()((set, get) => ({
  connections: [],
  loaded: false,

  load: async () => {
    set({ connections: await ipc.listConnections(), loaded: true });
  },

  save: async (draft) => {
    const saved = await ipc.saveConnection(draft);
    await get().load();
    return saved;
  },

  remove: async (id) => {
    await ipc.deleteConnection(id);
    await get().load();
  },
}));
