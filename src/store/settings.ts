import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CustomAgent {
  id: string;
  label: string;
  command: string;
}

interface SettingsState {
  customAgents: CustomAgent[];
  addCustomAgent: (agent: Omit<CustomAgent, "id">) => void;
  removeCustomAgent: (id: string) => void;
  updateCustomAgent: (id: string, patch: Partial<Omit<CustomAgent, "id">>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      customAgents: [],

      addCustomAgent: (agent) =>
        set((state) => ({
          customAgents: [
            ...state.customAgents,
            { ...agent, id: crypto.randomUUID() },
          ],
        })),

      removeCustomAgent: (id) =>
        set((state) => ({
          customAgents: state.customAgents.filter((a) => a.id !== id),
        })),

      updateCustomAgent: (id, patch) =>
        set((state) => ({
          customAgents: state.customAgents.map((a) =>
            a.id === id ? { ...a, ...patch } : a
          ),
        })),
    }),
    { name: "controlcode-settings" }
  )
);
