import { activePageOf, addNode, centerOn, workspaceOf } from "@/features/canvas/actions";
import { findPage } from "@/features/canvas/model";
import { useCanvasStore, type CanvasActor } from "@/features/canvas/store";
import { freeProjectPath, resolveInProject } from "@/features/diagram/paths";
import { trashPaths } from "@/features/explorer/ipc";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { relativeTo } from "@/features/tabs/viewTabs";

import { deckDirOf, findSlide, joinPath, moveSlide, newSlideName, parseSize, type Deck } from "./deck";
import { deckPdfPath, exportDeckPdf } from "./export";
import { createDeck, goTo, loadDeck, present, saveDeck, slideText, writeSlide, writeTheme } from "./store";

/**
 * Un agente armando una presentación, desde el MCP (`slides_*` y `slide_write`, ver
 * `ipc/mcp.rs`). Llega por el canal del canvas: la presentación se ve en su nodo o su tab,
 * y la vista va a cada hoja mientras el agente la escribe.
 */

type Request = Record<string, unknown> & { op: string };

const str = (r: Record<string, unknown>, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: Record<string, unknown>, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);

const SLIDES_DIR = "docs/slides";

/** Un texto corto de lo que dice una hoja, para que el agente sepa cuál es cuál. */
function excerpt(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

export async function runSlidesRequest(cwd: string, request: Request, actor: CanvasActor | null): Promise<string> {
  const shown = (p: string) => relativeTo(p, cwd);
  /** La carpeta de la presentación a partir de lo que mandó el agente. */
  const dirOf = (): string => {
    const path = str(request, "path");
    if (!path) throw new Error("Falta 'path': la carpeta .slides de la presentación");
    const dir = deckDirOf(resolveInProject(cwd, path));
    if (!dir) throw new Error(`'${path}' no es una presentación: tiene que ser una carpeta que termine en .slides`);
    return dir;
  };
  const summary = (deck: Deck) => `${deck.slides.length} slide(s), ${deck.size.w}×${deck.size.h}`;

  switch (request.op) {
    case "slides.create": {
      const title = str(request, "title") ?? "Presentación";
      const pathArg = str(request, "path");
      const dir = pathArg
        ? resolveInProject(cwd, /\.slides[\\/]*$/i.test(pathArg) ? pathArg : `${pathArg}.slides`)
        : await freeProjectPath(cwd, SLIDES_DIR, title, ".slides");
      const deck = await createDeck(dir, title, parseSize(request.size ?? "16:9"), str(request, "theme"));
      const workspace = workspaceOf(cwd);
      const show = str(request, "show") ?? (useCanvasStore.getState().canvasMode[workspace] ? "canvas" : "tab");
      if (show === "canvas") {
        const pageKey = str(request, "page");
        const page = pageKey ? findPage(useCanvasStore.getState().pages[workspace] ?? [], pageKey) : await activePageOf(workspace);
        if (!page) throw new Error(`No hay ninguna página '${pageKey}'`);
        const box = { x: num(request, "x"), y: num(request, "y"), w: num(request, "w"), h: num(request, "h"), near: str(request, "near") };
        const nodeId = addNode(workspace, page.id, { ...box, kind: "slides", ref: dir }, actor);
        centerOn(workspace, page.id, nodeId);
      } else if (show === "tab") {
        useViewTabsStore.getState().openFile(cwd, joinPath(dir, "deck.json"));
      }
      return `Created ${shown(dir)} (${summary(deck)}). Add slides with slide_write, one at a time: the user sees each one appear. `
        + "Style lives in theme.css (pass `theme` to slide_write to change it); slides are HTML bodies sized to the deck.";
    }

    case "slide.write": {
      const dir = dirOf();
      const deck = await loadDeck(dir);
      const theme = str(request, "theme");
      const content = str(request, "content");
      if (theme !== undefined) await writeTheme(dir, theme, actor);
      if (content === undefined) {
        if (theme !== undefined) return `Updated the theme of ${shown(dir)}.`;
        throw new Error("Falta 'content': el HTML de la hoja");
      }
      const key = request.slide;
      let name: string;
      let insertAt: number | undefined;
      if (key === undefined || key === "new") {
        name = newSlideName(deck, str(request, "title") ?? "hoja");
        const position = num(request, "position");
        insertAt = position === undefined ? undefined : position - 1;
      } else {
        name = deck.slides[findSlide(deck, key as string | number)]!;
      }
      const index = await writeSlide(dir, name, content, { insertAt, title: str(request, "title"), actor });
      return `Wrote slide ${index + 1} (${name}) of ${shown(dir)}; the user is looking at it.`;
    }

    case "slides.edit": {
      const dir = dirOf();
      let deck = await loadDeck(dir);
      const removed: string[] = [];
      for (const [i, raw] of (Array.isArray(request.ops) ? request.ops : []).entries()) {
        const op = (raw ?? {}) as Record<string, unknown>;
        if (op.slide === undefined) throw new Error(`La operación ${i + 1} necesita 'slide'`);
        const index = findSlide(deck, op.slide as string | number);
        if (op.op === "move") {
          const to = typeof op.to === "number" ? op.to - 1 : NaN;
          if (!Number.isFinite(to)) throw new Error(`La operación ${i + 1} (move) necesita 'to' (1 = primera)`);
          deck = moveSlide(deck, index, to);
        } else if (op.op === "remove") {
          removed.push(deck.slides[index]!);
          deck = { ...deck, slides: deck.slides.filter((_, j) => j !== index) };
        } else {
          throw new Error(`Operación ${i + 1}: '${String(op.op)}' no existe. Son move y remove`);
        }
      }
      const title = str(request, "title");
      const size = request.size !== undefined ? parseSize(request.size) : undefined;
      const before = await loadDeck(dir);
      const next = { ...deck, ...(title ? { title } : {}), ...(size ? { size } : {}) };
      await saveDeck(dir, next, !!size && (size.w !== before.size.w || size.h !== before.size.h));
      // Las hojas quitadas van a la papelera, no se borran: se pueden recuperar.
      if (removed.length) await trashPaths(removed.map((n) => joinPath(dir, n))).catch(console.error);
      return `Updated ${shown(dir)}: ${summary(next)}.`;
    }

    case "slides.read": {
      const dir = dirOf();
      const deck = await loadDeck(dir);
      const lines = await Promise.all(deck.slides.map(async (name, i) => `${i + 1}. ${name}: ${excerpt(await slideText(dir, name))}`));
      return [`"${deck.title}" ${shown(dir)} — ${summary(deck)}.`, ...lines].join("\n");
    }

    case "slides.goto": {
      const dir = dirOf();
      const deck = await loadDeck(dir);
      if (request.slide !== undefined) goTo(dir, findSlide(deck, request.slide as string | number));
      if (request.present === true) present(dir);
      if (request.present === false) present(null);
      return request.present === true ? `Presenting ${shown(dir)} full screen.` : `Showing ${shown(dir)}.`;
    }

    case "slides.export": {
      const dir = dirOf();
      const outArg = str(request, "out");
      const out = await exportDeckPdf(dir, outArg ? resolveInProject(cwd, outArg) : deckPdfPath(dir));
      return `Exported to ${shown(out)}.`;
    }

    default:
      throw new Error(`Las presentaciones no saben hacer '${request.op}'`);
  }
}
