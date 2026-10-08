/**
 * Las palabras que el chat muestra mientras el agente trabaja ("Hyperspacing…").
 *
 * De fábrica son las de la propia TUI, leídas de su binario (`agents/words.rs`): el texto
 * es suyo, no de la app. Lo que vive acá es la lista EDITADA por la persona, que pisa a esa
 * cuando existe — se agregan las propias, se sacan las que no gustan, y "restaurar" vuelve
 * a las de la TUI.
 *
 * Es un store y no un `getSetting` suelto porque lo leen dos pantallas a la vez: el chat
 * que las muestra y Ajustes que las edita, y el cambio tiene que verse sin reabrir nada.
 */
import { create } from "zustand";

import { getSetting, setSetting } from "@/shared/ipc/settings";

/** La clave en la tabla `settings`. */
export const WORDS_KEY = "chat.workingWords";

/** Lo máximo que puede medir una palabra: es una etiqueta al lado de un spinner. */
const MAX_LEN = 32;
const MAX_WORDS = 500;

interface WorkingWordsState {
  /** `null` = sin editar: valen las de la TUI. */
  custom: string[] | null;
  loaded: boolean;
  load: () => Promise<void>;
  save: (words: string[] | null) => Promise<void>;
}

export const useWorkingWords = create<WorkingWordsState>((set, get) => ({
  custom: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await getSetting(WORDS_KEY);
      set({ custom: parseWords(raw), loaded: true });
    } catch {
      // Sin base no hay lista propia: quedan las de la TUI.
      set({ loaded: true });
    }
  },

  save: async (words) => {
    set({ custom: words, loaded: true });
    await setSetting(WORDS_KEY, words === null ? "" : JSON.stringify(words));
  },
}));

/** Lo guardado, si se entiende y tiene algo. `null` = no hay lista propia. */
export function parseWords(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const words = v.filter((w): w is string => typeof w === "string").map(clean).filter(Boolean);
    return words.length > 0 ? words : null;
  } catch {
    return null;
  }
}

function clean(word: string): string {
  // Una sola línea y sin los puntos suspensivos: los pone quien la muestra.
  return word.replace(/\s+/g, " ").trim().replace(/…+$/, "").trim().slice(0, MAX_LEN);
}

/**
 * La lista con una palabra más al final. Devuelve la misma lista si no hay nada que
 * agregar (vacía, repetida o ya es demasiado larga): quien llama no tiene que validar.
 */
export function addWord(words: string[], raw: string): string[] {
  const word = clean(raw);
  if (!word || words.length >= MAX_WORDS) return words;
  if (words.some((w) => w.toLowerCase() === word.toLowerCase())) return words;
  return [...words, word];
}

export function removeWord(words: string[], index: number): string[] {
  return words.filter((_, i) => i !== index);
}
