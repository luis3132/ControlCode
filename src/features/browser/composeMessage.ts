import type { PickedElement } from "./protocol";

export interface ComposeLabels {
  /** Encabezado con la URL de la página. */
  header: (url: string) => string;
  page: string;
  selector: string;
  component: string;
  attributes: string;
  html: string;
  note: string;
  /** Encabezado de las capturas anotadas. */
  captures: string;
}

/** Una foto de la página con lo que el usuario dibujó encima, ya guardada en disco. */
export interface AnnotatedCapture {
  path: string;
  /** La página que se capturó, en la URL del proxy o la del servidor. */
  url: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * El texto que recibe el agente por cada tanda de elementos marcados y capturas anotadas.
 *
 * De un elemento va lo que sirve para encontrarlo en el CÓDIGO, no en la pantalla: el
 * componente que lo dibujó, un selector, el HTML y sus atributos identificables. Las
 * coordenadas no van — a un agente leyendo el repo no le dicen nada.
 *
 * Una captura es lo contrario: lo que el usuario VE, con sus marcas. Va la ruta del PNG sola
 * en su línea: las TUIs que reconocen rutas de imagen la adjuntan, y cualquier agente con
 * herramientas de archivos la puede abrir.
 */
export function composePickMessage(
  elements: PickedElement[],
  note: string,
  toDisplayUrl: (url: string) => string,
  labels: ComposeLabels,
  captures: AnnotatedCapture[] = []
): string {
  const lines: string[] = [];

  if (elements.length > 0) {
    const firstUrl = toDisplayUrl(elements[0].url);
    lines.push(labels.header(firstUrl), "");
    elements.forEach((el, i) => {
      const text = el.text ? ` «${oneLine(el.text)}»` : "";
      lines.push(`${i + 1}. <${el.tag}>${text}`);
      const url = toDisplayUrl(el.url);
      // La página se repite solo si cambió: juntar elementos de dos pantallas es válido.
      if (url !== firstUrl) lines.push(`   ${labels.page}: ${url}`);
      if (el.component) lines.push(`   ${labels.component}: ${el.component.name} (${el.component.framework})`);
      lines.push(`   ${labels.selector}: ${el.selector}`);
      const attrs = Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(" ");
      if (attrs) lines.push(`   ${labels.attributes}: ${attrs}`);
      lines.push(`   ${labels.html}: ${oneLine(el.html)}`);
      lines.push("");
    });
  }

  if (captures.length > 0) {
    lines.push(labels.captures, "");
    captures.forEach((capture, i) => {
      lines.push(`${i + 1}. ${toDisplayUrl(capture.url)}`);
      lines.push(capture.path);
      lines.push("");
    });
  }

  if (lines.length === 0) return note.trim();
  if (note.trim()) lines.push(`${labels.note}: ${note.trim()}`);
  return lines.join("\n").trimEnd();
}

/** La URL del iframe (la del proxy) como la ve el usuario (la del servidor). */
export function toTargetUrl(url: string, proxyOrigin: string, targetOrigin: string): string {
  return url.startsWith(proxyOrigin) ? targetOrigin + url.slice(proxyOrigin.length) : url;
}
