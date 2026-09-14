import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { initTabsPersistence } from "@/features/tabs/persistence";
import { SideHead } from "@/app/SideHead";
import { ActivityRail } from "@/app/ActivityRail";
import { StatusBar } from "@/app/StatusBar";
import { TabBar } from "@/features/tabs/TabBar";
import { WorkspacesPanel } from "@/features/workspaces/WorkspacesPanel";
import { ExplorerPanel } from "@/features/explorer/ExplorerPanel";
import { SettingsModal } from "@/features/settings/SettingsModal";
import { AccountsModal } from "@/features/accounts/AccountsModal";
import { RouteModal } from "@/app/RouteModal";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { ViewTabsHost } from "@/features/tabs/ViewTabsHost";
import { initViewTabsPersistence } from "@/features/tabs/viewStore";
import { useUiStore } from "@/app/uiStore";
import { buildWorkspaceTree } from "@/features/workspaces/workspaceTree";
import { useRepoInfo } from "@/features/workspaces/useRepoInfo";
import { useSnapshotsStore } from "@/features/workspaces/snapshotsStore";
import { ResizeHandles } from "@/app/ResizeHandles";
import { useGlobalShortcuts } from "@/app/useGlobalShortcuts";
import { VIEW_OVERLAY_ID } from "@/shared/ui/ViewModal";
import { AppExitListener } from "@/app/AppExitListener";
import { useAgentsStore } from "@/features/agents/store";
import { initCliBridge } from "@/features/orchestrator/cliBridge";
import { useFleetEvents } from "@/features/runs/useFleetEvents";
import { detectAgents } from "@/features/agents/ipc";
import { loadWindowState, type RestoredTabRow } from "@/features/tabs/ipc";

/** Las rutas que se muestran como modal encima de las terminales en vez de reemplazarlas. */
const MODAL_ROUTES = ["/skills", "/marketplace", "/fleet"];

function toFrontendTab(row: RestoredTabRow): Tab {
  return {
    id: row.id,
    title: row.title ?? `${row.agentLabel} — ${row.cwd}`,
    titleIsCustom: row.titleIsCustom,
    cwd: row.cwd,
    agentId: row.agentId,
    agentLabel: row.agentLabel,
    command: row.command,
    ptyId: null,
    sessionId: row.sessionId ?? undefined,
    scrollback: row.scrollback ?? undefined,
    historyId: row.historyId ?? undefined,
    accountId: row.accountId ?? undefined,
    prelaunch: row.prelaunch ?? undefined,
    openedAt: row.openedAt,
  };
}

export function AppShell() {
  const tabs = useTabsStore((s) => s.tabs);
  const setDetectedAgents = useTabsStore((s) => s.setDetectedAgents);
  const activateTab = useTabsStore((s) => s.activateTab);
  const hydrateFromBackend = useTabsStore((s) => s.hydrateFromBackend);
  const setHydrated = useTabsStore((s) => s.setHydrated);
  const setWorkspaceId = useTabsStore((s) => s.setWorkspaceId);
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";
  // Skills y Marketplace se pintan ENCIMA en vez de reemplazar el centro: la regla del
  // entorno es que nada tape el trabajo. Las rutas no cambian — adentro se sigue
  // navegando igual (el detalle de una skill, los repos del marketplace).
  const asModal = MODAL_ROUTES.some((p) => location.pathname.startsWith(p));
  const [isMaximized, setIsMaximized] = useState(false);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const workspacesCollapsed = useUiStore((s) => s.workspacesCollapsed);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const accountsOpen = useUiStore((s) => s.accountsOpen);
  const setAccountsOpen = useUiStore((s) => s.setAccountsOpen);

  // El árbol del panel izquierdo se DERIVA de las tabs abiertas más lo que git diga de
  // cada `cwd`. No hay tabla nueva: un workspace es una carpeta con agentes adentro.
  const snapshots = useSnapshotsStore((s) => s.snapshots);
  const loadSnapshots = useSnapshotsStore((s) => s.load);
  useEffect(() => { loadSnapshots().catch(console.error); }, [loadSnapshots]);

  // Las carpetas de los cerrados también se resuelven contra git: si no, un workspace
  // cerrado no muestra su rama ni cae en el grupo de su repo.
  const repos = useRepoInfo(useMemo(
    () => [...tabs.map((tab) => tab.cwd), ...snapshots.map((s) => s.cwd)],
    [tabs, snapshots]
  ));
  const groups = useMemo(
    () => buildWorkspaceTree(tabs, repos, activeTabId, snapshots),
    [tabs, repos, activeTabId, snapshots]
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeRepo = activeTab ? repos.get(activeTab.cwd) ?? null : null;

  // El encabezado del lateral mide exactamente lo mismo que el riel más el panel, para
  // que la división vertical sea una sola línea de arriba a abajo.
  const RAIL_W = 48;
  const PANEL_W = 272;
  const sideWidth = RAIL_W + (workspacesCollapsed ? 0 : PANEL_W);

  useGlobalShortcuts();
  // La flota se escucha desde acá y no desde su pantalla: un agente que pide permiso con
  // la consola cerrada tiene que verse igual (ver `useFleetEvents`).
  useFleetEvents();

  useEffect(() => {
    detectAgents().then(setDetectedAgents);
    // Las TUIs custom viven en SQLite (el backend también las consulta), así que hay que
    // traerlas explícitamente en cada ventana en vez de que se rehidraten solas.
    useAgentsStore.getState().loadCustomAgents().catch(console.error);
  }, []);

  // Puente de la CLI `ccode`: esta ventana queda disponible para atender los comandos
  // que solo el frontend puede resolver (crear/cerrar tabs).
  useEffect(() => initCliBridge(), []);

  // Maximizada, la ventana ocupa el área de trabajo del monitor borde a borde — con la
  // ventana transparent:true, esquinas redondeadas ahí se verían como triángulos
  // recortados (sin nada detrás), así que se quitan mientras esté maximizada.
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);

    let unlisten: (() => void) | undefined;
    win.onResized(async () => {
      setIsMaximized(await win.isMaximized());
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // Restaura el estado de tabs de esta ventana (mismas tabs/cwd/agente/orden con que se cerró).
  useEffect(() => {
    initTabsPersistence();
    const myLabel = getCurrentWindow().label;
    initViewTabsPersistence(myLabel);
    loadWindowState(myLabel)
      .then((restored) => {
        if (restored) {
          // Ya existe una fila para esta ventana en la DB (con o sin tabs — ej. la
          // ventana en blanco que el backend crea cuando un workspace se queda sin
          // ninguna ventana viva) — su workspace_id es la fuente de verdad, se adopta
          // siempre, no solo cuando trae tabs.
          setWorkspaceId(restored.window.workspaceId);
          if (restored.tabs.length > 0) {
            hydrateFromBackend(restored.tabs.map(toFrontendTab));
            navigate("/workspace");
          }
        }
      })
      // `hydrated` habilita el autosave, y el autosave BORRA las tabs que no vengan en su
      // payload. Marcarlo en un `finally` lo ponía en true aunque la carga hubiera fallado:
      // la ventana quedaba "lista" con cero tabs y el siguiente guardado archivaba y borraba
      // las que sí tenía en la base (y con ellas, por cascada, sus skills). Era intermitente
      // porque dependía de que fallara justo esa llamada.
      //
      // Ahora solo se marca cuando de verdad se cargó. Si falla, esta ventana no autosalva:
      // perder los cambios de posición es reversible, borrarle las tabs al usuario no.
      .then(() => setHydrated(true))
      .catch((e) => {
        console.error("No se pudo cargar el estado de esta ventana; el autosave queda desactivado", e);
      });
  }, []);

  // "Reabrir" desde Sesiones: si esa conversación ya está abierta en ESTA ventana, la
  // enfoca (activa la tab) en vez de dejar que se abra una duplicada en otra parte.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("cc-focus-tab", (event) => {
      try {
        const data = JSON.parse(event.payload);
        const myLabel = getCurrentWindow().label;
        if (data.targetLabel !== myLabel) return;
        activateTab(data.tabId);
        navigate("/workspace");
      } catch { /* ignore */ }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (tabs.length === 0 && isWorkspace) {
      navigate("/");
    }
  }, [tabs.length, isWorkspace, navigate]);

  return (
    <div className={`flex flex-col h-screen overflow-hidden
      bg-gray-50 dark:bg-[#0d1117]
      text-gray-900 dark:text-white
      ${isMaximized ? "" : "rounded-xl"}`}>

      <ResizeHandles />
      <AppExitListener />

      {/* Fila 0: encabezado del lateral (controles de ventana + nombre) y, a partir de
          donde ese lateral termina, las tabs de agente. Nada más — lo que antes vivía a
          la derecha de la barra de título se mudó al riel y a la barra de abajo. */}
      <div className="flex shrink-0">
        <SideHead width={sideWidth} />
        <TabBar showLights={workspacesCollapsed} />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Izquierda: los AGENTES. Es lo primero que se ve porque en un entorno de
            desarrollo para agentes lo primero es qué está corriendo; el árbol de
            archivos es el panel secundario y va del otro lado. */}
        <ActivityRail agentCount={tabs.length} />
        {!workspacesCollapsed && <WorkspacesPanel groups={groups} width={PANEL_W} />}

        <div className="relative flex-1 min-w-0 overflow-hidden">
          {/* TerminalPanel siempre montado para preservar PTYs */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              // También visible detrás de un modal de ruta: es el punto de que sea modal.
              visibility: isWorkspace || asModal ? "visible" : "hidden",
              zIndex: 0,
            }}
          >
            <TerminalPanel />
            {/* Archivos, diffs y navegadores: tabs que se dibujan encima de las terminales. */}
            <ViewTabsHost />
          </div>

          {/* `overflow-hidden` y no `cc-scroll`: cada página arma su propio alto y
              scrollea por dentro (encabezado fijo arriba, atajos fijos abajo, la lista en
              el medio). Un scroll acá afuera además reservaría su carril a la derecha de
              TODAS las páginas, incluidas las que no lo necesitan. */}
          {!isWorkspace && !asModal && (
            <div className="absolute inset-0 z-10 overflow-hidden">
              <Outlet />
            </div>
          )}

          {asModal && (
            <RouteModal onClose={() => navigate(tabs.length > 0 ? "/workspace" : "/")}>
              <Outlet />
            </RouteModal>
          )}

          {/* Donde se montan los modales de las vistas (ver `ViewModal`). Va acá dentro y
              no en el body para que queden ENCERRADOS en el área de contenido: un modal
              de una página no tiene por qué tapar las tabs ni los paneles, que son la
              forma de salir de donde estás.

              El `transform` no es decorativo: hace que el `position: fixed` del modal se
              resuelva contra este contenedor en vez de contra la ventana. */}
          <div
            id={VIEW_OVERLAY_ID}
            className="absolute inset-0 z-20 pointer-events-none"
            style={{ transform: "translateZ(0)" }}
          />
        </div>

        {/* Derecha: los archivos del workspace activo. */}
        <ExplorerPanel
          cwd={activeTab?.cwd ?? null}
          repo={activeRepo}
          title={activeRepo?.branch ?? activeTab?.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ""}
        />
      </div>

      <StatusBar repo={activeRepo} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {accountsOpen && <AccountsModal onClose={() => setAccountsOpen(false)} />}
    </div>
  );
}
