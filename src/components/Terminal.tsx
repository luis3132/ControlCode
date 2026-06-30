import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import "xterm/css/xterm.css";

import { RESUMABLE_AGENT_IDS } from "../lib/agentResume";
import { consumePtyTransferring } from "../lib/ptyTransfer";

interface TerminalProps {
  command?: string;
  cwd?: string;
  agentId?: string;
  /** Si se pasa, no se lanza un proceso nuevo: se reconecta a este PTY ya vivo
   * (p. ej. una tab movida desde otra ventana) y se reproduce su scrollback. */
  attachPtyId?: number;
  /** Scrollback persistido de una sesión anterior (proceso ya muerto, sin PTY vivo
   * al que conectarse): se escribe antes de lanzar el proceso nuevo, a modo de historial. */
  initialScrollback?: string;
  onReady?: (id: number) => void;
  onExit?: (code: number) => void;
  onSessionDiscovered?: (sessionId: string) => void;
}

// El agente puede tardar en escribir su primer log (p. ej. hasta el primer mensaje
// del usuario), así que se sigue intentando mientras la tab esté abierta, no solo
// los primeros segundos tras lanzarla.
const SESSION_DISCOVERY_INTERVAL_MS = 3000;
const SESSION_DISCOVERY_MAX_ATTEMPTS = Infinity;
// Margen de seguridad: los timestamps de archivo tienen resolución de 1s y puede haber
// un pequeño desfase entre este reloj y el de pty_create.
const SESSION_DISCOVERY_LOOKBACK_S = 3;

export function Terminal({
  command = "bash",
  cwd,
  agentId,
  attachPtyId,
  initialScrollback,
  onReady,
  onExit,
  onSessionDiscovered,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<number | null>(null);
  const { t } = useTranslation();
  const [status, setStatus] = useState<"connecting" | "running" | "exited">("connecting");

  useEffect(() => {
    if (!containerRef.current) return;

    // ── 1. Inicializar xterm.js ──────────────────────────────
    const term = new XTerm({
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#388bfd40",
        black: "#0d1117",
        brightBlack: "#6e7681",
        red: "#ff7b72",
        brightRed: "#ffa198",
        green: "#3fb950",
        brightGreen: "#56d364",
        yellow: "#d29922",
        brightYellow: "#e3b341",
        blue: "#388bfd",
        brightBlue: "#79c0ff",
        magenta: "#bc8cff",
        brightMagenta: "#d2a8ff",
        cyan: "#39c5cf",
        brightCyan: "#56d4dd",
        white: "#b1bac4",
        brightWhite: "#f0f6fc",
      },
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // ── 2. Crear la sesión PTY en Rust ───────────────────────
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let discoveryAttempts = 0;
    let cancelled = false;

    const pollSessionId = (resolvedCwd: string, startedAfter: number) => {
      if (!agentId || !RESUMABLE_AGENT_IDS.includes(agentId) || !onSessionDiscovered) return;

      const attempt = async () => {
        if (cancelled) return;
        discoveryAttempts += 1;
        try {
          const found = await invoke<string | null>("discover_session_id", {
            agentId,
            cwd: resolvedCwd,
            startedAfter,
          });
          if (found) {
            onSessionDiscovered(found);
            return;
          }
        } catch {
          // ignorar, se reintenta
        }
        if (!cancelled && discoveryAttempts < SESSION_DISCOVERY_MAX_ATTEMPTS) {
          discoveryTimer = setTimeout(attempt, SESSION_DISCOVERY_INTERVAL_MS);
        }
      };

      discoveryTimer = setTimeout(attempt, SESSION_DISCOVERY_INTERVAL_MS);
    };

    const attachListeners = async (ptyId: number) => {
      // ── 3. Escuchar stdout del PTY ──────────────────────
      unlistenData = await listen<{ data: string }>(
        `pty-data-${ptyId}`,
        (event) => {
          term.write(event.payload.data);
        }
      );

      // ── 4. Escuchar salida del proceso ──────────────────
      unlistenExit = await listen<{ code: number }>(
        `pty-exit-${ptyId}`,
        (event) => {
          setStatus("exited");
          term.write(
            `\r\n\x1b[90m${t("terminal.exitCode", { code: event.payload.code })}\x1b[0m\r\n`
          );
          onExit?.(event.payload.code);
        }
      );
    };

    const initPty = async () => {
      try {
        if (attachPtyId != null) {
          // Reconectar a un PTY que ya está vivo en otra ventana: nada de spawnear de nuevo.
          const buffered = await invoke<string>("pty_attach", { id: attachPtyId });
          ptyIdRef.current = attachPtyId;
          if (buffered) term.write(buffered);
          setStatus("running");
          onReady?.(attachPtyId);
          await attachListeners(attachPtyId);
          return;
        }

        if (initialScrollback) term.write(initialScrollback);

        const resolvedCwd: string = cwd ?? await invoke<string>("get_home_dir");
        const startedAfter = Math.floor(Date.now() / 1000) - SESSION_DISCOVERY_LOOKBACK_S;

        const ptyId = await invoke<number>("pty_create", {
          command,
          cwd: resolvedCwd,
        });
        ptyIdRef.current = ptyId;
        setStatus("running");
        onReady?.(ptyId);
        pollSessionId(resolvedCwd, startedAfter);
        await attachListeners(ptyId);
      } catch (err) {
        term.write(`\r\n\x1b[31m${t("terminal.ptyError", { error: err })}\x1b[0m\r\n`);
        setStatus("exited");
      }
    };

    initPty();

    // ── 5. Input del usuario → PTY ───────────────────────────
    term.onData((data) => {
      if (ptyIdRef.current !== null) {
        invoke("pty_write", { id: ptyIdRef.current, data }).catch(console.error);
      }
    });

    // ── 6. Resize automático ─────────────────────────────────
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // ignorar si el terminal fue dispose()d
        }
        if (ptyIdRef.current !== null) {
          const { cols, rows } = term;
          invoke("pty_resize", { id: ptyIdRef.current, cols, rows }).catch(
            console.error
          );
        }
      });
    });

    resizeObserver.observe(containerRef.current);

    // ── 7. Cleanup ───────────────────────────────────────────
    return () => {
      cancelled = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      resizeObserver.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (ptyIdRef.current !== null) {
        if (!consumePtyTransferring(ptyIdRef.current)) {
          invoke("pty_kill", { id: ptyIdRef.current }).catch(console.error);
        }
        ptyIdRef.current = null;
      }
      term.dispose();
    };
  }, []); // Solo montar/desmontar una vez

  return (
    <div className="relative flex flex-col h-full w-full">
      {/* Status badge */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-slate-900 border border-slate-700 px-2 py-1 rounded-lg text-xs font-mono">
        <span
          className="w-1.5 h-1.5"
          style={{
            borderRadius: "50%",
            background:
              status === "running"
                ? "#34d399"
                : status === "connecting"
                ? "#fbbf24"
                : "#f87171",
          }}
        />
        <span className="text-white/80">
          {status === "running"
            ? command
            : t(`terminal.status.${status}` as "terminal.status.connecting" | "terminal.status.exited")}
        </span>
      </div>

      {/* xterm container */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          minHeight: 0,
          overflow: "hidden",
          padding: "8px",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
