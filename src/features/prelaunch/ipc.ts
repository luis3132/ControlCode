/** Comandos de pre-lanzamiento. Ver `prelaunch/presets.rs` y `prelaunch/resolve.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { PrelaunchPreset, PrelaunchStep } from "./types";

export const listPresets = () => invoke<PrelaunchPreset[]>("list_prelaunch_presets");

export const savePreset = (draft: { id?: string; name: string; command: string }) =>
  invoke<PrelaunchPreset>("save_prelaunch_preset", {
    id: draft.id ?? null,
    name: draft.name,
    command: draft.command,
  });

export const deletePreset = (id: string) => invoke<void>("delete_prelaunch_preset", { id });

/**
 * Traduce la cadena guardada a los comandos concretos a ejecutar, en orden.
 *
 * Se llama justo antes de lanzar el proceso, no al guardar la tab: un preset pudo
 * editarse o borrarse mientras tanto, y uno borrado tiene que hacer fallar el lanzamiento
 * en vez de arrancar el agente en el entorno equivocado.
 */
export const resolvePrelaunch = (steps: PrelaunchStep[]) =>
  invoke<string[]>("resolve_prelaunch", { steps });
