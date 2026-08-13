import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Un paso de la cadena de pre-lanzamiento. Ver `prelaunch::PrelaunchStep` en Rust.
 *
 * Se guarda la REFERENCIA al preset y no su texto: si después se edita el preset, las tabs
 * ya guardadas usan la versión nueva en vez de quedarse con una copia vieja.
 */
export type PrelaunchStep = { presetId: string } | { command: string };

/** Ver `prelaunch::PrelaunchPreset`. */
export interface PrelaunchPreset {
  id: string;
  /** Cómo lo ve el usuario, ej. "entorno conda". */
  name: string;
  command: string;
  createdAt: number;
}

export function isPresetStep(step: PrelaunchStep): step is { presetId: string } {
  return "presetId" in step;
}

/**
 * El texto de un paso, para mostrarlo. Un preset borrado se marca en vez de desaparecer:
 * la cadena va a fallar al lanzar (a propósito), y el usuario tiene que poder ver dónde.
 */
export function stepCommand(step: PrelaunchStep, presets: PrelaunchPreset[]): string | null {
  if (!isPresetStep(step)) return step.command;
  return presets.find((p) => p.id === step.presetId)?.command ?? null;
}

export function stepLabel(step: PrelaunchStep, presets: PrelaunchPreset[]): string | null {
  if (!isPresetStep(step)) return null;
  return presets.find((p) => p.id === step.presetId)?.name ?? null;
}

interface PrelaunchState {
  presets: PrelaunchPreset[];
  loaded: boolean;

  load: () => Promise<void>;
  save: (draft: { id?: string; name: string; command: string }) => Promise<PrelaunchPreset>;
  remove: (id: string) => Promise<void>;
}

export const usePrelaunchStore = create<PrelaunchState>()((set, get) => ({
  presets: [],
  loaded: false,

  load: async () => {
    set({ presets: await invoke<PrelaunchPreset[]>("list_prelaunch_presets"), loaded: true });
  },

  save: async (draft) => {
    const preset = await invoke<PrelaunchPreset>("save_prelaunch_preset", {
      id: draft.id ?? null,
      name: draft.name,
      command: draft.command,
    });
    await get().load();
    return preset;
  },

  remove: async (id) => {
    await invoke("delete_prelaunch_preset", { id });
    await get().load();
  },
}));
