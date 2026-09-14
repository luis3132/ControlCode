/**
 * Lo que comparten el editor de archivos y el de diffs: tema, idioma y tipografía.
 *
 * El editor se viste con los colores de la app y no con los de un tema de CodeMirror: al
 * lado de la terminal, un fondo gris azulado de otro programa se lee como una ventana
 * incrustada. Del tema oscuro de CodeMirror solo se toma el resaltado de sintaxis.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";

import { baseName } from "@/features/tabs/viewTabs";
import { TERMINAL_FONT } from "@/features/terminal/theme";

/** La misma familia que la terminal: el mismo código no puede verse con dos letras. */
const FONT = TERMINAL_FONT;

const base = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: FONT, lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px" },
});

const dark = [
  EditorView.theme(
    {
      "&": { color: "#e6edf3" },
      ".cm-gutters": { color: "rgba(255,255,255,0.22)" },
      ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "rgba(255,255,255,0.65)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#58a6ff" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "rgba(56,139,253,0.28)" },
      ".cm-searchMatch": { backgroundColor: "rgba(210,153,34,0.3)" },
      ".cm-panels": { backgroundColor: "#0a0f16", color: "#e6edf3" },
      ".cm-panels input, .cm-panels button": { color: "inherit" },
      ".cm-tooltip": { backgroundColor: "#161b22", border: "1px solid rgba(255,255,255,0.12)" },
      ".cm-foldPlaceholder": { backgroundColor: "rgba(255,255,255,0.08)", border: "none", color: "#8b949e" },
    },
    { dark: true }
  ),
  syntaxHighlighting(oneDarkHighlightStyle),
];

const light = [
  EditorView.theme(
    {
      ".cm-gutters": { color: "#9ca3af" },
      ".cm-activeLine": { backgroundColor: "rgba(0,0,0,0.03)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#374151" },
      ".cm-panels": { backgroundColor: "#f3f4f6" },
    },
    { dark: false }
  ),
  // Explícito y no confiando en `basicSetup`: el diff no lo usa, y sin esto el tema claro
  // quedaba sin colores de sintaxis ahí.
  syntaxHighlighting(defaultHighlightStyle),
];

export function editorTheme(isDark: boolean): Extension {
  return [base, isDark ? dark : light];
}

/** El soporte de lenguaje para un archivo. Se carga bajo demanda: son decenas de
 *  gramáticas y no tiene sentido meterlas todas en el arranque de la app. */
export async function languageFor(path: string): Promise<Extension> {
  const description = LanguageDescription.matchFilename(languages, baseName(path));
  return description ? description.load() : [];
}
