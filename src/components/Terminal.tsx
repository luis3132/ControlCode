import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";

import { isResumable } from "../lib/agentResume";
import { consumePtyTransferring } from "../lib/ptyTransfer";
import { awaitSkillSetup } from "../lib/pendingSkillSetup";
import { useSettingsStore } from "../store/settings";

interface TerminalProps {
  /** Id de la tab en el store — solo se usa para esperar (si aplica) a que sus symlinks
   * de skills elegidas en el wizard terminen de crearse antes de lanzar el proceso. */
  tabId?: string;
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
// del usuario), así que no basta con probar solo los primeros segundos tras lanzarla.
// Pero cada intento para gemini-cli/codex escanea y LEE EL CONTENIDO de todos los
// archivos de sesión del sistema (de cualquier proyecto, no solo este cwd) cuyo mtime
// sea posterior al arranque de la tab — repetir eso cada 3s indefinidamente durante
// toda la vida de una tab que jamás llega a resolverse (agente sin sesión, cwd sin
// permisos, etc.) es I/O desperdiciado sin límite. Se usa backoff hasta un techo y un
// número acotado de intentos en vez de un intervalo fijo infinito.
const SESSION_DISCOVERY_INITIAL_MS = 3000;
const SESSION_DISCOVERY_MAX_INTERVAL_MS = 30_000;
const SESSION_DISCOVERY_MAX_ATTEMPTS = 60; // con backoff, cubre ~35 minutos antes de rendirse
// Margen de seguridad: los timestamps de archivo tienen resolución de 1s y puede haber
// un pequeño desfase entre este reloj y el de pty_create.
const SESSION_DISCOVERY_LOOKBACK_S = 3;

export function Terminal({
  tabId,
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

    // Mide cols/rows reales ANTES de spawnear el proceso (ver pty_create en Rust: el
    // PTY nace con este tamaño, no con uno fijo que se corrige después).
    //
    // - `document.fonts.ready`: si fit() mide con la fuente de fallback (porque
    //   "Cascadia Code"/"JetBrains Mono"/"Fira Code" todavía no cargó), calcula cols/rows
    //   para celdas de un tamaño que no es el real — al terminar de cargar la fuente, el
    //   contenido real desborda o queda recortado por el `overflow: hidden` del
    //   contenedor (el "overflow"/márgenes raros reportados).
    // - Doble rAF: el primero solo garantiza que el layout se pintó una vez; fit() antes
    //   de eso puede medir un contenedor todavía en 0×0 (tab recién creada).
    const fitOnce = async () => {
      await document.fonts.ready.catch(() => {});
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      try {
        fitAddon.fit();
      } catch {
        // ignorar si el terminal fue dispose()d mientras esperábamos
      }
    };

    // ── 2. Crear la sesión PTY en Rust ───────────────────────
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let discoveryAttempts = 0;
    let cancelled = false;

    const pollSessionId = (resolvedCwd: string, startedAfter: number) => {
      if (!agentId || !isResumable(agentId) || !onSessionDiscovered) return;

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
          const delay = Math.min(
            SESSION_DISCOVERY_INITIAL_MS * 2 ** Math.floor(discoveryAttempts / 3),
            SESSION_DISCOVERY_MAX_INTERVAL_MS
          );
          discoveryTimer = setTimeout(attempt, delay);
        }
      };

      discoveryTimer = setTimeout(attempt, SESSION_DISCOVERY_INITIAL_MS);
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
          await fitOnce();
          if (buffered) term.write(buffered);
          setStatus("running");
          onReady?.(attachPtyId);
          await attachListeners(attachPtyId);
          // La ventana a la que se reconecta puede tener un tamaño distinto al de la
          // ventana donde el PTY nació (tear-off, merge entre ventanas) — sincronizarlo.
          if (!cancelled) {
            invoke("pty_resize", { id: attachPtyId, cols: term.cols, rows: term.rows }).catch(console.error);
          }
          return;
        }

        if (initialScrollback) term.write(initialScrollback);

        // Si el wizard dejó un setup de skills pendiente para esta tab (symlinks
        // todavía escribiéndose en su cwd), esperarlo antes de lanzar el proceso — si
        // el agente arranca primero, algunos escanean su carpeta de skills solo al
        // boot y nunca verían las que el usuario acaba de elegir.
        if (tabId) await awaitSkillSetup(tabId);
        if (cancelled) return;

        // Toda tab que arranca (nueva, restaurada o reabierta desde el historial) deja su
        // carpeta de skills con exactamente las suyas: las de su workspace más las
        // propias, y ninguna de otro workspace/tab que hubiera usado antes esa carpeta.
        // Tiene que pasar ANTES de spawnear: varios agentes escanean sus skills una sola
        // vez, al boot.
        if (tabId) await invoke("reconcile_tab_skills", { tabId }).catch(console.error);
        if (cancelled) return;

        await fitOnce();
        if (cancelled) return;

        const resolvedCwd: string = cwd ?? await invoke<string>("get_home_dir");
        const startedAfter = Math.floor(Date.now() / 1000) - SESSION_DISCOVERY_LOOKBACK_S;

        const ptyId = await invoke<number>("pty_create", {
          command,
          cwd: resolvedCwd,
          cols: term.cols,
          rows: term.rows,
          // Variables extra declaradas por la TUI custom, si esta tab corre una.
          env: agentId
            ? useSettingsStore.getState().customAgents.find((a) => a.id === agentId)?.env ?? null
            : null,
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
