import { create } from "zustand";

import { markPresence, type CanvasActor } from "@/features/canvas/store";
import { writeNewFile } from "@/features/diagram/files";
import { fileStat, readFile } from "@/features/editor/ipc";
import { resolveDocPath } from "@/features/editor/markdown";

import {
  DECK_FILE, DEFAULT_THEME, composeSlide, deckCss, inlineRefs, joinPath, parseDeck, relativeRefs, runnerHtml,
  safeSlideName, serializeDeck, slideDocument, type Deck,
} from "./deck";

/**
 * Las presentaciones abiertas, por carpeta: su `deck.json` al día con el disco, la hoja que
 * se está mirando y si se está presentando o exportando.
 *
 * Como los documentos, el disco es la verdad y se relee cada segundo mientras alguien mira:
 * lo que escribe un agente aparece enseguida. Lo que escribe con `slide_write` además lleva
 * la vista a esa hoja, así se ve cómo se va armando.
 */

interface SlidesState {
  decks: Record<string, { deck: Deck; mtime: number } | { error: string }>;
  /** La hoja que se mira en cada presentación (0 = la primera). */
  current: Record<string, number>;
  /** La carpeta que se está presentando a pantalla completa. */
  presenting: string | null;
  /** La exportación a PDF en curso: muestra cada hoja para capturarla. */
  exporting: { dir: string; index: number; total: number } | null;
}

export const useSlidesStore = create<SlidesState>(() => ({ decks: {}, current: {}, presenting: null, exporting: null }));

export const slidesPresenceKey = (dir: string) => `${dir}#slides`;

const WATCH_MS = 1000;

async function readText(path: string): Promise<{ text: string; mtime: number } | null> {
  const stat = await fileStat(path).catch(() => null);
  if (!stat) return null;
  const file = await readFile(path);
  return file.kind === "text" ? { text: file.content, mtime: file.mtime } : null;
}

async function refreshDeck(dir: string) {
  const path = joinPath(dir, DECK_FILE);
  const current = useSlidesStore.getState().decks[dir];
  const stat = await fileStat(path).catch(() => null);
  if (current && "mtime" in current && stat && stat.mtime === current.mtime) return;
  try {
    const file = await readText(path);
    if (!file) throw new Error(`No hay una presentación en ${dir}`);
    const deck = parseDeck(file.text);
    useSlidesStore.setState((s) => {
      const max = Math.max(0, deck.slides.length - 1);
      return {
        decks: { ...s.decks, [dir]: { deck, mtime: file.mtime } },
        current: { ...s.current, [dir]: Math.min(s.current[dir] ?? 0, max) },
      };
    });
  } catch (e) {
    useSlidesStore.setState((s) => ({ decks: { ...s.decks, [dir]: { error: e instanceof Error ? e.message : String(e) } } }));
  }
}

const watchers = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();

export function watchDeck(dir: string): () => void {
  const w = watchers.get(dir);
  if (w) w.count++;
  else {
    refreshDeck(dir).catch(console.error);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshDeck(dir).catch(console.error);
    }, WATCH_MS);
    watchers.set(dir, { count: 1, timer });
  }
  return () => {
    const x = watchers.get(dir);
    if (!x) return;
    if (--x.count <= 0) {
      clearInterval(x.timer);
      watchers.delete(dir);
    }
  };
}

export async function loadDeck(dir: string): Promise<Deck> {
  await refreshDeck(dir);
  const entry = useSlidesStore.getState().decks[dir];
  if (!entry || "error" in entry) throw new Error(entry && "error" in entry ? entry.error : `No hay una presentación en ${dir}`);
  return entry.deck;
}

export function goTo(dir: string, index: number) {
  useSlidesStore.setState((s) => {
    const entry = s.decks[dir];
    const total = entry && "deck" in entry ? entry.deck.slides.length : index + 1;
    return { current: { ...s.current, [dir]: Math.max(0, Math.min(total - 1, index)) } };
  });
}

export const present = (dir: string | null) => useSlidesStore.setState({ presenting: dir });

// ── Componer una hoja para mostrarla ────────────────────────────────

const composed = new Map<string, { key: string; html: string }>();

const toDataUrl = async (path: string): Promise<string | null> => {
  const file = await readFile(path).catch(() => null);
  if (!file) return null;
  if (file.kind === "image") return file.dataUrl;
  if (file.kind === "text" && /\.svg$/i.test(path)) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.content)}`;
  return null;
};

/**
 * La hoja lista para un iframe aislado: sus CSS y sus imágenes adentro. Se recompone solo si
 * cambió la hoja, el tema o el tamaño; `null` si la hoja no existe (todavía).
 */
export async function composedSlide(dir: string, name: string): Promise<string | null> {
  const [slide, theme, size] = await Promise.all([
    readText(joinPath(dir, name)),
    readText(joinPath(dir, "theme.css")),
    readText(joinPath(dir, "deck.css")),
  ]);
  if (!slide) return null;
  const key = `${slide.mtime}:${theme?.mtime ?? 0}:${size?.mtime ?? 0}`;
  const path = joinPath(dir, name);
  const cached = composed.get(path);
  if (cached?.key === key) return cached.html;
  const refs = relativeRefs(slide.text);
  const resolved = new Map<string, string>();
  await Promise.all(refs.map(async (ref) => {
    const data = await toDataUrl(resolveDocPath(path, ref.split(/[?#]/)[0]!, dir));
    if (data) resolved.set(ref, data);
  }));
  const html = composeSlide(inlineRefs(slide.text, resolved), size?.text ?? "", theme?.text ?? "");
  composed.set(path, { key, html });
  return html;
}

// ── Escribir ────────────────────────────────────────────────────────

async function writeDeck(dir: string, deck: Deck) {
  await writeNewFile(joinPath(dir, DECK_FILE), { text: serializeDeck(deck) });
  // El visor autónomo y el CSS del tamaño salen del deck: se regeneran con él.
  await writeNewFile(joinPath(dir, "index.html"), { text: runnerHtml(deck) });
  await refreshDeck(dir);
}

/** Crea la carpeta de una presentación vacía. Falla si ya existe: no se pisa nada. */
export async function createDeck(dir: string, title: string, size: Deck["size"], theme?: string): Promise<Deck> {
  if (await fileStat(joinPath(dir, DECK_FILE)).catch(() => null)) throw new Error(`Ya hay una presentación en ${dir}`);
  const deck: Deck = { title, size, slides: [] };
  await writeNewFile(joinPath(dir, "deck.css"), { text: deckCss(size) });
  await writeNewFile(joinPath(dir, "theme.css"), { text: theme ?? DEFAULT_THEME });
  await writeDeck(dir, deck);
  return deck;
}

export async function saveDeck(dir: string, next: Deck, sizeChanged = false) {
  if (sizeChanged) await writeNewFile(joinPath(dir, "deck.css"), { text: deckCss(next.size) });
  await writeDeck(dir, next);
}

/**
 * Escribe una hoja (nueva o existente) y lleva la vista a ella, firmada por quien la
 * escribió. `insertAt` (0 = primera) solo para una nueva; sin él va al final.
 */
export async function writeSlide(dir: string, name: string, content: string, opts: { insertAt?: number; title?: string; actor?: CanvasActor | null } = {}): Promise<number> {
  safeSlideName(name);
  const deck = await loadDeck(dir);
  await writeNewFile(joinPath(dir, name), { text: slideDocument(content, opts.title ?? deck.title) });
  let index = deck.slides.indexOf(name);
  if (index < 0) {
    const slides = [...deck.slides];
    index = opts.insertAt === undefined ? slides.length : Math.max(0, Math.min(slides.length, opts.insertAt));
    slides.splice(index, 0, name);
    await saveDeck(dir, { ...deck, slides });
  }
  goTo(dir, index);
  if (opts.actor) markPresence([slidesPresenceKey(dir)], opts.actor);
  return index;
}

export async function writeTheme(dir: string, css: string, actor: CanvasActor | null = null) {
  await writeNewFile(joinPath(dir, "theme.css"), { text: css.endsWith("\n") ? css : `${css}\n` });
  if (actor) markPresence([slidesPresenceKey(dir)], actor);
}

// ── Exportar ────────────────────────────────────────────────────────

type Capture = (index: number) => Promise<Uint8Array>;
let exportJob: { capture: Capture | null; resolve: (bytes: Uint8Array[]) => void; reject: (e: Error) => void } | null = null;

/** Lo llama la capa que muestra las hojas al exportar (`SlidesOverlay`), una vez montada. */
export function registerCapture(capture: Capture | null) {
  if (exportJob) exportJob.capture = capture;
}

/**
 * Cada hoja como PNG, en orden. Se muestran una por una a pantalla completa y se capturan
 * con la foto nativa del webview (ver `browser/annotate/capture.ts`): un iframe aislado no se
 * puede dibujar en un canvas de otra forma. Por eso la ventana tiene que estar a la vista.
 */
export async function captureSlides(dir: string): Promise<Uint8Array[]> {
  const deck = await loadDeck(dir);
  if (deck.slides.length === 0) throw new Error("La presentación no tiene hojas");
  if (useSlidesStore.getState().exporting) throw new Error("Ya se está exportando una presentación");
  if (document.visibilityState !== "visible") throw new Error("La ventana de Control Code tiene que estar a la vista para exportar la presentación");
  const done = new Promise<Uint8Array[]>((resolve, reject) => {
    exportJob = { capture: null, resolve, reject };
  });
  useSlidesStore.setState({ exporting: { dir, index: 0, total: deck.slides.length } });
  // La capa se monta y avisa con `registerCapture`; después se recorre hoja por hoja.
  (async () => {
    for (let wait = 0; !exportJob?.capture && wait < 100; wait++) await new Promise((r) => setTimeout(r, 30));
    const capture = exportJob?.capture;
    if (!capture) throw new Error("No se pudo mostrar la presentación para exportarla");
    const pages: Uint8Array[] = [];
    for (let i = 0; i < deck.slides.length; i++) {
      if (!exportJob) throw new Error("Se canceló la exportación");
      useSlidesStore.setState({ exporting: { dir, index: i, total: deck.slides.length } });
      pages.push(await capture(i));
    }
    return pages;
  })()
    .then((pages) => exportJob?.resolve(pages), (e: unknown) => exportJob?.reject(e instanceof Error ? e : new Error(String(e))))
    .finally(() => {
      exportJob = null;
      useSlidesStore.setState({ exporting: null });
    });
  return done;
}

/** Cancelar la exportación (Esc): falla con un error que lo dice. */
export function cancelExport() {
  exportJob?.reject(new Error("Se canceló la exportación"));
  exportJob = null;
  useSlidesStore.setState({ exporting: null });
}

/** Lee el texto de una hoja (para `slides_read`). */
export async function slideText(dir: string, name: string): Promise<string> {
  return (await readText(joinPath(dir, name)))?.text ?? "";
}
