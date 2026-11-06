/**
 * El teclado de la computadora como el del teléfono. Puro: se prueba sin un teléfono.
 */

/** La tecla de Android para una tecla especial, o `null` si no es una. */
export function specialKey(key: string): string | null {
  switch (key) {
    case "Enter": return "enter";
    case "Backspace": return "backspace";
    case "Delete": return "forward_del";
    case "Tab": return "tab";
    // Escape es "atrás", como en scrcpy y en el emulador: es lo que se busca al apretarla.
    case "Escape": return "back";
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "Home": return "move_home";
    case "End": return "move_end";
    case "PageUp": return "page_up";
    case "PageDown": return "page_down";
    default: return null;
  }
}

/** Si la tecla escribe un carácter (y no es un atajo de la app). */
export function typedChar(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.ctrlKey || e.metaKey) return null;
  return [...e.key].length === 1 ? e.key : null;
}

/** Los caracteres que adb no puede escribir (acentos, ñ, emojis). */
export function untypeable(text: string): string[] {
  return [...new Set([...text].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t")))];
}
