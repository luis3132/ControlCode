/**
 * El texto que lee un agente para "ver" la página: un árbol de lo que se puede leer y
 * tocar, con un ref por elemento interactivo.
 *
 * No es el DOM: una página real tiene miles de `div` que no significan nada para quien la
 * usa. Es la forma de un árbol de accesibilidad —rol, nombre, estado—, que es además lo
 * que los modelos ya saben leer (es la forma de los snapshots de Playwright). Recorrer el
 * DOM vive en `runtime.ts`; acá solo el formato, puro y probado.
 */

export interface SnapshotNode {
  depth: number;
  role: string;
  name: string;
  /** Solo los que se pueden tocar. */
  ref?: string;
  /** `disabled`, `checked`, `expanded`, `focused`… */
  states: string[];
  value?: string;
  /** El destino de un link, sin el origen si es el de la página. */
  href?: string;
}

export interface SnapshotMeta {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollY: number;
  documentHeight: number;
  /** Cuántos nodos quedaron afuera por el tope. */
  omitted: number;
}

const quote = (s: string) => JSON.stringify(s);

export function formatNode(node: SnapshotNode): string {
  let line = `${"  ".repeat(node.depth)}- ${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  if (node.ref) line += ` [ref=${node.ref}]`;
  for (const state of node.states) line += ` [${state}]`;
  if (node.value !== undefined) line += ` value=${quote(node.value)}`;
  if (node.href) line += ` → ${node.href}`;
  return line;
}

export function formatSnapshot(nodes: SnapshotNode[], meta: SnapshotMeta): string {
  const header = [
    `page: ${meta.title ? `${quote(meta.title)} ` : ""}${meta.url}`,
    `viewport: ${meta.viewport.width}×${meta.viewport.height} · scroll ${Math.round(meta.scrollY)}/${Math.round(meta.documentHeight)}`,
  ];
  const body = nodes.length ? nodes.map(formatNode) : ["(la página no tiene contenido visible)"];
  if (meta.omitted > 0) body.push(`… ${meta.omitted} nodos más (pedí el snapshot completo o hacé scroll)`);
  return [...header, "", ...body].join("\n");
}

/** Espacios colapsados y recortado: los nombres son para leer, no para comparar. */
export function normalizeName(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Un link hacia la misma página se muestra como ruta: el origen del proxy es ruido. */
export function displayHref(href: string, pageOrigin: string): string {
  return href.startsWith(`${pageOrigin}/`) ? href.slice(pageOrigin.length) : href;
}

/**
 * `Control+Shift+a` → la tecla y sus modificadores. Acepta los nombres de Playwright
 * (`Meta`, `ControlOrMeta`) porque son los que un agente va a escribir.
 */
export function parseKeyCombo(combo: string): {
  key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
} {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  // `+` sola, o `Control++`: la última parte vacía era la tecla `+`.
  const key = combo.endsWith("++") || combo === "+" ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key,
    ctrlKey: mods.has("control") || mods.has("ctrl") || mods.has("controlormeta"),
    shiftKey: mods.has("shift"),
    altKey: mods.has("alt") || mods.has("option"),
    metaKey: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

/** Cómo se parsea un `target`: un ref de snapshot, un texto visible, o un selector CSS. */
export type TargetSpec =
  | { kind: "ref"; ref: string }
  | { kind: "text"; text: string }
  | { kind: "css"; selector: string };

export function parseTarget(target: string): TargetSpec {
  const t = target.trim();
  if (/^e\d+$/.test(t)) return { kind: "ref", ref: t };
  const text = /^text[=:](.+)$/s.exec(t);
  if (text) return { kind: "text", text: text[1].trim().replace(/^["'](.*)["']$/s, "$1") };
  return { kind: "css", selector: t };
}
