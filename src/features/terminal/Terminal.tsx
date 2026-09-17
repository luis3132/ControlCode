import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useTheme } from "neogestify-ui-components";
import "@xterm/xterm/css/xterm.css";

import { isResumable } from "@/features/sessions/agentResume";
import { registerCapabilityResponders } from "@/features/terminal/terminalCapabilities";
import { installInputMarks } from "@/features/terminal/terminalMarks";
import { keepScrollbarVisible } from "@/features/terminal/terminalScrollbar";
import { registerTerminal } from "@/features/terminal/terminalRegistry";
import { installTerminalKeyHandler } from "@/features/terminal/terminalKeys";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { isLocalUrl } from "@/features/tabs/viewTabs";
import { awaitSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useAgentsStore } from "@/features/agents/store";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { useTerminalPrefsStore } from "@/features/terminal/prefsStore";
import { accountEnv as accountEnvFor } from "@/features/accounts/ipc";
import { resolvePrelaunch } from "@/features/prelaunch/ipc";
import { reconcileTabSkills } from "@/features/skills/ipc";
import { hasBrowserMcp, withBrowserMcp } from "@/features/browser/tabMcp";
import { homeDir } from "@/shared/ipc/window";
import { ptyAttach, ptyCreate, ptyKill, ptyResize, ptyWrite } from "./ipc";
import { createFitter } from "./fit";
import { StatusBadge, type TerminalStatus } from "./StatusBadge";
import { LOOKBACK_S, startSessionDiscovery } from "./sessionDiscovery";
import { MARK_LINE, MIN_CONTRAST, TERMINAL_FONT, TERMINAL_THEMES, terminalFontSize } from "./theme";

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
  /** Si se ve, tenga o no el teclado: con la pantalla dividida se ven varias a la vez, y
   *  todas se dibujan por GPU. Sin pasarlo, vale lo mismo que `isActive`. */
  isVisible?: boolean;
  /** Momento (epoch en segundos) en que se abrió la tab. Es el piso temporal para buscar
   * su sesión al RECONECTAR a un PTY ya vivo: ahí el proceso puede llevar horas corriendo,
   * así que usar "ahora" como piso descartaría la sesión que se está buscando. */
  openedAt?: number;
  /** Session id ya conocido de la tab. Si viene, no hace falta salir a descubrirlo. */
  knownSessionId?: string;
  /** Variables de entorno extra para ESTE proceso, además de las que declare la TUI custom. */
  env?: Record<string, string> | null;
  /** Cuenta (perfil) de la TUI con la que correr. Sus variables se resuelven acá adentro,
   *  justo antes de spawnear: si se resolvieran arriba, un render que llegue tarde lanzaría
   *  el proceso con la cuenta del sistema y ya no habría vuelta atrás. */
  accountId?: string;
  /** Comandos a ejecutar antes del agente, sin resolver todavía (ver el store `prelaunch`).
   *  Se resuelven acá adentro, justo antes de spawnear, por el mismo motivo que la cuenta. */
  prelaunch?: PrelaunchStep[];
  onReady?: (id: number) => void;
  onExit?: (code: number) => void;
  onSessionDiscovered?: (sessionId: string) => void;
}


/** Une los mapas de entorno, o `null` si no hay ninguno — que es lo que espera `pty_create`
 *  para "no agregues nada". Un `{}` funcionaría igual, pero `null` deja el intent explícito
 *  en el lado de Rust, donde el parámetro es `Option`. */
function mergeEnv(
  ...maps: Array<Record<string, string> | null | undefined>
): Record<string, string> | null {
  const merged = Object.assign({}, ...maps.filter(Boolean)) as Record<string, string>;
  return Object.keys(merged).length > 0 ? merged : null;
}

export function Terminal({
  tabId,
  command = "bash",
  cwd,
  agentId,
  attachPtyId,
  initialScrollback,
  isActive = false,
  isVisible = isActive,
  openedAt,
  knownSessionId,
  env,
  accountId,
  prelaunch,
  onReady,
  onExit,
  onSessionDiscovered,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<number | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const { t } = useTranslation();
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const { theme } = useTheme();
  const isDark = theme === "dark";
  // El efecto de montaje corre una sola vez (`[]`) y no debe re-crear la terminal al
  // cambiar el tema — leerlo por ref evita meterlo en las dependencias y matar el PTY.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Se apaga solo si el contexto se pierde: reintentar es lo que encadena el desastre. */
  const gpuBrokenRef = useRef(false);
  // Reactivo (no `getState()`): apagarlo en Configuración tiene que soltar el contexto de
  // la terminal que estés mirando en ese momento, no en la próxima que abras.
  const gpuRenderer = useTerminalPrefsStore((s) => s.gpuRenderer && s.compositing);
  const zoom = useTerminalPrefsStore((s) => s.zoom);

  // ── Renderizador por GPU, SOLO en las terminales que se ven ──────────────
  //
  // Por defecto xterm dibuja con el DOM: un `<span>` por tramo de texto. Es el camino más
  // compatible y el más borroso — el navegador redondea cada celda a píxeles CSS, y con
  // escalado fraccionario (Wayland al 125%) la grilla queda corrida. WebGL rasteriza los
  // glifos a la resolución REAL del dispositivo.
  //
  // Lo importante es el "solo en las que se ven". Cada terminal viva pedía su propio
  // contexto WebGL, y acá TODAS las tabs quedan montadas para no matar sus procesos: con
  // unas pocas abiertas se llega al tope de contextos del motor, y a partir de ahí se
  // pierden en cadena — parpadeos, paneles en blanco, terminales que dejan de pintar.
  // Atado a lo que está en pantalla, nunca hay más que grupos en la pantalla dividida.
  //
  // Y si el contexto igual se pierde, no se reintenta: se queda en DOM para siempre. Un
  // reintento en bucle es peor que el problema que arregla.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !isVisible || !gpuRenderer || gpuBrokenRef.current) return;

    let addon: WebglAddon | null = null;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => {
        gpuBrokenRef.current = true;
        addon?.dispose();
        addon = null;
      });
      term.loadAddon(addon);
    } catch {
      // Sin WebGL en esta máquina se sigue con el DOM, que es el camino de siempre.
      gpuBrokenRef.current = true;
      addon = null;
    }

    return () => {
      addon?.dispose();
      addon = null;
    };
  }, [isVisible, gpuRenderer]);

  useEffect(() => {
    if (!containerRef.current) return;

    // ── 1. Inicializar xterm.js ──────────────────────────────
    const term = new XTerm({
      theme: TERMINAL_THEMES[themeRef.current],
      minimumContrastRatio: MIN_CONTRAST[themeRef.current],
      fontFamily: TERMINAL_FONT,
      fontSize: terminalFontSize(useTerminalPrefsStore.getState().zoom),
      // Un respiro mínimo entre líneas. Con 1 las descendentes de una línea tocaban las
      // mayúsculas de la siguiente, y el texto largo de un agente se leía como un bloque.
      // Los caracteres de caja y bloque no se cortan: xterm los dibuja él mismo, estirados
      // al alto de la celda.
      lineHeight: 1.1,
      cursorBlink: true,
      cursorStyle: "bar",
      // La barra de 1px desaparecía entre el antialiasing de las letras vecinas.
      cursorWidth: 2,
      scrollback: 5000,
      // `allowTransparency` estaba en true y era la causa del texto borroso: apaga el
      // camino rápido de fondo opaco y obliga a compositar cada celda, lo que se lleva
      // puesto el antialiasing de subpíxel. No servía para nada — los dos temas de la
      // terminal tienen fondo 100% opaco (ver theme.ts).
      allowTransparency: false,
      // Lo exige el addon de Unicode 11: `term.unicode` es API propuesta de xterm y sin
      // esta opción `loadAddon` LANZA. Faltaba, así que cada terminal reventaba al
      // montarse y se llevaba puesta la app entera.
      allowProposedApi: true,
      // Un glifo más ancho que su celda (los de Nerd Font, las líneas de Powerline) se
      // escala en vez de invadir la celda siguiente. Sin esto, una barra de progreso o un
      // prompt con iconos corre todo lo que tiene a la derecha.
      rescaleOverlappingGlyphs: true,
      vtExtensions: {
        // Protocolo de teclado de Kitty: la TUI lo pide si lo quiere, y con él distingue
        // lo que la codificación vieja confunde — Shift+Enter de Enter, Ctrl+I de Tab,
        // Escape de Alt. Encendido sin más rompía los acentos; ver `terminalKeys.ts`.
        kittyKeyboard: true,
      },
    });

    // Unicode 11 ANTES de escribir nada: xterm trae las tablas de ancho de Unicode 6, que
    // no conocen los emoji modernos ni varios rangos CJK. Con las viejas, un emoji ocupa
    // una celda cuando en pantalla ocupa dos, y a partir de ahí toda la línea queda
    // corrida. Los agentes imprimen emoji todo el tiempo, así que se nota enseguida.
    //
    // Va en try/catch por lo que acaba de pasar: un addon que solo mejora cómo se ve el
    // texto no puede tumbar la aplicación si falla. Sin él las tablas viejas siguen
    // funcionando; es peor, no es fatal.
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
    } catch (e) {
      console.error("no se pudo activar Unicode 11; se siguen usando las tablas de ancho viejas", e);
    }

    const fitAddon = new FitAddon();
    // Un link a un servidor de esta máquina ("Local: http://localhost:5173") se abre en una
    // tab de navegador, al lado del agente que lo levantó: es para probar lo que está
    // haciendo. Cualquier otro va al navegador del sistema.
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      if (cwd && isLocalUrl(uri)) useViewTabsStore.getState().openBrowser(cwd, uri);
      else openUrl(uri).catch(console.error);
    });

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    // Tab que no se escapa de la terminal, AltGr y los acentos (ver terminalKeys.ts).
    installTerminalKeyHandler(term);
    term.open(containerRef.current);
    termRef.current = term;
    const unregister = tabId ? registerTerminal(tabId, term) : undefined;

    // Las TUIs modernas preguntan qué sabe hacer la terminal y ESPERAN respuesta antes de
    // dibujar. xterm.js no contesta varias de esas consultas, y sin respuesta OpenCode se
    // queda mudo tras pasar a la pantalla alternativa — una terminal negra. Se registra
    // antes de lanzar el proceso para no perder la primera tanda, que llega enseguida.
    const disposeCapabilities = registerCapabilityResponders(term, (data) => {
      if (ptyIdRef.current !== null) {
        ptyWrite(ptyIdRef.current, data).catch(console.error);
      }
    });

    // La barra de scroll de xterm se esconde sola; se la deja fija cuando hay historial
    // que recorrer (ver terminalScrollbar.ts).
    const disposeScrollbar = keepScrollbarVisible(term, containerRef.current);

    // Marcas de corte en cada envío del usuario. Se lee la preferencia acá, al montar:
    // cambiarla no reconfigura las terminales que ya están abiertas (ver TerminalSection).
    const disposeMarks = useTerminalPrefsStore.getState().inputMarks
      ? installInputMarks(term, { line: MARK_LINE[themeRef.current] })
      : () => {};

    // Ajuste de la grilla al contenedor real (ver `fit.ts`: el PTY nace con este tamaño).
    const { fit: fitAndTrim, fitOnce } = createFitter(term, fitAddon, () => containerRef.current);


    // ── 2. Crear la sesión PTY en Rust ───────────────────────
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let stopDiscovery: (() => void) | null = null;
    let cancelled = false;
    /** El último tamaño que se le dijo al PTY. Con esto no se repite un resize que no
     *  cambia nada: cada uno es un SIGWINCH y un redibujo completo de la TUI. */
    let sentSize = "";

    const pollSessionId = (resolvedCwd: string, startedAfter: number) => {
      if (!agentId || !isResumable(agentId) || !onSessionDiscovered) return;
      // Ya se sabe cuál es: no hay nada que descubrir y cada intento cuesta (para OpenCode,
      // levantar un proceso que abre su base de datos entera).
      if (knownSessionId) return;

      stopDiscovery = startSessionDiscovery({
        agentId,
        cwd: resolvedCwd,
        startedAfter,
        // Con una cuenta alternativa los transcripts viven en SU carpeta, no en la del
        // sistema: sin esto no se encontraría ninguna sesión y la tab se quedaría para
        // siempre sin título ni posibilidad de reanudar.
        accountId: accountId ?? null,
        onFound: onSessionDiscovered,
      });
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
          const buffered = await ptyAttach(attachPtyId);
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
          const attachCwd: string = cwd ?? (await homeDir());
          pollSessionId(attachCwd, openedAt ?? Math.floor(Date.now() / 1000));

          await attachListeners(attachPtyId);
          // El área de terminal puede medir distinto que cuando el PTY nació (paneles
          // plegados, ventana redimensionada mientras la tab estaba en segundo plano).
          if (!cancelled) {
            sentSize = `${term.cols}x${term.rows}`;
            ptyResize(attachPtyId, term.cols, term.rows).catch(console.error);
          }
          return;
        }

        if (initialScrollback) term.write(initialScrollback);

        // Si el wizard dejó un setup de skills pendiente para esta tab (symlinks
        // todavía escribiéndose en su cwd), esperarlo antes de lanzar el proceso — si
        // el agente arranca primero, algunos escanean su carpeta de skills solo al
        // boot y nunca verían las que el usuario acaba de elegir.
        // Lo que no se pudo montar se DICE. Antes esto se perdía en un `console.error` del
        // webview y la tab arrancaba sin skills sin ninguna señal — que es exactamente el
        // síntoma "se abrió sin ninguna" que había que diagnosticar a ciegas.
        if (tabId) {
          const skillErrors = await awaitSkillSetup(tabId);
          for (const err of skillErrors) {
            term.write(`\r\n\x1b[33m${t("terminal.skillSetupFailed", { error: err })}\x1b[0m\r\n`);
          }
        }
        if (cancelled) return;

        // Toda tab que arranca (nueva, restaurada o reabierta desde el historial) deja su
        // carpeta de skills con exactamente las suyas: las de su workspace más las
        // propias, y ninguna de otro workspace/tab que hubiera usado antes esa carpeta.
        // Tiene que pasar ANTES de spawnear: varios agentes escanean sus skills una sola
        // vez, al boot.
        if (tabId) await reconcileTabSkills(tabId).catch(console.error);
        if (cancelled) return;

        await fitOnce();
        if (cancelled) return;

        const resolvedCwd: string = cwd ?? (await homeDir());
        const startedAfter = Math.floor(Date.now() / 1000) - LOOKBACK_S;

        // Si esta tab corre con una cuenta alternativa, sus variables se piden ahora: la
        // cuenta pudo renombrarse o mudarse desde que la tab se guardó, y lo que importa es
        // dónde vive AHORA. Si la cuenta ya no existe, se avisa y no se lanza nada — correr
        // igual usaría la cuenta del sistema en silencio, que es lo contrario de lo pedido.
        let accountEnv: Record<string, string> | null = null;
        if (accountId) {
          try {
            accountEnv = await accountEnvFor(accountId);
          } catch (e) {
            term.write(`\r\n\x1b[31m${t("terminal.accountMissing", { error: e })}\x1b[0m\r\n`);
            setStatus("exited");
            return;
          }
        }

        // La cadena se resuelve tan tarde como la cuenta, y por lo mismo: un preset pudo
        // editarse o borrarse desde que la tab se guardó. Un preset que ya no existe
        // ABORTA el lanzamiento — arrancar sin el paso pedido dejaría al agente corriendo
        // en el entorno equivocado, que es exactamente lo que la feature evita.
        let resolvedPrelaunch: string[] = [];
        if (prelaunch && prelaunch.length > 0) {
          try {
            resolvedPrelaunch = await resolvePrelaunch(prelaunch);
          } catch (e) {
            term.write(`\r\n\x1b[31m${t("terminal.prelaunchError", { error: e })}\x1b[0m\r\n`);
            setStatus("exited");
            return;
          }
        }

        // La tab arranca con el navegador de la app como MCP: así el agente puede abrir,
        // leer y probar la página del proyecto en su propia tab de navegador. El id de
        // ESTA tab viaja adentro del lanzamiento: es con lo que la app sabe de qué agente
        // viene cada pedido, y por lo tanto de qué color pintar su navegador.
        //
        // Cada TUI lo recibe a su manera y eso lo decide el catálogo, no un `if` con un id
        // adentro: mientras estuvo escrito acá, OpenCode arrancaba sin las tools y sin
        // decir por qué. `withBrowserMcp` devuelve el comando y las variables porque
        // OpenCode no tiene flag — el servidor va en su config, que se le pasa por entorno.
        const browser =
          agentId && tabId && hasBrowserMcp(agentId)
            ? await withBrowserMcp(command, resolvedCwd, tabId, agentId)
            : { command, env: {} };
        if (cancelled) return;

        const ptyId = await ptyCreate({
          command: browser.command,
          cwd: resolvedCwd,
          cols: term.cols,
          rows: term.rows,
          // Variables extra declaradas por la TUI custom, si esta tab corre una, más las
          // que traiga esta terminal en particular (una cuenta alternativa apunta acá la
          // variable de perfil de la TUI). Las de la terminal van últimas: son la decisión
          // más específica, tomada para este proceso y no para la TUI en general.
          env: mergeEnv(
            agentId
              ? useAgentsStore.getState().customAgents.find((a) => a.id === agentId)?.env
              : undefined,
            browser.env,
            accountEnv,
            env
          ),
          prelaunch: resolvedPrelaunch,
        });
        ptyIdRef.current = ptyId;
        sentSize = `${term.cols}x${term.rows}`;
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
        ptyWrite(ptyIdRef.current, data).catch(console.error);
      }
    });

    // ── 6. Resize automático ─────────────────────────────────
    // Dos ritmos distintos, a propósito.
    //
    // La GRILLA se ajusta en cada cuadro mientras cambia el tamaño: es local y barata, y es
    // lo que hace que la terminal acompañe el borde de la ventana en vez de quedar recortada
    // o con un hueco hasta que se suelta el mouse.
    //
    // El PTY, en cambio, se entera recién cuando el tamaño se estabiliza. Cada `pty_resize`
    // es un SIGWINCH, y cada SIGWINCH hace que la TUI redibuje la pantalla entera: mandarlos
    // por cuadro era el torrente que se veía como parpadeo y basura al redimensionar.
    let fitPending = false;
    let fitFrame = 0;
    let fitFallback: ReturnType<typeof setTimeout> | null = null;
    let ptyTimer: ReturnType<typeof setTimeout> | null = null;

    const runFit = () => {
      if (!fitPending) return;
      fitPending = false;
      cancelAnimationFrame(fitFrame);
      if (fitFallback) clearTimeout(fitFallback);
      const el = containerRef.current;
      // Un contenedor en 0×0 (tab recién creada) haría que fit() calcule contra una celda
      // sin medir y deje una grilla absurda.
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fitAndTrim();
    };

    const scheduleFit = () => {
      if (fitPending) return;
      fitPending = true;
      fitFrame = requestAnimationFrame(runFit);
      // Con la ventana minimizada u oculta no hay cuadros y el rAF no corre nunca. Sin este
      // respaldo, maximizar o redimensionar la ventana desde afuera dejaba a la TUI con el
      // tamaño viejo hasta el próximo resize visible.
      fitFallback = setTimeout(runFit, 150);
    };

    const sizeToPty = term.onResize(({ cols, rows }) => {
      if (ptyTimer) clearTimeout(ptyTimer);
      ptyTimer = setTimeout(() => {
        const size = `${cols}x${rows}`;
        if (ptyIdRef.current === null || size === sentSize) return;
        sentSize = size;
        ptyResize(ptyIdRef.current, cols, rows).catch(console.error);
      }, 120);
    });

    // Cambió el tamaño de la CELDA, no del contenedor: terminó de cargar la fuente, la
    // ventana pasó a un monitor con otra escala. Las mismas filas ya no entran igual.
    const refitOnCell = term.onDimensionsChange(scheduleFit);

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(containerRef.current);

    // ── 7. Cleanup ───────────────────────────────────────────
    return () => {
      cancelled = true;
      stopDiscovery?.();
      cancelAnimationFrame(fitFrame);
      if (fitFallback) clearTimeout(fitFallback);
      if (ptyTimer) clearTimeout(ptyTimer);
      resizeObserver.disconnect();
      sizeToPty.dispose();
      refitOnCell.dispose();
      disposeCapabilities();
      disposeMarks();
      disposeScrollbar();
      unlistenData?.();
      unlistenExit?.();
      if (ptyIdRef.current !== null) {
        // Antes había un guardia acá para no matar un PTY que estaba viajando a otra
        // ventana. Ese camino ya no existe: se cambia de workspace en el lugar, así que
        // desmontar una terminal siempre significa cerrarla.
        ptyKill(ptyIdRef.current).catch(console.error);
        ptyIdRef.current = null;
      }
      termRef.current = null;
      unregister?.();
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

  // El zoom de Configuración, en vivo y en todas las terminales abiertas. xterm vuelve a
  // medir la celda, y ese cambio de dimensiones reajusta la grilla y le avisa al PTY (paso
  // 6): la TUI se redibuja con las columnas nuevas sin reiniciar nada.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.fontSize = terminalFontSize(zoom);
  }, [zoom]);

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
    // El fondo va en el envoltorio de afuera: fit() calcula filas y columnas enteras, así
    // que casi siempre sobran unos píxeles abajo y a la derecha que no llegan a una celda.
    // Con el mismo color que la terminal, esa franja no se ve.
    <div
      className="relative flex flex-col h-full w-full"
      style={{ background: TERMINAL_THEMES[theme].background }}
    >
      <StatusBadge status={status} isDark={isDark} />

      {/* El margen alrededor del texto, en un envoltorio propio y NO en el contenedor de
          xterm: fit() mide ese contenedor incluyendo su padding, y con el padding ahí
          calculaba columnas de más que quedaban cortadas contra el borde (ver fit.ts). */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", padding: "8px 4px 6px 12px" }}>
        {/* Sin `height: 100%`: con `flex: 1` ya recibe el alto disponible, y declarar las
            dos cosas resolvía el alto por dos caminos (flex y porcentaje), que en el borde
            inferior se veía como filas cortadas o tapadas. */}
        <div ref={containerRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }} />
      </div>
    </div>
  );
}
