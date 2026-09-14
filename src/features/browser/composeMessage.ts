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
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * El texto que recibe el agente por cada tanda de elementos marcados.
 *
 * Lo que va es lo que sirve para encontrar el elemento en el CÓDIGO, no en la pantalla:
 * el componente que lo dibujó, un selector, el HTML y sus atributos identificables. Las
 * coordenadas no van — a un agente leyendo el repo no le dicen nada.
 */
export function composePickMessage(
  elements: PickedElement[],
  note: string,
  toDisplayUrl: (url: string) => string,
  labels: ComposeLabels
): string {
  if (elements.length === 0) return note.trim();
  const firstUrl = toDisplayUrl(elements[0].url);
  const lines = [labels.header(firstUrl), ""];

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

  if (note.trim()) lines.push(`${labels.note}: ${note.trim()}`);
  return lines.join("\n").trimEnd();
}

/** La URL del iframe (la del proxy) como la ve el usuario (la del servidor). */
export function toTargetUrl(url: string, proxyOrigin: string, targetOrigin: string): string {
  return url.startsWith(proxyOrigin) ? targetOrigin + url.slice(proxyOrigin.length) : url;
}
