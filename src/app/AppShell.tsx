import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";
import { initTabsPersistence } from "@/features/tabs/persistence";
import { TopBar } from "@/app/TopBar";
import { TabBar } from "@/features/tabs/TabBar";
import { PathBar } from "@/features/workspaces/PathBar";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import { ResizeHandles } from "@/app/ResizeHandles";
import { VIEW_OVERLAY_ID } from "@/shared/ui/ViewModal";
import { AppExitListener } from "@/app/AppExitListener";
import { useAgentsStore } from "@/features/agents/store";
import { initCliBridge } from "@/features/orchestrator/cliBridge";
import { detectAgents } from "@/features/agents/ipc";
import { loadWindowState, type RestoredTabRow } from "@/features/tabs/ipc";
import {
  announceWindowReady,
  newWindowWorkspaceKey,
  onTabReceived,
} from "@/features/tabs/transfer";

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
  const addTab = useTabsStore((s) => s.addTab);
  const activateTab = useTabsStore((s) => s.activateTab);
  const hydrateFromBackend = useTabsStore((s) => s.hydrateFromBackend);
  const setHydrated = useTabsStore((s) => s.setHydrated);
  const setWorkspaceId = useTabsStore((s) => s.setWorkspaceId);
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";
  const [isMaximized, setIsMaximized] = useState(false);

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
        } else {
          // Ventana genuinamente nueva (sin fila en la DB todavía): si el menú "Nueva
          // ventana"/"Nuevo workspace" del TopBar dejó un workspaceId destino, adoptarlo
          // antes de que arranque el autosave (si no, esta ventana quedaría en "default").
          const key = newWindowWorkspaceKey(myLabel);
          const handoff = localStorage.getItem(key);
          if (handoff) {
            localStorage.removeItem(key);
            setWorkspaceId(handoff);
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

  // Recibir una tab de otra ventana: por arrastre fuera de la ventana (que crea esta) o
  // por "Mover a ventana" del menú contextual. Llega ENTERA — ver `transfer.ts`.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const myLabel = getCurrentWindow().label;

    onTabReceived(({ targetLabel, tab, workspaceId }) => {
      if (targetLabel !== myLabel) return;
      // Una ventana vacía es la que acaba de crear este arrastre: adopta el workspace del
      // origen para que la tab no quede huérfana en el bucket `default`. Una que ya tiene
      // tabs conserva el suyo (el merge entre workspaces distintos ya se rechazó antes).
      if (useTabsStore.getState().tabs.length === 0) setWorkspaceId(workspaceId);
      addTab({
        cwd: tab.cwd,
        agent: {
          id: tab.agentId,
          label: tab.agentLabel,
          command: tab.command,
          available: true,
        },
        title: tab.title,
        titleIsCustom: tab.titleIsCustom,
        ptyId: tab.ptyId,
        sessionId: tab.sessionId,
        historyId: tab.historyId,
        accountId: tab.accountId,
        prelaunch: tab.prelaunch,
        openedAt: tab.openedAt,
      });
      navigate("/workspace");
    }).then((fn) => { unlisten = fn; });

    // Recién ahora esta ventana puede recibir tabs. Quien la creó está esperando este
    // aviso para mandarle la suya (ver `waitForWindow`).
    announceWindowReady(myLabel).catch(console.error);

    return () => unlisten?.();
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
      <TopBar />

      {/* TabBar siempre visible si hay tabs (estilo Chrome: se ve aunque estés en Home,
          y es la forma de volver a una terminal). PathBar solo tiene sentido en /workspace. */}
      {tabs.length > 0 && <TabBar />}
      {isWorkspace && tabs.length > 0 && <PathBar />}

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {/* TerminalPanel siempre montado para preservar PTYs */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            visibility: isWorkspace ? "visible" : "hidden",
            zIndex: 0,
          }}
        >
          <TerminalPanel />
        </div>

        {!isWorkspace && (
          <div className="absolute inset-0 z-10 cc-scroll">
            <Outlet />
          </div>
        )}

        {/* Donde se montan los modales de las vistas (ver `ViewModal`). Va acá dentro y no
            en el body para que queden ENCERRADOS en el área de contenido: un modal de una
            página no tiene por qué tapar la barra de título ni la de tabs, que son la
            forma de salir de donde estás.

            El `transform` no es decorativo: hace que el `position: fixed` del modal se
            resuelva contra este contenedor en vez de contra la ventana. */}
        <div
          id={VIEW_OVERLAY_ID}
          className="absolute inset-0 z-20 pointer-events-none"
          style={{ transform: "translateZ(0)" }}
        />
      </div>
    </div>
  );
}
