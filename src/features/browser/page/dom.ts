/**
 * Cómo se nombra un elemento de la página: lo comparten el selector (`picker.ts`) y el
 * runtime del agente (`runtime.ts`), así un elemento marcado a mano y uno que tocó un
 * agente se escriben igual.
 */

/** `button#enviar` o `div.card.featured`: corto, para leer. */
export function describeElement(el: Element): string {
  const name = el.tagName.toLowerCase();
  if (el.id) return `${name}#${el.id}`;
  const classes = Array.from(el.classList).slice(0, 2);
  return classes.length ? `${name}.${classes.join(".")}` : name;
}

/** Un selector que vuelva a encontrar el elemento, lo más corto posible. Las clases con
 *  `:`, `[` o `/` (Tailwind) se saltean: válidas, pero ilegibles como referencia. */
export function selectorOf(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const classes = Array.from(node.classList)
      .filter((c) => c.length < 32 && !/[:[\]/]/.test(c))
      .slice(0, 2);
    if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
    const parent: Element | null = node.parentElement;
    if (parent) {
      const tag = node.tagName;
      const same = Array.from(parent.children).filter((c) => c.tagName === tag);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (parts.length >= 5) break;
  }
  return parts.join(" > ");
}
