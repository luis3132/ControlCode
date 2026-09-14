import { create } from "zustand";

import { clampZoom, TERMINAL_ZOOM } from "@/features/terminal/theme";

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
const ZOOM_KEY = "cc-terminal-zoom";

interface TerminalPrefsState {
  /** Dibujar una línea de corte en cada envío del usuario. */
  inputMarks: boolean;
  setInputMarks: (value: boolean) => void;
  /** Rasterizar el texto por GPU. Se ve mucho mejor, pero depende del driver: si en
   *  esta máquina parpadea o deja terminales en blanco, se apaga y se vuelve al
   *  renderizador por DOM, que es más feo pero nunca falla. */
  gpuRenderer: boolean;
  setGpuRenderer: (value: boolean) => void;
  /** La ventana se compone por GPU en esta ejecución. Sin eso WebKitGTK no ofrece WebGL,
   *  y pedirlo igual deja la terminal esperando un contexto que nunca llega bien. Lo fija
   *  el arranque (ver `main.tsx` y `app/rendering.rs`). */
  compositing: boolean;
  setCompositing: (value: boolean) => void;
  /** Zoom del texto de todas las terminales, en porcentaje (ver `terminalFontSize`). La
   *  fuente que se ve bien depende de la pantalla y de la distancia, no de la TUI. */
  zoom: number;
  setZoom: (value: number) => void;
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

  compositing: true,
  setCompositing: (compositing) => set({ compositing }),

  zoom: clampZoom(Number(localStorage.getItem(ZOOM_KEY) ?? TERMINAL_ZOOM.default)),

  setZoom: (value) => {
    const zoom = clampZoom(value);
    localStorage.setItem(ZOOM_KEY, String(zoom));
    set({ zoom });
  },
}));
