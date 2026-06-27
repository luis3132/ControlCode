import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "xterm/css/xterm.css";

interface TerminalProps {
  command?: string;
  cwd?: string;
  onReady?: (id: number) => void;
  onExit?: (code: number) => void;
}

export function Terminal({
  command = "bash",
  cwd,
  onReady,
  onExit,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"connecting" | "running" | "exited">(
    "connecting"
  );

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

    // FIX: esperar un frame para que el DOM tenga dimensiones reales antes de fit()
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    // ── 2. Crear la sesión PTY en Rust ───────────────────────
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;

    const initPty = async () => {
      try {
        // FIX: obtener el home dir desde Rust para evitar process.env.HOME
        // que no existe en el contexto browser de Tauri
        const resolvedCwd: string = cwd ?? await invoke<string>("get_home_dir");

        const ptyId = await invoke<number>("pty_create", {
          command,
          cwd: resolvedCwd,
        });
        ptyIdRef.current = ptyId;
        setStatus("running");
        onReady?.(ptyId);

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
              `\r\n\x1b[90m[Proceso terminado con código ${event.payload.code}]\x1b[0m\r\n`
            );
            onExit?.(event.payload.code);
          }
        );
      } catch (err) {
        term.write(`\r\n\x1b[31m[Error al iniciar PTY: ${err}]\x1b[0m\r\n`);
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
      // FIX: usar requestAnimationFrame para evitar resize en medio de un layout
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
      resizeObserver.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (ptyIdRef.current !== null) {
        invoke("pty_kill", { id: ptyIdRef.current }).catch(console.error);
        ptyIdRef.current = null;
      }
      term.dispose();
    };
  }, []); // Solo montar/desmontar una vez

  return (
    <div className="relative flex flex-col h-full w-full">
      {/* Status badge */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-slate-900 border border-slate-700 px-2 py-1 rounded-lg text-xs font-mono">
        <span className="w-1.5 h-1.5"
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
          {status === "running" ? command : status}
        </span>
      </div>

      {/* xterm container — necesita dimensiones explícitas */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          minHeight: 0,          // FIX: permite que flex-1 funcione en Chrome/WebKit
          overflow: "hidden",
          padding: "8px",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}
