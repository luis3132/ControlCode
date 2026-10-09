import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Button, AddIcon, BoxIcon, ChevronDownIcon, FolderIcon, SaveIcon, Tooltip } from "neogestify-ui-components";

import { ExternalIcon } from "@/app/icons";
import { useTabsStore } from "@/features/tabs/store";
import { openAddFolderWizard } from "@/features/tabs/tabActions";
import { DEFAULT_WORKSPACE_ID } from "@/features/tabs/types";
import { useWorkspacesStore } from "@/features/workspaces/store";
import type { WorkspaceSummary } from "@/features/workspaces/types";
import { useWorkspaceActions } from "@/features/workspaces/useWorkspaceActions";

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button variant="custom"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left rounded-md
        text-gray-700 dark:text-gray-200
        hover:bg-gray-100 dark:hover:bg-white/8 transition-colors"
    >
      {icon}
      {label}
    </Button>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Las carpetas de un workspace, cortas: el nombre de cada una, con la ruta en el tooltip. */
function Folders({ folders }: { folders: string[] }) {
  const { t } = useTranslation();
  if (folders.length === 0) {
    return <span className="text-[11px] italic text-gray-400 dark:text-white/30">{t("workspace.menu.noFolders")}</span>;
  }
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
      {folders.map((cwd) => (
        <span key={cwd} title={cwd} className="flex items-center gap-1 min-w-0 text-[11px] text-gray-500 dark:text-white/45">
          <FolderIcon className="w-3 h-3 shrink-0 opacity-70" />
          <span className="truncate max-w-36">{baseName(cwd)}</span>
        </span>
      ))}
    </span>
  );
}

const SECTION = "px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-white/35";

/**
 * El workspace de esta ventana: su nombre ("Sin guardar" mientras no se le dé uno) y el
 * menú para cambiar de workspace. Vive en el encabezado del lateral; con el lateral plegado,
 * en el riel, como un botón con su inicial (`compact`).
 *
 * El menú es la lista de workspaces con sus carpetas: el de esta ventana arriba (con
 * "Guardar" si todavía no tiene nombre) y los demás debajo, cada uno para abrir acá o en
 * otra ventana —o ir a la suya, si ya está abierto—. Al final, crear uno nuevo, otra ventana
 * de este, y sumarle una carpeta.
 */
export function WorkspaceChip({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const focusIfOpen = useWorkspacesStore((s) => s.focusIfOpen);
  const openWorkspace = useWorkspacesStore((s) => s.openWorkspace);
  const openNewWindow = useWorkspacesStore((s) => s.openNewWindow);
  const { newWorkspace, saveWorkspace, dialogs } = useWorkspaceActions();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // El menú va en un portal, con posición fija: colgado del botón quedaba recortado por el
  // encabezado del lateral (`overflow-hidden`) o por el riel, que mide 48px.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setAt(compact ? { top: r.top, left: r.right + 8 } : { top: r.bottom + 6, left: r.left });
  }, [open, compact]);

  // El nombre sale de la lista, que puede cambiar desde otra ventana (guardar, renombrar).
  useEffect(() => {
    loadWorkspaces().catch(console.error);
    const unlisten = listen("cc-workspace-changed", () => { loadWorkspaces().catch(console.error); });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, [loadWorkspaces]);

  useEffect(() => {
    if (!open) return;
    loadWorkspaces().catch(console.error);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, loadWorkspaces]);

  const unsaved = workspaceId === DEFAULT_WORKSPACE_ID;
  const current = workspaces.find((ws) => ws.id === workspaceId) ?? null;
  const name = unsaved ? t("workspace.unsaved") : current?.name ?? "…";
  // Las de esta ventana, más las que la base sepa de otras ventanas del mismo workspace.
  const currentFolders = useMemo(
    () => [...new Set([...tabs.map((tab) => tab.cwd), ...(current?.folders ?? [])])],
    [tabs, current]
  );
  const others = workspaces.filter((ws) => ws.id !== workspaceId);

  // Uno que ya tiene ventanas se enfoca en vez de abrirse dos veces. La marca de "en uso"
  // sale de la base y puede haber quedado vieja (la app se cerró de golpe): por eso se
  // pregunta siempre, y si no hay ventana de verdad, se abre.
  const go = async (ws: WorkspaceSummary, where: "here" | "new") => {
    if (opening) return;
    setOpening(ws.id);
    try {
      if (!(await focusIfOpen(ws.id))) await openWorkspace(ws.id, where);
      setOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setOpening(null);
    }
  };

  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className={`relative flex items-center min-w-0 ${compact ? "shrink-0" : ""}`} ref={ref} data-tauri-drag-region="false">
      {compact ? (
        // En el riel: del tamaño de sus botones, con la inicial del workspace y el punto que
        // dice si está guardado.
        <Tooltip content={name} placement="right" delay={400}>
          <Button variant="custom"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={name}
            className={`cc-t relative flex items-center justify-center w-9 h-9 rounded-[9px] shrink-0
              border border-gray-200 dark:border-white/8
              ${open ? "bg-gray-200/80 dark:bg-white/10" : "bg-white/60 dark:bg-white/4 hover:bg-gray-200/60 dark:hover:bg-white/8"}`}
          >
            <span className={`text-[13px] font-semibold uppercase
              ${unsaved ? "text-gray-500 dark:text-white/55" : "text-gray-800 dark:text-gray-100"}`}>
              {name.trim().charAt(0) || "·"}
            </span>
            <span className={`absolute top-1 right-1 w-[6px] h-[6px] rounded-full
              ${unsaved ? "border border-gray-400 dark:border-white/40" : "bg-blue-500 dark:bg-blue-400"}`} />
          </Button>
        </Tooltip>
      ) : (
        <Button variant="custom"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`cc-t flex items-center gap-1.5 h-[26px] max-w-full min-w-0 pl-2 pr-1.5 rounded-[7px]
            border border-gray-200 dark:border-white/8
            ${open ? "bg-gray-200/80 dark:bg-white/10" : "bg-white/60 dark:bg-white/4 hover:bg-gray-200/60 dark:hover:bg-white/8"}`}
        >
          <span className={`w-[7px] h-[7px] rounded-full shrink-0
            ${unsaved ? "border border-gray-400 dark:border-white/40" : "bg-blue-500 dark:bg-blue-400"}`} />
          <span className={`truncate text-xs font-semibold
            ${unsaved ? "text-gray-500 dark:text-white/55" : "text-gray-800 dark:text-gray-100"}`}>
            {name}
          </span>
          <ChevronDownIcon className="w-3 h-3 shrink-0 text-gray-400 dark:text-white/40" />
        </Button>
      )}

      {open && at && createPortal(
        <div ref={menuRef} style={{ position: "fixed", top: at.top, left: at.left }}
          className="cc-rise w-80 p-1 z-100
          rounded-xl border border-gray-200 dark:border-white/10
          bg-white dark:bg-[#11161f] shadow-2xl">

          <div className={SECTION}>{t("workspace.menu.this")}</div>
          <div className="flex flex-col gap-1 mx-1 px-2.5 py-2 rounded-lg bg-gray-100 dark:bg-white/5">
            <span className="flex items-center gap-2">
              <span className={`flex-1 truncate text-[13px] font-semibold
                ${unsaved ? "text-gray-500 dark:text-white/55" : "text-gray-900 dark:text-white"}`}>
                {name}
              </span>
              {unsaved && tabs.length > 0 && (
                <Button variant="custom"
                  onClick={act(saveWorkspace)}
                  className="cc-t flex items-center gap-1 h-6 px-2 rounded-md shrink-0 text-[11px] font-medium
                    text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
                >
                  <SaveIcon className="w-3 h-3" />
                  {t("workspace.menu.save")}
                </Button>
              )}
            </span>
            <Folders folders={currentFolders} />
          </div>

          <div className="flex items-center justify-between pr-2">
            <div className={SECTION}>{t("workspace.menu.others")}</div>
            <Button variant="custom"
              onClick={act(() => navigate("/workspaces"))}
              className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t("workspace.manage.link")}
            </Button>
          </div>
          {others.length === 0 ? (
            <p className="px-3 pb-2 text-[11.5px] text-gray-400 dark:text-white/35">{t("workspace.menu.none")}</p>
          ) : (
            <div className="cc-scroll flex flex-col max-h-72 overflow-y-auto">
              {others.map((ws) => {
                const inUse = ws.openWindowCount > 0;
                return (
                  <div key={ws.id} className="group flex items-start gap-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/6">
                    <Button variant="custom"
                      disabled={opening !== null}
                      onClick={() => { go(ws, "here").catch(console.error); }}
                      title={inUse ? t("workspace.list.goTo") : t("workspace.open.here")}
                      className="flex flex-col items-start justify-start gap-1 flex-1 min-w-0 px-2.5 py-2 text-left disabled:opacity-60"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-[13px] font-medium text-gray-800 dark:text-gray-100">
                          {opening === ws.id ? t("workspace.list.opening") : ws.name}
                        </span>
                        {inUse && (
                          <span className="shrink-0 px-1.5 py-px rounded-full text-[9.5px] font-semibold
                            bg-emerald-500/12 text-emerald-700 dark:text-emerald-400">
                            {t("workspace.list.open")}
                          </span>
                        )}
                      </span>
                      <Folders folders={ws.folders} />
                    </Button>
                    {!inUse && (
                      <Tooltip content={t("workspace.open.newWindow")} placement="right">
                        <Button variant="icon"
                          disabled={opening !== null}
                          onClick={() => { go(ws, "new").catch(console.error); }}
                          aria-label={t("workspace.open.newWindow")}
                          className="cc-t flex items-center justify-center w-7 h-7 mt-1.5 mr-1 rounded-md shrink-0 p-0
                            text-gray-400 dark:text-white/40 opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                            hover:text-gray-800 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"
                        >
                          <ExternalIcon className="w-3.5 h-3.5" />
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="h-px my-1 mx-2 bg-gray-200 dark:bg-white/8" />
          <MenuItem
            icon={<BoxIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/45" />}
            label={t("topbar.menu.newWorkspace")}
            onClick={act(() => { newWorkspace().catch(console.error); })}
          />
          {/* Una ventana más del MISMO workspace: se guarda y se abre con él. */}
          <MenuItem
            icon={<ExternalIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/45" />}
            label={t("topbar.menu.newWindow")}
            onClick={act(() => { openNewWindow().catch(console.error); })}
          />
          <MenuItem
            icon={<AddIcon className="w-4 h-4 shrink-0 text-gray-400 dark:text-white/45" />}
            label={t("folders.add")}
            onClick={act(openAddFolderWizard)}
          />
        </div>,
        document.body
      )}

      {dialogs}
    </div>
  );
}
