import { highlightCode } from "@lezer/highlight";
import { defaultHighlightStyle, LanguageDescription, type HighlightStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { StyleModule } from "style-mod";

/** Un pedazo de una línea de código, con las clases de su color. */
export interface Span {
  text: string;
  className: string;
}

/**
 * Colores de sintaxis para un bloque de código de la vista previa, sin montar un editor.
 *
 * Son las mismas gramáticas y los mismos estilos que el editor de archivos (ver
 * `codemirror.ts`): el mismo código no puede verse de dos colores según dónde se abra. Las
 * gramáticas se cargan bajo demanda, igual que en el editor.
 */
export async function highlightLines(code: string, language: string, dark: boolean): Promise<Span[][] | null> {
  const description = LanguageDescription.matchLanguageName(languages, language, true);
  if (!description) return null;
  const support = description.support ?? (await description.load());
  const tree = support.language.parser.parse(code);
  const style = mounted(dark ? oneDarkHighlightStyle : defaultHighlightStyle);

  const lines: Span[][] = [[]];
  highlightCode(
    code,
    tree,
    style,
    (text, className) => lines[lines.length - 1].push({ text, className }),
    () => lines.push([]),
  );
  return lines;
}

const mountedStyles = new Set<HighlightStyle>();

/** Las clases de un estilo existen recién cuando su hoja está en el documento. El editor
 *  la monta al crearse; la vista previa puede mostrarse antes que ningún editor. */
function mounted(style: HighlightStyle): HighlightStyle {
  if (!mountedStyles.has(style) && style.module) {
    StyleModule.mount(document, style.module);
    mountedStyles.add(style);
  }
  return style;
}
