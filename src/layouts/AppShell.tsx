import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { AgentInfo, useTabsStore } from "../store/tabs";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TabBar } from "../components/tabs/TabBar";
import { PathBar } from "../components/workspace/PathBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";

export function AppShell() {
  const { tabs, setDetectedAgents } = useTabsStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";

  useEffect(() => {
    invoke<AgentInfo[]>("detect_agents").then(setDetectedAgents);
  }, []);

  // Volver a home cuando se cierran todos los tabs
  useEffect(() => {
    if (tabs.length === 0 && isWorkspace) {
      navigate("/");
    }
  }, [tabs.length, isWorkspace, navigate]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100 dark:bg-[#0d1117] text-gray-900 dark:text-white">
      <Sidebar />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {tabs.length > 0 && (
          <>
            <TabBar />
            <PathBar />
          </>
        )}

        <div className="relative flex-1 min-h-0 overflow-hidden">
          {/* TerminalPanel siempre montado — preserva PTYs entre navegaciones */}
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

          {/* Contenido de rutas (home, settings) */}
          {!isWorkspace && (
            <div className="absolute inset-0 z-10 overflow-auto">
              <Outlet />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
