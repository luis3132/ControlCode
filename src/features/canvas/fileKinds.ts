/** Qué es cada archivo del proyecto en el canvas. Puro: se prueba en Node. */
import { deckDirOf } from "@/features/slides/deck";

import type { CanvasNodeKind } from "./model";

/** Lo que un archivo es en el canvas, o `null` si no se puede poner. La ruta es la que va en
 *  el nodo (de una presentación, su carpeta, aunque se arrastre una hoja). */
export function canvasKindOf(path: string, isDir: boolean): { kind: CanvasNodeKind; ref: string } | null {
  const deck = deckDirOf(path);
  if (deck) return { kind: "slides", ref: deck };
  if (isDir) return null;
  if (/\.diagram\.json$/i.test(path)) return { kind: "diagram", ref: path };
  if (/\.(md|markdown|mdx)$/i.test(path)) return { kind: "doc", ref: path };
  return null;
}
