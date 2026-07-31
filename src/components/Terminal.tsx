import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useTheme } from "neogestify-ui-components";
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
  /** Si esta terminal es la que el usuario está viendo ahora mismo. Al pasar a `true` se
   * enfoca sola, para poder escribir sin un click extra. */
  isActive?: boolean;
  /** Momento (epoch en segundos) en que se abrió la tab. Es el piso temporal para buscar
   * su sesión al RECONECTAR a un PTY ya vivo: ahí el proceso puede llevar horas corriendo,
   * así que usar "ahora" como piso descartaría la sesión que se está buscando. */
  openedAt?: number;
  /** Session id ya conocido de la tab. Si viene, no hace falta salir a descubrirlo. */
  knownSessionId?: string;
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

/**
 * Paletas de la terminal, una por tema. Son GitHub Dark y GitHub Light: el resto de la app
 * ya venía con la oscura, y usar el par oficial mantiene los 16 colores ANSI coherentes
 * entre sí en vez de aclarar la oscura a ojo (que deja los colores brillantes ilegibles
 * sobre blanco — un amarillo #e3b341 sobre fondo claro no se lee).
 */
const TERMINAL_THEMES = {
  dark: {
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
  light: {
    // Gris, no blanco puro. El blanco a pantalla completa es agresivo en una superficie que
    // se mira durante horas, y deja sin margen los tonos claros. Es exactamente el
    // `bg-gray-100` que ya usa el panel que la contiene (ver TerminalPanel), así que la
    // terminal se integra con la app en vez de recortarse como un rectángulo blanco.
    background: "#f3f4f6",
    foreground: "#1f2328",
    cursor: "#0550ae",
    selectionBackground: "#0969da33",
    // Cada color cumple contraste sobre el fondo POR SÍ MISMO, conservando su tono. Esto
    // evita pedirle a xterm que corrija el contraste en caliente: esa corrección, para
    // llegar al ratio, arrastra el color hacia el negro y le borra el matiz — todo
    // terminaba viéndose gris.
    //
    // Elegidos maximizando SATURACIÓN, no oscuridad. Es la diferencia entre un tema claro
    // que se ve apagado y uno que se ve vivo: para ganar contraste sobre un fondo claro se
    // puede bajar la luminosidad (que lava el color) o subir el croma (que lo mantiene). Un
    // `#00792c` al 100% de saturación y un `#0a7d2e` al 85% contrastan casi igual, pero el
    // primero se lee como verde de verdad.
    //
    // Las variantes `bright` van más OSCURAS que las normales, no más claras: sobre fondo
    // claro, "más destacado" es más oscuro. Al revés se irían hacia el blanco y volverían
    // al problema original.
    black: "#24292e",
    brightBlack: "#57606a",
    red: "#d10d1f",
    brightRed: "#a4071c",
    green: "#00792c",
    brightGreen: "#04591f",
    yellow: "#b45309",
    brightYellow: "#8a3d00",
    blue: "#0969da",
    brightBlue: "#0546b8",
    magenta: "#7c3aed",
    brightMagenta: "#5f21c9",
    cyan: "#0e7490",
    brightCyan: "#0a5568",
    // La familia "white" va OSCURA a propósito. En la semántica de terminal, `white` y
    // `brightWhite` son "el texto normal / el destacado": pensados para fondo negro. Si se
    // dejan como grises claros (que es lo que trae GitHub Light), sobre fondo blanco
    // desaparecen — y es justo lo que más usan los agentes para su texto principal.
    white: "#4a5058",
    brightWhite: "#24292f",
  },
} as const;

/**
 * Piso de contraste que xterm corrige en caliente, contra el fondo real de cada celda.
 *
 * Deliberadamente BAJO (2, no el 4.5 de WCAG AA). Con 4.5, para alcanzar el ratio xterm
 * arrastra el color hacia el negro y le borra el tono: los rojos, verdes y azules
 * terminaban viéndose todos gris oscuro. Como la paleta clara de acá ya cumple ~4.5 por su
 * cuenta, un piso de 2 no llega a activarse nunca para un color normal — solo entra donde
 * la paleta no puede llegar: el texto atenuado (SGR 2), que xterm dibuja mezclando hacia el
 * fondo y en tema claro queda casi invisible, y los pares fondo/texto que impone el propio
 * programa.
 *
 * En oscuro queda apagado (1): esa paleta ya se veía bien y no hay nada que corregir.
 */
const MIN_CONTRAST = { dark: 1, light: 2 } as const;

export function Terminal({
  tabId,
  command = "bash",
  cwd,
  agentId,
  attachPtyId,
  initialScrollback,
  isActive = false,
  openedAt,
  knownSessionId,
  onReady,
  onExit,
  onSessionDiscovered,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<number | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const { t } = useTranslation();
  const [status, setStatus] = useState<"connecting" | "running" | "exited">("connecting");
  const { theme } = useTheme();
  const isDark = theme === "dark";
  // El efecto de montaje corre una sola vez (`[]`) y no debe re-crear la terminal al
  // cambiar el tema — leerlo por ref evita meterlo en las dependencias y matar el PTY.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!containerRef.current) return;

    // ── 1. Inicializar xterm.js ──────────────────────────────
    const term = new XTerm({
      theme: TERMINAL_THEMES[themeRef.current],
      minimumContrastRatio: MIN_CONTRAST[themeRef.current],
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
    termRef.current = term;

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
    // `fit()` divide el alto disponible por el alto de celda *teórico* y redondea hacia
    // abajo. Pero lo que el motor rasteriza no siempre mide eso: con escalado fraccionario
    // (Wayland al 125%/150%) cada fila se redondea a píxeles de dispositivo y el error se
    // acumula, así que las N filas calculadas terminan ocupando unos píxeles MÁS que el
    // contenedor — y la última queda cortada contra el borde inferior.
    //
    // En vez de intentar predecir ese redondeo, se mide lo que realmente quedó pintado y,
    // si desborda, se saca una fila. El medio píxel de tolerancia evita que el ruido de
    // subpíxel dispare una corrección donde entra justo.
    const trimOverflowingRow = () => {
      const el = containerRef.current;
      const screen = el?.querySelector<HTMLElement>(".xterm-screen");
      if (!el || !screen) return;
      const style = getComputedStyle(el);
      const available =
        el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (screen.getBoundingClientRect().height > available + 0.5 && term.rows > 1) {
        term.resize(term.cols, term.rows - 1);
      }
    };

    const fitAndTrim = () => {
      try {
        fitAddon.fit();
        trimOverflowingRow();
      } catch {
        // ignorar si el terminal fue dispose()d
      }
    };

    const fitOnce = async () => {
      await document.fonts.ready.catch(() => {});
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      fitAndTrim();
    };

    // ── 2. Crear la sesión PTY en Rust ───────────────────────
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let discoveryAttempts = 0;
    let cancelled = false;

    const pollSessionId = (resolvedCwd: string, startedAfter: number) => {
      if (!agentId || !isResumable(agentId) || !onSessionDiscovered) return;
      // Ya se sabe cuál es: no hay nada que descubrir y cada intento cuesta (para OpenCode,
      // levantar un proceso que abre su base de datos entera).
      if (knownSessionId) return;

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

          // Reconectar NO cancela el descubrimiento. Antes esta rama devolvía sin llamar a
          // `pollSessionId`, así que una tab arrastrada a otra ventana (o mergeada) dejaba
          // de buscar su sesión para siempre: si todavía no se había resuelto en la ventana
          // de origen, el session id se perdía y con él el "reabrir esta conversación".
          // El piso temporal es cuándo se abrió la tab, no ahora: el proceso puede llevar
          // horas vivo y su sesión ser mucho más vieja que esta reconexión.
          const attachCwd: string = cwd ?? (await invoke<string>("get_home_dir"));
          pollSessionId(attachCwd, openedAt ?? Math.floor(Date.now() / 1000));

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
    // Con debounce: arrastrar el borde de la ventana dispara el observer decenas de veces
    // por segundo, y cada una hacía un `fit()` (que remide la celda y repinta todo) más un
    // `pty_resize` por IPC. Ese torrente es lo que se ve como parpadeo/basura mientras se
    // redimensiona; el tamaño que importa es el final, no los intermedios.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const applyFit = () => {
      const el = containerRef.current;
      // Un contenedor en 0×0 (la tab todavía no se pintó) haría que fit() calcule filas y
      // columnas contra una celda sin medir, dejando el PTY con un tamaño absurdo que
      // recién se corrige al siguiente resize — con el proceso ya dibujando encima.
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fitAndTrim();
      if (ptyIdRef.current !== null) {
        const { cols, rows } = term;
        invoke("pty_resize", { id: ptyIdRef.current, cols, rows }).catch(console.error);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => requestAnimationFrame(applyFit), 80);
    });

    resizeObserver.observe(containerRef.current);

    // ── 7. Cleanup ───────────────────────────────────────────
    return () => {
      cancelled = true;
      if (discoveryTimer) clearTimeout(discoveryTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (ptyIdRef.current !== null) {
        if (!consumePtyTransferring(ptyIdRef.current)) {
          invoke("pty_kill", { id: ptyIdRef.current }).catch(console.error);
        }
        ptyIdRef.current = null;
      }
      termRef.current = null;
      term.dispose();
    };
  }, []); // Solo montar/desmontar una vez

  // Cambiar de tema repinta la terminal en caliente. `options.theme` es reasignable, así
  // que no hace falta recrear nada: el proceso y todo el scrollback siguen intactos, solo
  // cambian los colores con los que se dibuja.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = TERMINAL_THEMES[theme];
    term.options.minimumContrastRatio = MIN_CONTRAST[theme];
  }, [theme]);

  // Foco automático al pasar a ser la terminal visible: cambiar de tab (o volver a
  // /workspace) debería dejar el cursor listo para escribir, sin un click extra sobre el
  // área negra.
  //
  // El rAF no es cosmético: cuando esto corre, el panel todavía tiene la `visibility` del
  // render anterior, y `focus()` sobre un elemento oculto es un no-op silencioso en
  // WebKitGTK. Esperar al frame siguiente garantiza que ya está visible.
  useEffect(() => {
    if (!isActive) return;
    const frame = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isActive]);

  return (
    <div className="relative flex flex-col h-full w-full">
      {/* Status badge. Flota sobre la terminal, así que sigue su paleta y no la de la app:
          en modo claro un recuadro negro acá se leería como un artefacto pegado encima. */}
      <div
        className={`absolute top-2 right-2 z-10 flex items-center gap-2 px-2 py-1 rounded-lg
          text-xs font-mono border
          ${isDark
            ? "bg-slate-900 border-slate-700"
            : "bg-white/90 border-gray-200 shadow-sm"}`}
      >
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
        <span className={isDark ? "text-white/80" : "text-gray-600"}>
          {status === "running"
            ? command
            : t(`terminal.status.${status}` as "terminal.status.connecting" | "terminal.status.exited")}
        </span>
      </div>

      {/* Contenedor de xterm.
          Sin `height: 100%`: con `flex: 1` dentro de un padre `flex-col` ya recibe el alto
          disponible, y declarar las dos cosas hacía que el alto se resolviera por dos
          caminos distintos (el algoritmo flex y el porcentaje contra el padre). En el
          borde inferior eso se veía como filas cortadas o tapadas.

          `background` igual al del tema de xterm: fit() calcula filas enteras, así que casi
          siempre sobran unos píxeles abajo que no llegan a una fila completa. Antes esa
          franja mostraba el fondo del panel y se leía como un glitch; ahora es del mismo
          color que la terminal y desaparece. */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          width: "100%",
          minHeight: 0,
          overflow: "hidden",
          padding: "8px",
          boxSizing: "border-box",
          // Mismo fondo que la paleta activa: la franja sobrante de menos de una fila que
          // queda abajo tiene que ser invisible en los dos temas, no solo en el oscuro.
          background: TERMINAL_THEMES[theme].background,
        }}
      />
    </div>
  );
}
