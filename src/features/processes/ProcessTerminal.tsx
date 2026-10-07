import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTheme } from "neogestify-ui-components";
import "@xterm/xterm/css/xterm.css";

import { ptyAttach, ptyResize, ptyWrite } from "@/features/terminal/ipc";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { afterSnapshot, type PtyData } from "@/features/terminal/ptyStream";
import { MIN_CONTRAST, TERMINAL_FONT, TERMINAL_THEMES, terminalFontSize } from "@/features/terminal/theme";

/**
 * La terminal de un subproceso, en vivo: lo que escribió hasta ahora y lo que siga
 * escribiendo. Se le puede escribir (un `y`, un Ctrl-C) mientras corre.
 *
 * Más liviana que la de una tab: no lanza nada ni maneja agentes, solo se conecta al PTY
 * que ya corre en el backend. Primero escucha y después copia el scrollback, así no se
 * pierde ni se repite nada de lo que llegue en el medio (ver `ptyStream.ts`).
 */
export function ProcessTerminal({ ptyId, running }: { ptyId: number; running: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new XTerm({
      theme: TERMINAL_THEMES[themeRef.current],
      minimumContrastRatio: MIN_CONTRAST[themeRef.current],
      fontFamily: TERMINAL_FONT,
      fontSize: terminalFontSize(useTerminalPrefsStore.getState().zoom),
      lineHeight: 1.1,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowTransparency: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;

    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let early: PtyData[] | null = [];
    let snapshotTotal = 0;
    const write = (chunk: PtyData) => {
      if (early) {
        early.push(chunk);
        return;
      }
      const data = afterSnapshot(chunk, snapshotTotal);
      if (data) term.write(data);
    };

    (async () => {
      unlisten = await listen<PtyData>(`pty-data-${ptyId}`, (e) => write(e.payload));
      if (disposed) return unlisten();
      try {
        const { data, total } = await ptyAttach(ptyId);
        if (disposed) return;
        term.write(data);
        snapshotTotal = total;
      } catch {
        // Ya se limpió: no queda nada que mostrar.
      }
      const waiting = early ?? [];
      early = null;
      waiting.forEach(write);
    })().catch(console.error);

    // Lo que se tipea va al proceso, solo mientras corre.
    const input = term.onData((data) => {
      if (runningRef.current) ptyWrite(ptyId, data).catch(console.error);
    });

    // El tamaño de la terminal es el de lo que se ve. Si corre, el proceso se entera.
    let sent = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const resize = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (size === sent || !runningRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        sent = size;
        ptyResize(ptyId, term.cols, term.rows).catch(() => {});
      }, 120);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    requestAnimationFrame(resize);

    return () => {
      disposed = true;
      observer.disconnect();
      if (timer) clearTimeout(timer);
      input.dispose();
      unlisten?.();
      termRef.current = null;
      term.dispose();
    };
  }, [ptyId]);

  // Cambiar de tema la repinta en el lugar, como las terminales de las tabs.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = TERMINAL_THEMES[theme];
    term.options.minimumContrastRatio = MIN_CONTRAST[theme];
  }, [theme]);

  return <div ref={containerRef} className="h-full w-full" />;
}
