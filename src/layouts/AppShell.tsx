import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AgentInfo, Tab, useTabsStore } from "../store/tabs";
import { initTabsPersistence } from "../store/persistTabs";
import { TopBar } from "../components/topbar/TopBar";
import { TabBar } from "../components/tabs/TabBar";
import { PathBar } from "../components/workspace/PathBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { ResizeHandles } from "../components/ResizeHandles";

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
}

interface RestoredWindowState {
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
  };
}

export function AppShell() {
  const { tabs, setDetectedAgents, addTab, hydrateFromBackend, setHydrated } = useTabsStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";

  useEffect(() => {
    invoke<AgentInfo[]>("detect_agents").then(setDetectedAgents);
  }, []);

  // Restaura el estado de tabs de esta ventana (mismas tabs/cwd/agente/orden con que se cerró).
  useEffect(() => {
    initTabsPersistence();
    const myLabel = getCurrentWindow().label;
    invoke<RestoredWindowState | null>("db_load_window_state", { label: myLabel })
      .then((restored) => {
        if (restored && restored.tabs.length > 0) {
          hydrateFromBackend(restored.tabs.map(toFrontendTab));
          navigate("/workspace");
        }
      })
      .catch(console.error)
      .finally(() => setHydrated(true));
  }, []);

  // Recoger tab arrastrado fuera de esta ventana (nueva ventana vacía que abre cc-detach)
  useEffect(() => {
    const raw = localStorage.getItem("cc-detach");
    if (!raw) return;
    localStorage.removeItem("cc-detach");
    try {
      const { cwd, command, agentId, agentLabel, title, sessionId, ptyId } = JSON.parse(raw);
      addTab({
        cwd,
        agent: { id: agentId, label: agentLabel ?? title, command, available: true },
        title,
        sessionId: sessionId ?? undefined,
        ptyId: ptyId ?? null,
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
        });
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
    <div className="flex flex-col h-screen overflow-hidden
      bg-gray-50 dark:bg-[#0d1117]
      text-gray-900 dark:text-white">

      <ResizeHandles />
      <TopBar />

      {tabs.length > 0 && (
        <>
          <TabBar />
          <PathBar />
        </>
      )}

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
          <div className="absolute inset-0 z-10 overflow-auto">
            <Outlet />
          </div>
        )}
      </div>
    </div>
  );
}
