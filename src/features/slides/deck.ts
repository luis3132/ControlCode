/**
 * Una presentación: una carpeta del proyecto con un HTML por hoja.
 *
 * ```
 * demo.slides/
 *   deck.json      { title, size: {w, h}, slides: ["01-portada.html", …] }
 *   deck.css       el tamaño de la hoja (lo genera la app al cambiarlo)
 *   theme.css      el estilo, compartido por todas las hojas
 *   01-portada.html
 *   assets/        imágenes: diagramas, capturas del navegador
 *   index.html     para verla en cualquier navegador, fuera de la app (lo genera la app)
 * ```
 *
 * Cada hoja es un documento HTML completo que enlaza `deck.css` y `theme.css`: abierta sola
 * en un navegador se ve igual que en la app. Un agente escribe solo el cuerpo y la app la
 * envuelve (`slideDocument`).
 *
 * Puro: se prueba en Node.
 */

export interface DeckSize {
  w: number;
  h: number;
}

export interface Deck {
  title: string;
  size: DeckSize;
  slides: string[];
}

export const SIZE_PRESETS: Record<string, DeckSize> = {
  "16:9": { w: 1920, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  a4: { w: 794, h: 1123 },
  "a4-landscape": { w: 1123, h: 794 },
};

export const DECK_FILE = "deck.json";

/** La carpeta de una presentación, a partir de su carpeta o de cualquier archivo de adentro. */
export function deckDirOf(path: string): string | null {
  const match = /^(.*?\.slides)(?:[\\/].*)?$/i.exec(path.replace(/[\\/]+$/, ""));
  return match ? match[1]! : null;
}

export const isDeckFile = (path: string) => /\.slides[\\/]deck\.json$/i.test(path);

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function parseSize(input: unknown): DeckSize {
  if (typeof input === "string") {
    const preset = SIZE_PRESETS[input.toLowerCase()];
    if (preset) return preset;
    const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/.exec(input.trim());
    if (match) return clampSize({ w: Number(match[1]), h: Number(match[2]) });
    throw new Error(`Tamaño desconocido '${input}'. Usá ${Object.keys(SIZE_PRESETS).join(", ")} o ANCHOxALTO`);
  }
  const s = input as Partial<DeckSize> | null;
  if (s && typeof s.w === "number" && typeof s.h === "number") return clampSize({ w: s.w, h: s.h });
  return SIZE_PRESETS["16:9"]!;
}

function clampSize(s: DeckSize): DeckSize {
  return { w: Math.max(320, Math.min(4000, Math.round(s.w))), h: Math.max(240, Math.min(4000, Math.round(s.h))) };
}

/** Un nombre de hoja que se puede usar: solo un archivo `.html` de esa carpeta. */
export function safeSlideName(name: string): string {
  if (!/^[\w.-]+\.html$/i.test(name) || name.startsWith(".") || name.toLowerCase() === "index.html") {
    throw new Error(`'${name}' no sirve como nombre de hoja: letras, números, - y _, terminado en .html (y no index.html)`);
  }
  return name;
}

export function parseDeck(text: string): Deck {
  let raw: { title?: unknown; size?: unknown; slides?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error("deck.json no es JSON válido");
  }
  const slides = (Array.isArray(raw.slides) ? raw.slides : []).filter((s): s is string => {
    if (typeof s !== "string") return false;
    try {
      safeSlideName(s);
      return true;
    } catch {
      return false;
    }
  });
  return {
    title: typeof raw.title === "string" ? raw.title : "Presentación",
    size: parseSize(raw.size),
    slides: [...new Set(slides)],
  };
}

export const serializeDeck = (deck: Deck) => `${JSON.stringify(deck, null, 2)}\n`;

/** Una hoja por nombre, o por número (1 = la primera). */
export function findSlide(deck: Deck, key: string | number): number {
  if (typeof key === "number" || /^\d+$/.test(String(key))) {
    const n = Number(key);
    if (n < 1 || n > deck.slides.length) throw new Error(`No hay hoja ${n}: la presentación tiene ${deck.slides.length}`);
    return n - 1;
  }
  const name = String(key);
  const i = deck.slides.findIndex((s) => s === name || s === `${name}.html` || s.replace(/^\d+-/, "").replace(/\.html$/, "") === name);
  if (i < 0) throw new Error(`No hay ninguna hoja '${name}'. Hojas: ${deck.slides.join(", ") || "ninguna"}`);
  return i;
}

/** "Portada" → `03-portada.html`, con el primer número libre. */
export function newSlideName(deck: Deck, title: string): string {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "hoja";
  const used = new Set(deck.slides.map((s) => Number(/^(\d+)-/.exec(s)?.[1] ?? 0)));
  let n = deck.slides.length + 1;
  while (used.has(n)) n++;
  let name = `${String(n).padStart(2, "0")}-${slug}.html`;
  for (let i = 2; deck.slides.includes(name); i++) name = `${String(n).padStart(2, "0")}-${slug}-${i}.html`;
  return name;
}

export function moveSlide(deck: Deck, from: number, to: number): Deck {
  const slides = [...deck.slides];
  const [item] = slides.splice(from, 1);
  slides.splice(Math.max(0, Math.min(slides.length, to)), 0, item!);
  return { ...deck, slides };
}

/** El CSS del tamaño: la hoja mide exactamente eso, y la letra base es proporcional al alto,
 *  así el mismo tema sirve en 16:9 y en A4. */
export function deckCss(size: DeckSize): string {
  return `/* Lo genera Control Code a partir de deck.json: no lo edites, cambiá el tamaño ahí. */
html, body {
  margin: 0;
  width: ${size.w}px;
  height: ${size.h}px;
  overflow: hidden;
}
html {
  font-size: ${Math.round(size.h / 36)}px;
}
*, *::before, *::after {
  box-sizing: border-box;
}
`;
}

/** Los colores de cada tema prearmado; el resto del CSS es el mismo. */
export const THEME_COLORS: Record<string, { bg: string; ink: string; muted: string; accent: string; soft: string }> = {
  light: { bg: "#ffffff", ink: "#0f172a", muted: "#475569", accent: "#2563eb", soft: "#eff6ff" },
  dark: { bg: "#111827", ink: "#f3f4f6", muted: "#9ca3af", accent: "#60a5fa", soft: "#1f2937" },
  ocean: { bg: "#0b3b5b", ink: "#f0f9ff", muted: "#bae6fd", accent: "#fbbf24", soft: "#0e4a70" },
  warm: { bg: "#fffbf5", ink: "#292524", muted: "#78716c", accent: "#c2410c", soft: "#ffedd5" },
  mono: { bg: "#fafafa", ink: "#171717", muted: "#737373", accent: "#171717", soft: "#e5e5e5" },
};

export const THEMES = Object.keys(THEME_COLORS);

/** Un tema prearmado completo. */
export function themeCss(name: string): string {
  const c = THEME_COLORS[name] ?? THEME_COLORS.light!;
  return DEFAULT_THEME.replace(
    /:root \{[\s\S]*?\}/,
    `:root {\n  --bg: ${c.bg};\n  --ink: ${c.ink};\n  --muted: ${c.muted};\n  --accent: ${c.accent};\n  --soft: ${c.soft};\n}`
  );
}

export const DEFAULT_THEME = `/* El estilo de todas las hojas. Cambialo con libertad. */
:root {
  --bg: #ffffff;
  --ink: #0f172a;
  --muted: #475569;
  --accent: #2563eb;
  --soft: #eff6ff;
}
body {
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.35;
  padding: 3.2rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
h1 { font-size: 2.6rem; line-height: 1.1; margin: 0; letter-spacing: -0.02em; }
h2 { font-size: 1.8rem; margin: 0 0 0.4rem; color: var(--accent); }
h3 { font-size: 1.25rem; margin: 0; }
p, li { font-size: 1.05rem; margin: 0; }
ul, ol { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 0.45rem; }
small, .muted { color: var(--muted); }
img { max-width: 100%; max-height: 70vh; object-fit: contain; }
code { font-family: ui-monospace, "JetBrains Mono", monospace; background: var(--soft); padding: 0.05em 0.3em; border-radius: 0.2em; }
.title { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 1rem; }
.title h1 { font-size: 3.4rem; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: start; }
.section { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.section h1 { color: var(--accent); }
blockquote { flex: 1; margin: 0; display: flex; flex-direction: column; justify-content: center; gap: 1rem; }
blockquote p { font-size: 1.9rem; line-height: 1.3; }
cite { color: var(--muted); font-style: normal; }
.picture { flex: 1; min-height: 0; margin: 0; display: flex; align-items: center; justify-content: center; }
.picture img { max-height: 100%; }
.placeholder { width: 70%; height: 70%; border: 0.1rem dashed var(--muted); border-radius: 0.5rem; display: flex; align-items: center; justify-content: center; color: var(--muted); }
`;

/** Una hoja como documento completo. Si el contenido ya es un documento, se le agregan los
 *  dos CSS que falten; si es un fragmento, se envuelve. */
export function slideDocument(content: string, title = ""): string {
  const links = '<link rel="stylesheet" href="deck.css">\n<link rel="stylesheet" href="theme.css">';
  if (/<html[\s>]/i.test(content)) {
    if (/href=["']theme\.css["']/i.test(content)) return content;
    return /<head[^>]*>/i.test(content) ? content.replace(/<head[^>]*>/i, (m) => `${m}\n${links}`) : content;
  }
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc}</title>
${links}
</head>
<body>
${content.trim()}
</body>
</html>
`;
}

/** El cuerpo de una hoja: lo que va entre `<body>` y `</body>`, o todo si es un fragmento. */
export function bodyOf(html: string): string {
  return /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1]?.trim() ?? html.trim();
}

/** La hoja con otro cuerpo, sin tocar su `<head>` (sus CSS, su título, lo que haya puesto
 *  quien la escribió). */
export function replaceBody(html: string, body: string): string {
  if (!/<body[^>]*>[\s\S]*<\/body>/i.test(html)) return slideDocument(body);
  return html.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i, (_, open: string, close: string) => `${open}\n${body.trim()}\n${close}`);
}

/** Las imágenes que se metieron como `data:` para mostrar la hoja, devueltas a su ruta. */
export function restoreRefs(html: string, resolved: Map<string, string>): string {
  let out = html;
  for (const [ref, data] of resolved) out = out.split(data).join(ref);
  return out;
}

// ── Diseños de hoja ─────────────────────────────────────────────────

export type SlideLayout = "title" | "text" | "columns" | "image" | "quote" | "section";

export const SLIDE_LAYOUTS: SlideLayout[] = ["title", "text", "columns", "image", "quote", "section"];

/** Los textos de ejemplo de cada diseño, en el idioma de la interfaz (los pone quien llama). */
export interface LayoutTexts {
  title: string;
  subtitle: string;
  heading: string;
  point: (n: number) => string;
  quote: string;
  author: string;
  caption: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** El cuerpo de una hoja nueva con ese diseño, listo para escribirle encima. */
export function layoutBody(layout: SlideLayout, tx: LayoutTexts, image?: string): string {
  const points = [1, 2, 3].map((n) => `    <li>${esc(tx.point(n))}</li>`).join("\n");
  switch (layout) {
    case "title":
      return `<section class="title">\n  <h1>${esc(tx.title)}</h1>\n  <p class="muted">${esc(tx.subtitle)}</p>\n</section>`;
    case "text":
      return `<h2>${esc(tx.heading)}</h2>\n<ul>\n${points}\n</ul>`;
    case "columns":
      return `<h2>${esc(tx.heading)}</h2>\n<div class="cols">\n  <div>\n    <h3>${esc(tx.point(1))}</h3>\n    <p>${esc(tx.subtitle)}</p>\n  </div>\n  <div>\n    <h3>${esc(tx.point(2))}</h3>\n    <p>${esc(tx.subtitle)}</p>\n  </div>\n</div>`;
    case "image":
      return `<h2>${esc(tx.heading)}</h2>\n<figure class="picture">\n  ${image ? `<img src="${esc(image)}" alt="">` : `<div class="placeholder">${esc(tx.caption)}</div>`}\n</figure>`;
    case "quote":
      return `<blockquote>\n  <p>${esc(tx.quote)}</p>\n  <cite>${esc(tx.author)}</cite>\n</blockquote>`;
    case "section":
      return `<section class="section">\n  <h1>${esc(tx.heading)}</h1>\n</section>`;
  }
}

/** Lo que la app muestra de una hoja: con sus CSS adentro (un iframe aislado no puede leer
 *  archivos del disco) y sin scripts. */
export function composeSlide(html: string, deckCssText: string, themeCss: string): string {
  const inline = `<style>${deckCssText}</style><style>${themeCss}</style>`;
  const withoutLinks = html
    .replace(/<link[^>]+href=["'](?:deck|theme)\.css["'][^>]*>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  if (/<head[^>]*>/i.test(withoutLinks)) return withoutLinks.replace(/<head[^>]*>/i, (m) => `${m}${inline}`);
  return `<!doctype html><html><head><meta charset="utf-8">${inline}</head><body>${withoutLinks}</body></html>`;
}

/** Las referencias relativas de una hoja (src, href e `url()` de CSS) que hay que traer. */
export function relativeRefs(html: string): string[] {
  const refs = new Set<string>();
  const add = (ref: string) => {
    const clean = ref.trim().replace(/^["']|["']$/g, "");
    if (!clean || /^(?:[a-z]+:|\/\/|#|data:)/i.test(clean) || /^(?:deck|theme)\.css$/i.test(clean)) return;
    refs.add(clean);
  };
  for (const m of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]!);
  for (const m of html.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) add(m[1]!);
  return [...refs];
}

/** La hoja con cada referencia relativa cambiada por su contenido (`data:`). */
export function inlineRefs(html: string, resolved: Map<string, string>): string {
  let out = html;
  for (const [ref, data] of resolved) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(["'(\\s])${escaped}(["')\\s])`, "g"), `$1${data}$2`);
  }
  return out;
}

/** `index.html`: la presentación en cualquier navegador, sin la app. Carga solo la hoja
 *  actual y sus vecinas, y se maneja con el teclado. */
export function runnerHtml(deck: Deck): string {
  const data = JSON.stringify({ size: deck.size, slides: deck.slides }).replace(/</g, "\\u003c");
  const esc = deck.title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc}</title>
<!-- Lo genera Control Code a partir de deck.json. -->
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  #stage { position: absolute; transform-origin: 0 0; }
  #stage iframe { position: absolute; inset: 0; border: 0; background: #fff; visibility: hidden; }
  #stage iframe.on { visibility: visible; }
  #count { position: fixed; right: 16px; bottom: 12px; color: #aaa; font: 13px system-ui, sans-serif; }
</style>
</head>
<body>
<div id="stage"></div>
<div id="count"></div>
<script>
const deck = ${data};
const stage = document.getElementById("stage");
const count = document.getElementById("count");
stage.style.width = deck.size.w + "px";
stage.style.height = deck.size.h + "px";
const frames = new Map();
let current = Math.max(0, Math.min(deck.slides.length - 1, (parseInt(location.hash.slice(1), 10) || 1) - 1));
function fit() {
  const s = Math.min(innerWidth / deck.size.w, innerHeight / deck.size.h);
  stage.style.transform = "translate(" + (innerWidth - deck.size.w * s) / 2 + "px," + (innerHeight - deck.size.h * s) / 2 + "px) scale(" + s + ")";
}
function show(i) {
  current = Math.max(0, Math.min(deck.slides.length - 1, i));
  // Montadas: la actual y sus vecinas. Las demás se descargan.
  const keep = new Set([current - 1, current, current + 1]);
  for (const [n, f] of frames) if (!keep.has(n)) { f.remove(); frames.delete(n); }
  for (const n of keep) {
    if (n < 0 || n >= deck.slides.length || frames.has(n)) continue;
    const f = document.createElement("iframe");
    f.width = deck.size.w; f.height = deck.size.h;
    f.src = deck.slides[n];
    stage.appendChild(f);
    frames.set(n, f);
  }
  for (const [n, f] of frames) f.className = n === current ? "on" : "";
  count.textContent = (current + 1) + " / " + deck.slides.length;
  history.replaceState(null, "", "#" + (current + 1));
}
addEventListener("keydown", (e) => {
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) show(current + 1);
  else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) show(current - 1);
  else if (e.key === "Home") show(0);
  else if (e.key === "End") show(deck.slides.length - 1);
  else if (e.key === "f") document.documentElement.requestFullscreen?.();
  else return;
  e.preventDefault();
});
addEventListener("click", () => show(current + 1));
addEventListener("resize", fit);
fit();
show(current);
</script>
</body>
</html>
`;
}
