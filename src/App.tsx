import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "./components/Terminal";
import { Button, Input } from "neogestify-ui-components";
import { AddIcon, IconRedo, MonitorIcon, NetworkIcon } from "neogestify-ui-components";
import "./App.css";

let windowCounter = 0;

export default function App() {
  const [broadcastLog, setBroadcastLog] = useState<string[]>([]);
  const [broadcastInput, setBroadcastInput] = useState("");
  const [tmuxAvailable, setTmuxAvailable] = useState<boolean | null>(null);
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([]);

  useEffect(() => {
    const unlisten = listen<string>("cc-broadcast", (event) => {
      setBroadcastLog((prev) => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] ${event.payload}`,
      ]);
    });

    invoke<boolean>("tmux_check").then(setTmuxAvailable);
    invoke<string[]>("tmux_list_sessions").then(setTmuxSessions);

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openNewWindow = async () => {
    windowCounter++;
    await invoke("open_new_window", { label: `window-${windowCounter}` });
  };

  const sendBroadcast = async () => {
    if (!broadcastInput.trim()) return;
    await invoke("broadcast_event", { event: "cc-broadcast", payload: broadcastInput });
    setBroadcastInput("");
  };

  const refreshTmux = async () => {
    const sessions = await invoke<string[]>("tmux_list_sessions");
    setTmuxSessions(sessions);
  };

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-white overflow-hidden">
      {/* ── Topbar ─────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold bg-linear-to-r from-blue-400 to-violet-400 bg-clip-text text-transparent">
            ControlCode
          </span>
          <span className="text-xs text-white/30 font-mono">Fase 0 Spike</span>
        </div>

        <div className="flex items-center gap-2">
          {/* tmux status */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs font-mono">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                tmuxAvailable === null
                  ? "bg-gray-500"
                  : tmuxAvailable
                  ? "bg-emerald-400"
                  : "bg-red-500"
              }`}
            />
            <span className="text-white/50">
              tmux:{" "}
              {tmuxAvailable === null
                ? "checking…"
                : tmuxAvailable
                ? `✓ (${tmuxSessions.length} sessions)`
                : "not found"}
            </span>
            {tmuxAvailable && (
              <Button variant="ghost" onClick={refreshTmux}>
                <IconRedo />
              </Button>
            )}
          </div>

          {/* Nueva ventana */}
          <Button
            variant="primary"
            leftIcon={<MonitorIcon />}
            rightIcon={<AddIcon />}
            onClick={openNewWindow}
          >
            Nueva ventana
          </Button>
        </div>
      </header>

      {/* ── Layout principal ───────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Terminal principal */}
        <div className="flex-1 overflow-hidden p-2">
          <div className="h-full rounded-lg border border-white/10 overflow-hidden bg-[#0d1117]">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-white/10">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500/80" />
                <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
                <span className="w-3 h-3 rounded-full bg-green-500/80" />
              </div>
              <span className="text-xs text-white/40 font-mono ml-2">bash — ~</span>
            </div>
            <div className="h-[calc(100%-2rem)]">
              <Terminal command="bash" />
            </div>
          </div>
        </div>

        {/* Panel lateral — Spike de broadcast */}
        <aside className="w-72 shrink-0 border-l border-white/10 flex flex-col bg-[#0d1117]">
          <div className="px-3 py-2 border-b border-white/10 bg-[#161b22]">
            <p className="text-xs font-semibold text-white/60 uppercase tracking-wider">
              Spike: Multi-ventana
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-1 font-mono text-xs">
            {broadcastLog.length === 0 ? (
              <p className="text-white/20 text-center mt-4">
                Los mensajes de broadcast aparecerán aquí
              </p>
            ) : (
              broadcastLog.map((msg, i) => (
                <div
                  key={i}
                  className="px-2 py-1 rounded bg-white/5 text-white/70 break-all"
                >
                  {msg}
                </div>
              ))
            )}
          </div>

          <div className="p-3 border-t border-white/10 space-y-2">
            <Input
              value={broadcastInput}
              onChange={(e) => setBroadcastInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendBroadcast()}
              placeholder="Mensaje broadcast…"
              variant="outline"
            />
            <Button
              variant="primary"
              fullWidth
              leftIcon={<NetworkIcon />}
              onClick={sendBroadcast}
            >
              Broadcast a todas las ventanas
            </Button>
            <p className="text-white/20 text-center text-xs">
              Abre otra ventana y verifica que llega
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
