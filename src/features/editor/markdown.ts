/**
 * Lo que la vista previa de Markdown necesita saber sin renderizar nada: qué archivos la
 * ofrecen, a dónde lleva cada enlace y cómo se llama cada título. Todo puro, para poder
 * probarlo sin DOM.
 */

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn", "mdx"]);

export function isMarkdownPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

const PREVIEW_KEY = "cc-markdown-preview";

/** Si el próximo Markdown que se abra arranca en vista previa: la última forma que eligió
 *  el usuario. Quien lee documentos los quiere leer; quien los escribe, editar. */
export function prefersMarkdownPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberMarkdownPreview(preview: boolean): void {
  try {
    localStorage.setItem(PREVIEW_KEY, preview ? "1" : "0");
  } catch {
    /* sin localStorage se arranca siempre en código, que es lo mismo que la primera vez */
  }
}

/** A dónde lleva un enlace del documento. */
export type DocLink =
  | { kind: "anchor"; id: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "none" };

/**
 * Clasifica un `href` de un Markdown abierto en `filePath`.
 *
 * Una ruta relativa es relativa a la carpeta del archivo, como en GitHub; una que empieza
 * con `/`, a la raíz del workspace (`root`), que es lo más parecido a la raíz del repo que
 * hay. El `#fragmento` de un enlace a otro archivo se descarta: abrir el archivo ya es
 * llegar.
 */
export function classifyDocLink(href: string | undefined, filePath: string, root: string): DocLink {
  const target = href?.trim();
  if (!target) return { kind: "none" };
  if (target.startsWith("#")) {
    const id = safeDecode(target.slice(1));
    return id ? { kind: "anchor", id } : { kind: "none" };
  }
  if (target.startsWith("//")) return { kind: "url", url: `https:${target}` };
  // Un esquema de URL. Una unidad de Windows (`C:\…`) también tiene la forma `letra:`, pero
  // un esquema de una sola letra no existe.
  const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(target);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    return name === "http" || name === "https" || name === "mailto"
      ? { kind: "url", url: target }
      : { kind: "none" };
  }
  const path = target.split(/[?#]/)[0];
  if (!path) return { kind: "none" };
  return { kind: "file", path: resolveDocPath(filePath, path, root) };
}

/** Si una imagen viene de internet. Las locales se leen del disco; estas, solo si se piden. */
export function isRemoteSource(src: string): boolean {
  return /^(https?:)?\/\//i.test(src.trim());
}

/**
 * Resuelve `target` contra el archivo `filePath`, o contra `root` si empieza con `/`.
 * Conserva el estilo de la ruta de origen: con `\` en Windows, con `/` en el resto.
 */
export function resolveDocPath(filePath: string, target: string, root: string): string {
  const windows = /^[a-z]:[\\/]/i.test(filePath) || (filePath.includes("\\") && !filePath.includes("/"));
  const clean = safeDecode(target).replace(/\\/g, "/");
  const base = clean.startsWith("/") ? root : parentOf(filePath);

  const [prefix, ...baseParts] = splitPath(base);
  const parts: string[] = baseParts;
  for (const segment of clean.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const joined = prefix + parts.join("/");
  return windows ? joined.replace(/\//g, "\\") : joined;
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut <= 0 ? normalized.slice(0, cut + 1) : normalized.slice(0, cut);
}

/** Separa el prefijo absoluto (`/`, `C:/`) de los segmentos. */
function splitPath(path: string): string[] {
  const normalized = path.replace(/\\/g, "/");
  const drive = /^[a-z]:\//i.exec(normalized);
  const prefix = drive ? drive[0] : normalized.startsWith("/") ? "/" : "";
  return [prefix, ...normalized.slice(prefix.length).split("/").filter(Boolean)];
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Los ids de los títulos, como los arma GitHub: en minúsculas, sin puntuación ni emoji,
 * con guiones por espacios, y `-1`, `-2` para los repetidos. Así un `[ver](#instalación)`
 * escrito pensando en GitHub también funciona acá.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/**
 * Los campos de un frontmatter, para mostrarlos como tabla. No es un parser de YAML: toma
 * las claves de primer nivel (`clave: valor`), y lo que está indentado o es una lista va
 * como parte del valor de la clave anterior, tal cual.
 */
export function parseFrontmatter(raw: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const line of raw.split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (field) {
      entries.push([field[1], unquote(field[2])]);
    } else if (entries.length > 0 && line.trim()) {
      const last = entries[entries.length - 1];
      last[1] = last[1] ? `${last[1]}\n${line}` : line;
    }
  }
  return entries;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? quoted[2] : trimmed;
}
