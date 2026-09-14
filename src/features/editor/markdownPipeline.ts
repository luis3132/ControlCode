import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

import { createSlugger } from "./markdown";

/**
 * Cómo se convierte un Markdown del disco en lo que se ve en la vista previa.
 *
 * ## HTML, pero el de GitHub
 *
 * Los README usan HTML todo el tiempo: `<div align="center">`, `<details>`, `<img
 * width>`, `<kbd>`. Sin interpretarlo, `react-markdown` lo muestra como texto y el
 * documento se lee roto. Pero el archivo no es necesariamente tuyo —un repo clonado, algo
 * que escribió un agente—, así que después de interpretarlo se sanea con el mismo esquema
 * que usa GitHub: sin `<script>`, sin `<iframe>`, sin `on*=`, sin `style`, y los enlaces solo
 * con esquemas inocuos. Lo que GitHub no muestra, acá tampoco.
 *
 * ## Los ids de los títulos, al final
 *
 * El saneado prefija todo `id` con `user-content-` para que el documento no pueda pisar
 * ids de la página. Los títulos reciben el suyo DESPUÉS, con el mismo formato que GitHub,
 * para que un `[ver](#instalación)` escrito pensando en GitHub llegue a su sección.
 */
export const MARKDOWN_REMARK: Options["remarkPlugins"] = [remarkGfm];

export const MARKDOWN_REHYPE: Options["rehypePlugins"] = [
  rehypeRaw,
  [rehypeSanitize, defaultSchema],
  rehypeHeadingIds,
];

/** Lo mínimo de un nodo de hast que hace falta para recorrerlo. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = createSlugger();
    const walk = (node: HastNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        node.properties = { ...node.properties, id: slug(textOf(node)) };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
