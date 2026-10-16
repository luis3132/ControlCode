import { activePageOf, addNode, centerOn, workspaceOf } from "@/features/canvas/actions";
import { findPage } from "@/features/canvas/model";
import { useCanvasStore, type CanvasActor } from "@/features/canvas/store";
import { runBrowserRequest } from "@/features/browser/agentBridge";
import { readFile } from "@/features/editor/ipc";
import { exportDiagram } from "@/features/diagram/export";
import { writeNewFile } from "@/features/diagram/files";
import { freeProjectPath, resolveInProject, slugify } from "@/features/diagram/paths";
import { loadDiagram } from "@/features/diagram/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { relativeTo, type ViewOwner } from "@/features/tabs/viewTabs";

import { DOC_EDIT_MODES, relativeLink, type DocEditMode } from "./edit";
import { docPdfPath, exportDocPdf } from "./export";
import { createDoc, editDoc, isDocPath } from "./store";

/**
 * Un agente escribiendo documentos, desde el MCP (`doc_*` y `asset_capture`, ver
 * `ipc/mcp.rs`). Llega por el canal del canvas (`canvas.run`): el documento se ve en vivo en
 * su nodo o su tab, firmado con el color del agente.
 */

type Request = Record<string, unknown> & { op: string };

const str = (r: Record<string, unknown>, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: Record<string, unknown>, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);

/** Dónde van los documentos nuevos y las imágenes que se les ponen. */
export const DOCS_DIR = "docs";
export const ASSETS_DIR = "docs/assets";

export async function runDocRequest(cwd: string, request: Request, owner: ViewOwner | null, actor: CanvasActor | null): Promise<string> {
  const resolve = (p: string) => resolveInProject(cwd, p);
  const shown = (p: string) => relativeTo(p, cwd);
  const pathArg = str(request, "path");

  switch (request.op) {
    case "doc.create": {
      const title = str(request, "title") ?? "Documento";
      const path = pathArg ? resolve(isDocPath(pathArg) ? pathArg : `${pathArg}.md`) : await freeProjectPath(cwd, DOCS_DIR, title, ".md");
      await createDoc(path, str(request, "content") ?? `# ${title}\n`);
      const workspace = workspaceOf(cwd);
      const show = str(request, "show") ?? (useCanvasStore.getState().canvasMode[workspace] ? "canvas" : "tab");
      if (show === "canvas") {
        const pageKey = str(request, "page");
        const page = pageKey ? findPage(useCanvasStore.getState().pages[workspace] ?? [], pageKey) : await activePageOf(workspace);
        if (!page) throw new Error(`No hay ninguna página '${pageKey}'`);
        const box = { x: num(request, "x"), y: num(request, "y"), w: num(request, "w"), h: num(request, "h"), near: str(request, "near") };
        const nodeId = addNode(workspace, page.id, { ...box, kind: "doc", ref: path }, actor);
        centerOn(workspace, page.id, nodeId);
        return `Created ${shown(path)}, on canvas page "${page.name}" as node ${nodeId}. Write it with doc_write: the user sees it grow live.`;
      }
      if (show === "tab") {
        const views = useViewTabsStore.getState();
        views.openFile(cwd, path);
        // Abierto para leerlo, no para editarlo: en vista previa.
        const view = useViewTabsStore.getState().views.find((v) => v.kind === "file" && v.path === path);
        if (view) views.updateView(view.id, { preview: true });
      }
      return `Created ${shown(path)}${show === "tab" ? ", open in a tab" : ""}. Write it with doc_write: the user sees it grow live.`;
    }

    case "doc.write": {
      if (!pathArg) throw new Error("Falta 'path'");
      const mode = (str(request, "mode") ?? "append") as DocEditMode;
      if (!DOC_EDIT_MODES.includes(mode)) throw new Error(`'mode' tiene que ser ${DOC_EDIT_MODES.join(", ")}`);
      const content = str(request, "content");
      if (content === undefined) throw new Error("Falta 'content'");
      const path = resolve(pathArg);
      const text = await editDoc(path, { mode, content, find: str(request, "find") }, actor);
      return `Wrote ${shown(path)} (${mode}). It now has ${text.split("\n").length} lines.`;
    }

    case "doc.export": {
      if (!pathArg) throw new Error("Falta 'path'");
      const path = resolve(pathArg);
      const outArg = str(request, "out");
      const out = await exportDocPdf(path, cwd, outArg ? resolve(outArg) : docPdfPath(path));
      return `Exported to ${shown(out)}.`;
    }

    case "asset.capture": {
      const source = str(request, "source");
      const name = slugify(str(request, "name") ?? (source === "diagram" ? (pathArg ?? "diagrama").split(/[\\/]/).pop()!.replace(/\.diagram\.json$/i, "") : "captura"));
      let out: string;
      if (source === "diagram") {
        if (!pathArg) throw new Error("Falta 'path': el diagrama a capturar");
        const format = str(request, "format") === "png" ? "png" : "svg";
        out = await freeProjectPath(cwd, ASSETS_DIR, name, `.${format}`);
        await exportDiagram(await loadDiagram(resolve(pathArg)), format, out);
      } else if (source === "browser") {
        // La captura de lo que muestra el navegador del agente, como la de browser_screenshot,
        // copiada al proyecto: la de browser_screenshot vive en una carpeta temporal.
        const reply = await runBrowserRequest(cwd, { op: "screenshot" }, owner);
        const temp = /saved to:\n(.+)\n/.exec(reply)?.[1]?.trim();
        if (!temp) throw new Error("No se pudo capturar el navegador");
        const file = await readFile(temp);
        if (file.kind !== "image") throw new Error("La captura no es una imagen");
        out = await freeProjectPath(cwd, ASSETS_DIR, name, ".png");
        await writeNewFile(out, { base64: file.dataUrl.slice(file.dataUrl.indexOf(",") + 1) });
      } else {
        throw new Error("'source' tiene que ser browser o diagram");
      }
      const forDoc = str(request, "for_doc");
      const snippet = forDoc ? `![${name}](${relativeLink(resolve(forDoc), out)})` : null;
      return `Saved ${shown(out)}.${snippet ? ` Put it in the document with: ${snippet}` : ""}`;
    }

    default:
      throw new Error(`Los documentos no saben hacer '${request.op}'`);
  }
}
