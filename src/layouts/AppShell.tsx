import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AgentInfo, Tab, useTabsStore } from "../store/tabs";
import type { PrelaunchStep } from "../store/prelaunch";
import { initTabsPersistence } from "../store/persistTabs";
import { TopBar } from "../components/topbar/TopBar";
import { TabBar } from "../components/tabs/TabBar";
import { PathBar } from "../components/workspace/PathBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { ResizeHandles } from "../components/ResizeHandles";
import { AppExitListener } from "../components/app/AppExitListener";
import { useSettingsStore } from "../store/settings";
import { initCliBridge } from "../lib/cliBridge";

interface RestoredTabRow {
  id: string;
  title: string | null;
  titleIsCustom: boolean;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  sessionId: string | null;
  scrollback: string | null;
  historyId: string | null;
  accountId: string | null;
  prelaunch: PrelaunchStep[] | null;
  openedAt: number;
}

interface RestoredWindowState {
  window: { workspaceId: string };
  tabs: RestoredTabRow[];
}

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
  const { tabs, setDetectedAgents, addTab, activateTab, hydrateFromBackend, setHydrated, setWorkspaceId } = useTabsStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    invoke<AgentInfo[]>("detect_agents").then(setDetectedAgents);
    // Las TUIs custom viven en SQLite (el backend también las consulta), así que hay que
    // traerlas explícitamente en cada ventana en vez de que se rehidraten solas.
    useSettingsStore.getState().loadCustomAgents().catch(console.error);
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
    invoke<RestoredWindowState | null>("db_load_window_state", { label: myLabel })
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
          const handoff = localStorage.getItem("cc-new-window-workspace");
          if (handoff) {
            localStorage.removeItem("cc-new-window-workspace");
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

  // Recoger tab arrastrado fuera de esta ventana (nueva ventana vacía que abre cc-detach)
  useEffect(() => {
    const raw = localStorage.getItem("cc-detach");
    if (!raw) return;
    localStorage.removeItem("cc-detach");
    try {
      const { cwd, command, agentId, agentLabel, title, sessionId, ptyId, accountId } = JSON.parse(raw);
      addTab({
        cwd,
        agent: { id: agentId, label: agentLabel ?? title, command, available: true },
        title,
        sessionId: sessionId ?? undefined,
        ptyId: ptyId ?? null,
        accountId: accountId ?? undefined,
      });
      navigate("/workspace");
    } catch { /* ignore malformed data */ }
  }, []);

  // Escuchar transferencias de tabs desde otras ventanas (clic derecho → Mover a ventana)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("cc-receive-tab", async (event) => {
      try {
        const data = JSON.parse(event.payload);
        const myLabel = getCurrentWindow().label;
        if (data.targetLabel !== myLabel) return;
        addTab({
          cwd: data.cwd,
          agent: { id: data.agentId, label: data.agentLabel ?? data.title, command: data.command, available: true },
          title: data.title,
          sessionId: data.sessionId ?? undefined,
          ptyId: data.ptyId ?? null,
          accountId: data.accountId ?? undefined,
        });
        navigate("/workspace");
      } catch { /* ignore */ }
    }).then((fn) => { unlisten = fn; });
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
      </div>
    </div>
  );
}
