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
  // Marcar `<html>` o `<body>` deja la lista vacía (el recorrido para en la raíz), y un
  // selector vacío no vuelve a encontrar nada: el nombre de la etiqueta sí.
  return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
}

// ── Qué componente dibujó un elemento ───────────────────────────

/** Lo mínimo de un fiber de React que hace falta para subir hasta el componente. */
interface Fiber {
  type: unknown;
  return: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number };
  _debugOwner?: Fiber | null;
}

type Named = { displayName?: string; name?: string; __name?: string; __file?: string; render?: Named };

export interface ComponentInfo {
  framework: "React" | "Vue" | "Svelte";
  name: string;
  /** `src/components/Login.tsx:42`, si el framework lo deja ver en desarrollo. */
  source?: string;
}

const nameOf = (type: unknown): string | undefined => {
  if (!type || (typeof type !== "function" && typeof type !== "object")) return undefined;
  const t = type as Named;
  return t.displayName || t.name || t.render?.displayName || t.render?.name;
};

/** `/home/u/proy/src/App.tsx:12` → `src/App.tsx:12`: lo que se busca en el repo. */
function shortSource(file: string | undefined, line: number | undefined): string | undefined {
  if (!file) return undefined;
  const clean = file.replace(/\\/g, "/").replace(/^.*?\/(src|app|pages|components|lib)\//, "$1/");
  return line ? `${clean}:${line}` : clean;
}

/**
 * La cadena de componentes que dibujó el elemento, del más cercano hacia afuera: para un
 * agente, `SaveButton ← ProfileForm ← SettingsPage` dice dónde tocar el código, y una
 * cadena de `div` no dice nada.
 *
 * Solo funciona con la página en modo desarrollo: en un build de producción los nombres
 * están minificados y las fuentes no viajan.
 */
export function componentChain(el: Element, max = 4): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (let node: Element | null = el; node && out.length < max; node = node.parentElement) {
    const bag = node as unknown as Record<string, unknown>;
    const fiberKey = Object.keys(bag).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (fiberKey) {
      for (let fiber = bag[fiberKey] as Fiber | null; fiber && out.length < max; fiber = fiber.return) {
        const name = nameOf(fiber.type);
        // Con mayúscula: las etiquetas de host (`div`) también tienen `type`, como string.
        if (name && /^[A-Z]/.test(name) && !out.some((c) => c.name === name)) {
          out.push({
            framework: "React",
            name,
            source: shortSource(fiber._debugSource?.fileName, fiber._debugSource?.lineNumber),
          });
        }
      }
      return out;
    }
    const vue = bag.__vueParentComponent as { type?: Named } | undefined;
    const vueName = vue?.type && (vue.type.name || vue.type.__name);
    if (vueName && !out.some((c) => c.name === vueName)) {
      out.push({ framework: "Vue", name: vueName, source: shortSource(vue?.type?.__file, undefined) });
    }
    const svelte = bag.__svelte_meta as { loc?: { file: string; line: number } } | undefined;
    if (svelte?.loc) {
      const source = shortSource(svelte.loc.file, svelte.loc.line + 1);
      const name = svelte.loc.file.replace(/\\/g, "/").split("/").pop() ?? svelte.loc.file;
      if (!out.some((c) => c.source === source)) out.push({ framework: "Svelte", name, source });
    }
  }
  return out;
}

/** El componente más cercano, que es el que suele haber que editar. */
export function componentOf(el: Element): ComponentInfo | null {
  return componentChain(el, 1)[0] ?? null;
}
