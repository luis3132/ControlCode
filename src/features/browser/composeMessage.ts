import type { PickedElement } from "./protocol";

/** Una foto de la página con lo que el usuario dibujó encima, ya guardada en disco. */
export interface AnnotatedCapture {
  /** `s-…`: va en el aviso que recibe el agente, en el nombre del archivo y en lo que lee
   *  después, así no hay dudas de cuál imagen es cuál. */
  id: string;
  path: string;
  /** La página que se capturó, en la URL del proxy o la del servidor. */
  url: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * El texto que recibe el agente por cada tanda de elementos marcados y capturas anotadas.
 *
 * Va EN INGLÉS aunque la app esté en español: es un prompt (ver `markedView.ts`). Lo único
 * que va tal cual lo escribió la persona es su nota.
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
  captures: AnnotatedCapture[] = []
): string {
  const lines: string[] = [];

  if (elements.length > 0) {
    const firstUrl = toDisplayUrl(elements[0].url);
    lines.push(`The user marked ${elements.length} element(s) in ${firstUrl}:`, "");
    elements.forEach((el, i) => {
      const text = el.text ? ` «${oneLine(el.text)}»` : "";
      lines.push(`${i + 1}. <${el.tag}>${text}`);
      const url = toDisplayUrl(el.url);
      // La página se repite solo si cambió: juntar elementos de dos pantallas es válido.
      if (url !== firstUrl) lines.push(`   page: ${url}`);
      if (el.component) lines.push(`   component: ${el.component.name} (${el.component.framework})`);
      lines.push(`   selector: ${el.selector}`);
      const attrs = Object.entries(el.attributes).map(([k, v]) => `${k}="${v}"`).join(" ");
      if (attrs) lines.push(`   attributes: ${attrs}`);
      lines.push(`   html: ${oneLine(el.html)}`);
      lines.push("");
    });
  }

  if (captures.length > 0) {
    lines.push("Screenshots of the page annotated by the user (how they see it on screen; open each image to view it):", "");
    captures.forEach((capture, i) => {
      lines.push(`${i + 1}. [${capture.id}] ${toDisplayUrl(capture.url)}`);
      lines.push(capture.path);
      lines.push("");
    });
  }

  if (lines.length === 0) return note.trim();
  if (note.trim()) lines.push(`Note from the user: ${note.trim()}`);
  return lines.join("\n").trimEnd();
}

/** La URL del iframe (la del proxy) como la ve el usuario (la del servidor). */
export function toTargetUrl(url: string, proxyOrigin: string, targetOrigin: string): string {
  return url.startsWith(proxyOrigin) ? targetOrigin + url.slice(proxyOrigin.length) : url;
}
