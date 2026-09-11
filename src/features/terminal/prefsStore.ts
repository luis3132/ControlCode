import { create } from "zustand";

/**
 * Preferencias visuales de la terminal.
 *
 * Van a `localStorage` y no a SQLite (donde vive el resto de la configuración) por lo que
 * son: una preferencia de esta máquina, que hace falta leer de forma **síncrona** en el
 * momento exacto en que se monta la terminal. Un viaje por IPC ahí llegaría después de que
 * el proceso ya arrancó.
 */
const MARKS_KEY = "cc-terminal-input-marks";
const GPU_KEY = "cc-terminal-gpu";

interface TerminalPrefsState {
  /** Dibujar una línea de corte en cada envío del usuario. */
  inputMarks: boolean;
  setInputMarks: (value: boolean) => void;
  /** Rasterizar el texto por GPU. Se ve mucho mejor, pero depende del driver: si en
   *  esta máquina parpadea o deja terminales en blanco, se apaga y se vuelve al
   *  renderizador por DOM, que es más feo pero nunca falla. */
  gpuRenderer: boolean;
  setGpuRenderer: (value: boolean) => void;
}

export const useTerminalPrefsStore = create<TerminalPrefsState>((set) => ({
  // Por defecto ENCENDIDO: separar visualmente cada intervención en una conversación larga
  // es justo lo que hace navegable el scrollback de un agente.
  inputMarks: localStorage.getItem(MARKS_KEY) !== "0",

  setInputMarks: (value) => {
    localStorage.setItem(MARKS_KEY, value ? "1" : "0");
    set({ inputMarks: value });
  },

  gpuRenderer: localStorage.getItem(GPU_KEY) !== "0",

  setGpuRenderer: (value) => {
    localStorage.setItem(GPU_KEY, value ? "1" : "0");
    set({ gpuRenderer: value });
  },
}));
