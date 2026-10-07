import { create } from "zustand";

import { procsList } from "./ipc";
import type { Subprocess } from "./types";

const SHOW_ALL_KEY = "cc-procs-show-all";

function readShowAll(): boolean {
  try {
    return localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch {
    return false;
  }
}

interface ProcessesState {
  procs: Subprocess[];
  /** Mostrar los de todos los workspaces y no solo los del actual. Se recuerda. */
  showAll: boolean;
  load: () => Promise<void>;
  setShowAll: (value: boolean) => void;
}

export const useProcessesStore = create<ProcessesState>((set) => ({
  procs: [],
  showAll: readShowAll(),
  load: async () => {
    set({ procs: await procsList() });
  },
  setShowAll: (showAll) => {
    try {
      localStorage.setItem(SHOW_ALL_KEY, showAll ? "1" : "0");
    } catch {
      // sin almacenamiento: vale para esta sesión
    }
    set({ showAll });
  },
}));
