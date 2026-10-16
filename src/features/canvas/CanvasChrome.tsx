import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AddIcon, CloseIcon } from "neogestify-ui-components";

import { ArrangeIcon, DiagramIcon, DocIcon, FitIcon, FolderOpenIcon, GlobeIcon, NoteIcon, SlidesIcon } from "@/app/icons";
import { SIZE_PRESETS } from "@/features/slides/deck";
import { createDeck } from "@/features/slides/store";
import { createDoc } from "@/features/docs/store";
import { freeDiagramPath, freeProjectPath } from "@/features/diagram/paths";
import { createDiagram } from "@/features/diagram/store";
import { agentIcon } from "@/features/agents/agentIcons";
import { agentPaint } from "@/features/browser/agentPaint";
import { useDormant } from "@/features/terminal/hibernation";
import { useTabsStore } from "@/features/tabs/store";
import { openNewAgentWizard } from "@/features/tabs/tabActions";

import { addBrowser, addNode, centerOn, defaultPageName, workspaceOf } from "./actions";
import { canvasKindOf } from "./fileDrop";
import { pageOfAgent, type CanvasPage } from "./model";
import { dispatchCanvas, newPageId, requestView, setActivePage, useCanvasStore } from "./store";

/**
 * Lo que flota sobre el canvas: las páginas arriba a la izquierda, las herramientas arriba a
 * la derecha y, en una página vacía, qué se puede traer. Va por encima de las terminales
 * (que se dibujan en otra capa), así que el contenedor no agarra el puntero: solo sus partes.
 */
export function CanvasChrome({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const workspace = workspaceOf(cwd);
  const pages = useCanvasStore((s) => s.pages[workspace]);
  const activeId = useCanvasStore((s) => s.activePage[workspace]);
  const page = pages?.find((p) => p.id === activeId);
  if (!pages || !page) return null;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
      <div className="absolute top-2 left-2 right-2 flex items-start gap-2">
        <PageBar workspace={workspace} pages={pages} activeId={page.id} />
        <div className="flex-1" />
        <Toolbar cwd={cwd} workspace={workspace} page={page} pages={pages} />
      </div>
      {page.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-sm text-center px-6 py-5 rounded-xl
            bg-white/85 dark:bg-surface/85 backdrop-blur ring-1 ring-gray-200 dark:ring-white/8">
            <p className="text-sm font-medium text-gray-800 dark:text-white/85">{t("canvas.empty.title")}</p>
            <p className="mt-1.5 text-xs text-gray-500 dark:text-white/45">{t("canvas.empty.body")}</p>
            <div className="mt-4 flex justify-center">
              <AddMenu cwd={cwd} workspace={workspace} page={page} pages={pages} align="center" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const PILL = "pointer-events-auto flex items-center rounded-lg shadow-sm ring-1 ring-gray-200 dark:ring-white/8 bg-white/90 dark:bg-surface/90 backdrop-blur";
const TOOL = `cc-t flex items-center justify-center gap-1.5 h-7 px-2 rounded-md text-xs
  text-gray-500 dark:text-white/55 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/8`;

function PageBar({ workspace, pages, activeId }: { workspace: string; pages: CanvasPage[]; activeId: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);

  const create = () => {
    const id = newPageId();
    dispatchCanvas(workspace, [{ op: "page.create", id, name: defaultPageName(pages.length + 1) }]);
    setActivePage(workspace, id);
    setEditing(id);
  };
  const rename = (id: string, name: string) => {
    setEditing(null);
    if (name.trim()) dispatchCanvas(workspace, [{ op: "page.rename", page: id, name }]);
  };
  // Borrar una página no cierra nada: sus agentes y navegadores siguen en sus tabs.
  const remove = (id: string) => dispatchCanvas(workspace, [{ op: "page.remove", page: id }]);

  return (
    <div className={`${PILL} p-0.5 gap-0.5 min-w-0 overflow-x-auto cc-scroll-x`}>
      {pages.map((p) => {
        const active = p.id === activeId;
        return (
          <div
            key={p.id}
            className={`group flex items-center h-7 rounded-md shrink-0 ${active
              ? "bg-accent-500/12 text-accent-700 dark:text-accent-200"
              : "text-gray-500 dark:text-white/50 hover:bg-gray-100 dark:hover:bg-white/6"}`}
          >
            {editing === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                onBlur={(e) => rename(p.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(p.id, e.currentTarget.value);
                  if (e.key === "Escape") setEditing(null);
                }}
                className="w-32 h-6 mx-1 px-1.5 rounded text-xs bg-white dark:bg-surface-deep outline-none ring-1 ring-accent-500/60"
              />
            ) : (
              <button
                className="h-full pl-2.5 pr-1.5 text-xs font-medium whitespace-nowrap"
                onClick={() => setActivePage(workspace, p.id)}
                onDoubleClick={() => setEditing(p.id)}
                title={t("canvas.page.renameHint")}
              >
                {p.name}
                <span className="ml-1.5 text-[10px] opacity-50">{p.nodes.length}</span>
              </button>
            )}
            {editing !== p.id && (
              <button
                title={t("canvas.page.delete")}
                aria-label={t("canvas.page.delete")}
                onClick={() => remove(p.id)}
                className="flex items-center justify-center w-5 h-5 mr-1 rounded opacity-0 group-hover:opacity-100
                  hover:bg-gray-200 dark:hover:bg-white/10"
              >
                <CloseIcon className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
      <button className={TOOL} title={t("canvas.page.new")} aria-label={t("canvas.page.new")} onClick={create}>
        <AddIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function Toolbar({ cwd, workspace, page, pages }: { cwd: string; workspace: string; page: CanvasPage; pages: CanvasPage[] }) {
  const { t } = useTranslation();
  return (
    <div className={`${PILL} p-0.5 gap-0.5 shrink-0`}>
      <AddMenu cwd={cwd} workspace={workspace} page={page} pages={pages} align="right" />
      <button
        className={TOOL}
        title={t("canvas.arrange")}
        onClick={() => {
          dispatchCanvas(workspace, [{ op: "page.arrange", page: page.id, layout: "grid" }]);
          requestView({ workspace, page: page.id, fit: true });
        }}
      >
        <ArrangeIcon className="w-3.5 h-3.5" />
      </button>
      <button className={TOOL} title={t("canvas.fit")} onClick={() => requestView({ workspace, page: page.id, fit: true })}>
        <FitIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/** Traer algo a la página: los agentes del workspace (estén donde estén), uno nuevo, un
 *  navegador o una nota. */
function AddMenu({ cwd, workspace, page, pages, align }: {
  cwd: string; workspace: string; page: CanvasPage; pages: CanvasPage[]; align: "right" | "center";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useTabsStore((s) => s.tabs);
  const dormant = useDormant((s) => s.ids);
  const agents = tabs.filter((tab) => workspaceOf(tab.cwd) === workspace);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);

  const done = (nodeId: string) => {
    setOpen(false);
    centerOn(workspace, page.id, nodeId);
  };

  return (
    <div ref={ref} className="relative pointer-events-auto">
      <button
        className={`${TOOL} ${align === "center" ? "!h-8 !px-3 ring-1 ring-gray-200 dark:ring-white/10" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <AddIcon className="w-3.5 h-3.5" />
        {t("canvas.add.button")}
      </button>
      {open && (
        <div
          className={`absolute top-9 z-30 w-72 py-1.5 rounded-lg shadow-xl text-left
            bg-white dark:bg-surface-raised ring-1 ring-gray-200 dark:ring-white/10
            ${align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"}`}
        >
          <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-white/35">
            {t("canvas.add.agents")}
          </p>
          {agents.length === 0 && <p className="px-3 pb-2 text-xs text-gray-400 dark:text-white/35">{t("canvas.add.noAgents")}</p>}
          <div className="max-h-64 overflow-y-auto">
            {agents.map((tab) => {
              const where = pageOfAgent(pages, tab.id);
              const here = where?.id === page.id;
              const Icon = agentIcon(tab.agentId, tab.command);
              const state = tab.ptyId != null ? t("canvas.agent.running") : dormant.has(tab.id) ? t("canvas.agent.dormant") : t("canvas.agent.starting");
              return (
                <button
                  key={tab.id}
                  disabled={here}
                  onClick={() => done(addNode(workspace, page.id, { kind: "agent", ref: tab.id }))}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-white/6 disabled:opacity-45 disabled:hover:bg-transparent"
                >
                  <span className="w-1 h-6 rounded-full shrink-0" style={{ background: agentPaint(tab.id).hex }} />
                  <Icon className="w-4 h-4 shrink-0 text-gray-500 dark:text-white/55" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-gray-800 dark:text-white/85">{tab.title}</span>
                    <span className="block truncate text-[10px] text-gray-400 dark:text-white/35">
                      {state}
                      {where && ` · ${here ? t("canvas.add.onThisPage") : t("canvas.add.onPage", { page: where.name })}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="my-1 border-t border-gray-100 dark:border-white/8" />
          <MenuItem
            icon={<AddIcon className="w-4 h-4" />}
            label={t("canvas.add.newAgent")}
            onClick={() => {
              // El agente que salga del asistente entra solo a esta página (ver `useWorkspaceSync`).
              setOpen(false);
              openNewAgentWizard();
            }}
          />
          <MenuItem icon={<DiagramIcon className="w-4 h-4" />} label={t("canvas.add.diagram")} onClick={() => {
            setOpen(false);
            // Un archivo nuevo en docs/diagrams/, que se versiona con el proyecto.
            (async () => {
              const path = await freeDiagramPath(cwd, t("diagram.defaultName"));
              await createDiagram(path);
              done(addNode(workspace, page.id, { kind: "diagram", ref: path }));
            })().catch(console.error);
          }} />
          <MenuItem icon={<DocIcon className="w-4 h-4" />} label={t("canvas.add.doc")} onClick={() => {
            setOpen(false);
            (async () => {
              const title = t("doc.defaultName");
              const path = await freeProjectPath(cwd, "docs", title, ".md");
              await createDoc(path, `# ${title}\n`);
              done(addNode(workspace, page.id, { kind: "doc", ref: path }));
            })().catch(console.error);
          }} />
          <MenuItem icon={<SlidesIcon className="w-4 h-4" />} label={t("canvas.add.slides")} onClick={() => {
            setOpen(false);
            (async () => {
              const title = t("slides.defaultName");
              const dir = await freeProjectPath(cwd, "docs/slides", title, ".slides");
              await createDeck(dir, title, SIZE_PRESETS["16:9"]!);
              done(addNode(workspace, page.id, { kind: "slides", ref: dir }));
            })().catch(console.error);
          }} />
          <MenuItem icon={<FolderOpenIcon className="w-4 h-4" />} label={t("canvas.add.existing")} onClick={() => {
            setOpen(false);
            // Lo que se quitó del canvas sigue en el proyecto: se vuelve a traer de acá (o
            // arrastrándolo desde el explorador).
            (async () => {
              const picked = await openDialog({
                defaultPath: cwd,
                multiple: false,
                filters: [{ name: t("canvas.add.existingFilter"), extensions: ["json", "md", "markdown", "mdx", "html"] }],
              });
              if (typeof picked !== "string") return;
              const file = canvasKindOf(picked, false);
              if (!file) throw new Error(t("canvas.add.notSupported"));
              const here = page.nodes.find((n) => n.kind === file.kind && n.ref === file.ref);
              done(here?.id ?? addNode(workspace, page.id, { kind: file.kind, ref: file.ref }));
            })().catch(console.error);
          }} />
          <MenuItem icon={<GlobeIcon className="w-4 h-4" />} label={t("canvas.add.browser")} onClick={() => done(addBrowser(cwd, page.id, ""))} />
          <MenuItem icon={<NoteIcon className="w-4 h-4" />} label={t("canvas.add.note")} onClick={() => {
            setOpen(false);
            addNode(workspace, page.id, { kind: "note", text: "" });
          }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-2.5 w-full px-3 py-1.5 text-xs text-gray-700 dark:text-white/75 hover:bg-gray-100 dark:hover:bg-white/6">
      <span className="text-gray-500 dark:text-white/50">{icon}</span>
      {label}
    </button>
  );
}
