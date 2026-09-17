/**
 * Lo que el agente recibe cuando la persona le señala algo en el navegador.
 *
 * Es la diferencia entre "arreglá el botón" y "arreglá este botón, que lo dibuja
 * `SaveButton` en `src/components/SaveButton.tsx:24`, mide 120×36, está tapado por un
 * overlay y podés tocarlo con el ref `u1`". Puro: se prueba en Node, y lo usan tanto el
 * MCP como el texto que se pega en una terminal.
 *
 * Todo lo que sale de acá va EN INGLÉS, aunque la app esté en español: es un prompt, no
 * interfaz. El idioma de la app lo eligió el usuario para él; el modelo lee mejor —y
 * cualquier modelo, no solo el que hable español— si lo que le llega está siempre igual.
 * Lo único que va tal cual lo escribió la persona es su nota.
 */
import type { AnnotatedCapture } from "./composeMessage";
import type { PickedElement } from "./protocol";

/** Lo que devuelve el comando `describe` del runtime de la página. */
export interface DescribedElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  selector: string;
  states: string[];
  value?: string;
  text: string;
  components: { framework: string; name: string; source?: string }[];
  ancestors: string[];
  attributes: Record<string, string>;
  classes: string[];
  box: { x: number; y: number; width: number; height: number; visible: boolean; covered: string | null };
  viewport: { width: number; height: number };
  styles: Record<string, string>;
  html: string;
  url: string;
}

/** Un elemento marcado: como está en la página ahora, o como se lo marcó si ya no está. */
export type MarkedEntry =
  | { live: true; element: DescribedElement }
  | { live: false; element: PickedElement };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

function componentLine(components: DescribedElement["components"]): string | null {
  if (components.length === 0) return null;
  const [first, ...rest] = components;
  const source = first.source ? ` — ${first.source}` : "";
  const outer = rest.length > 0 ? ` (inside ${rest.map((c) => c.name).join(" ← ")})` : "";
  return `component: ${first.name} (${first.framework})${source}${outer}`;
}

/** Un elemento descrito, con lo que sirve para encontrarlo en el código y para actuar. */
export function formatElement(entry: MarkedEntry, index: number, toDisplayUrl: (url: string) => string): string {
  const lines: string[] = [];
  if (!entry.live) {
    const el = entry.element;
    lines.push(`${index}. <${el.tag}>${el.text ? ` "${oneLine(el.text)}"` : ""} — no longer in the page (it changed since it was marked)`);
    if (el.component) lines.push(`   component: ${el.component.name} (${el.component.framework})${el.component.source ? ` — ${el.component.source}` : ""}`);
    lines.push(`   selector: ${el.selector}`);
    lines.push(`   page: ${toDisplayUrl(el.url)}`);
    if (el.html) lines.push(`   html: ${clip(oneLine(el.html), 400)}`);
    return lines.join("\n");
  }

  const el = entry.element;
  const name = el.name ? ` "${el.name}"` : "";
  const states = el.states.length > 0 ? ` [${el.states.join("] [")}]` : "";
  lines.push(`${index}. ${el.role}${name} [ref=${el.ref}]${states}`);
  lines.push(`   selector: ${el.selector}`);
  const component = componentLine(el.components);
  if (component) lines.push(`   ${component}`);
  if (el.ancestors.length > 0) lines.push(`   inside: ${el.ancestors.join(" › ")}`);
  const where = `${el.box.width}×${el.box.height} at (${el.box.x}, ${el.box.y}) in a ${el.viewport.width}×${el.viewport.height} viewport`;
  const visibility = el.box.covered
    ? `covered by ${el.box.covered}`
    : el.box.visible ? "visible" : "not visible";
  lines.push(`   box: ${where}, ${visibility}`);
  const styles = Object.entries(el.styles).map(([k, v]) => `${k}:${v}`).join(" · ");
  if (styles) lines.push(`   styles: ${styles}`);
  const attributes = Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(" ");
  if (attributes) lines.push(`   attributes: ${attributes}`);
  if (el.classes.length > 0) lines.push(`   classes: ${el.classes.join(" ")}`);
  if (el.value !== undefined) lines.push(`   value: "${el.value}"`);
  if (el.text && el.text !== el.name) lines.push(`   text: "${oneLine(el.text)}"`);
  lines.push(`   html: ${clip(oneLine(el.html), 600)}`);
  return lines.join("\n");
}

/**
 * Todo lo que la persona dejó señalado: elementos, capturas anotadas y su nota.
 *
 * Las capturas van como ruta de archivo sola: el agente las abre con sus herramientas de
 * archivos, que es la única forma de "ver" la página (un iframe no se puede fotografiar).
 */
export function formatMarked(
  entries: MarkedEntry[],
  captures: AnnotatedCapture[],
  note: string,
  toDisplayUrl: (url: string) => string,
  /** Lo que ESTA TUI le antepone al nombre de cada tool (OpenCode: `controlcode_`). Las
   *  tools que se nombran acá tiene que poder llamarlas con el nombre que lee. */
  prefix = ""
): string {
  const out: string[] = [];
  if (entries.length > 0) {
    const url = toDisplayUrl(entries[0].live ? entries[0].element.url : entries[0].element.url);
    out.push(`The user marked ${entries.length} element(s) in ${url}:`, "");
    entries.forEach((entry, i) => {
      out.push(formatElement(entry, i + 1, toDisplayUrl), "");
    });
    out.push(
      `Act on them by their ref (${prefix}browser_click u1, ${prefix}browser_type u2 …); refs the user marked`
      + " stay valid until the page reloads.",
      ""
    );
  }
  if (captures.length > 0) {
    out.push("Screenshots the user annotated (open the files with your file tools):", "");
    captures.forEach((capture, i) => {
      out.push(`${i + 1}. [${capture.id}] ${toDisplayUrl(capture.url)}`, `   ${capture.path}`, "");
    });
  }
  if (note.trim()) out.push(`Note from the user: ${note.trim()}`);
  return out.join("\n").trimEnd();
}

/**
 * El texto corto que se pega en la terminal de un agente que SÍ tiene el MCP: en vez de
 * volcarle el HTML y los atributos de cada elemento, se le dice qué hay, con qué
 * herramienta leerlo y cuál de los lotes es el suyo. Lo que necesite, lo pide; lo que no,
 * no le gasta contexto.
 */
export function composePointer(
  counts: { picks: number; captures: number },
  url: string,
  note: string,
  /** Las capturas que dejó, ya guardadas. Van en el aviso y no solo en la tool: una imagen
   *  en disco es un hecho que no cambia, y así el agente la puede abrir de una. */
  capturePaths: string[] = [],
  /** Cuál de los lotes es este. Con dos agentes marcando cosas, es lo que le dice a cada
   *  uno cuál le toca. */
  batchId?: string,
  /** Lo que ESTA TUI le antepone al nombre de cada tool. Sin esto, a un agente de OpenCode
   *  se le dice que use `browser_marked` y lo que tiene se llama `controlcode_browser_marked`. */
  prefix = ""
): string {
  const parts: string[] = [];
  if (counts.picks > 0) {
    parts.push(`I marked ${counts.picks} element${counts.picks === 1 ? "" : "s"} for you in ${url}.`);
  }
  if (counts.captures > 0) {
    // Con elementos, la URL ya se dijo; sin ellos, esta frase es la única que la lleva.
    const where = counts.picks > 0 ? "that page" : url;
    parts.push(`I left ${counts.captures} annotated screenshot${counts.captures === 1 ? "" : "s"} of ${where}.`);
  }
  if (parts.length === 0) parts.push(`About ${url}:`);
  parts.push(
    batchId
      ? `Read it with ${prefix}browser_marked id=${batchId} — that id is yours and returns exactly this: the`
        + " component and source file that rendered each element, where it sits, its styles and a ref you can act on."
      : `Read it with ${prefix}browser_marked: it gives you the component and source file that rendered each one,`
        + " where it sits, its styles and a ref you can act on."
  );

  const lines = [parts.join(" ")];
  // Cada ruta sola en su renglón: así una TUI que reconoce imágenes la adjunta.
  if (capturePaths.length > 0) lines.push("", ...capturePaths);
  if (note.trim()) lines.push("", `Note from the user: ${note.trim()}`);
  return lines.join("\n");
}

/** El encabezado de un envío ya mandado, para que el agente sepa qué está leyendo. */
export function batchHeader(batch: { id: string; at: number }, now: number): string {
  const secs = Math.max(0, Math.round((now - batch.at) / 1000));
  const ago = secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
  return `${batch.id} — what the user sent you ${ago}. It is no longer in their panel, and this is the last time it is served:`;
}
