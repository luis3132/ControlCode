import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AgentInfo, useTabsStore } from "../store/tabs";
import { TopBar } from "../components/topbar/TopBar";
import { TabBar } from "../components/tabs/TabBar";
import { PathBar } from "../components/workspace/PathBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { ResizeHandles } from "../components/ResizeHandles";

export function AppShell() {
  const { tabs, setDetectedAgents, addTab } = useTabsStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";

  useEffect(() => {
    invoke<AgentInfo[]>("detect_agents").then(setDetectedAgents);
  }, []);

  // Recoger tab arrastrado fuera de esta ventana (nueva ventana vacía que abre cc-detach)
  useEffect(() => {
    const raw = localStorage.getItem("cc-detach");
    if (!raw) return;
    localStorage.removeItem("cc-detach");
    try {
      const { cwd, command, agentId, title } = JSON.parse(raw);
      addTab({ cwd, agent: { id: agentId, label: title, command, available: true } });
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
        addTab({ cwd: data.cwd, agent: { id: data.agentId, label: data.title, command: data.command, available: true } });
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
