import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { AgentInfo, useTabsStore } from "../store/tabs";
import { TopBar } from "../components/topbar/TopBar";
import { TabBar } from "../components/tabs/TabBar";
import { PathBar } from "../components/workspace/PathBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { ResizeHandles } from "../components/ResizeHandles";

export function AppShell() {
  const { tabs, setDetectedAgents } = useTabsStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspace = location.pathname === "/workspace";

  useEffect(() => {
    invoke<AgentInfo[]>("detect_agents").then(setDetectedAgents);
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
