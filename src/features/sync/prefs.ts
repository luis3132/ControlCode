import i18n from "@/i18n";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";

/**
 * Las preferencias que viven en el webview (localStorage) y viajan con la sincronización.
 * Tienen que coincidir con `SYNCED_PREFS` en Rust.
 *
 * Solo lo que es del usuario: el idioma, el tema, el tamaño del texto de la terminal. Lo
 * que depende de esta máquina (la aceleración por GPU, los paneles abiertos, las tabs) se
 * queda acá.
 */
export const SYNCED_PREFS = ["language", "theme", "cc-terminal-zoom", "cc-terminal-input-marks", "cc-markdown-preview"] as const;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function collectPrefs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SYNCED_PREFS) {
    const v = read(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

/** Aplica lo que llegó de otra máquina, cada cosa por su camino (no alcanza con escribir
 *  localStorage: el idioma, el tema y la terminal ya están cargados en memoria). */
export function applyPrefs(prefs: Record<string, string>, setTheme: (theme: "light" | "dark") => void) {
  const current = collectPrefs();
  for (const key of SYNCED_PREFS) {
    const value = prefs[key];
    if (value === undefined || value === current[key]) continue;
    try { localStorage.setItem(key, value); } catch { /* sin storage: se aplica igual en memoria */ }
    switch (key) {
      case "language": i18n.changeLanguage(value).catch(() => {}); break;
      case "theme": if (value === "light" || value === "dark") setTheme(value); break;
      case "cc-terminal-zoom": useTerminalPrefsStore.getState().setZoom(Number(value)); break;
      case "cc-terminal-input-marks": useTerminalPrefsStore.getState().setInputMarks(value !== "0"); break;
      default: break;
    }
  }
}
