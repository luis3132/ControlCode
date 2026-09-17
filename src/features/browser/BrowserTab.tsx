import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Alert, ArrowLeftIcon, ArrowRightIcon, Button, CloseIcon, TrashIcon } from "neogestify-ui-components";

import {
  BugIcon, DevicesIcon, DotsIcon, ExternalIcon, GlobeIcon, PenIcon, PickIcon, RefreshIcon, SendIcon,
} from "@/app/icons";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { normalizeUrl, type BrowserView } from "@/features/tabs/viewTabs";
import { pasteIntoTab } from "@/features/terminal/terminalRegistry";

import pickerScript from "./picker.ts?script";
import runtimeScript from "./page/runtime.ts?script";
import { registerBrowserHost } from "./agentBridge";
import { newMarkId, rememberMarks } from "./markStore";
import { highlightAgent } from "./agentHighlight";
import { AgentPicker } from "./AgentPicker";
import { AnnotationBar, AnnotationCanvas, renderAnnotated, useAnnotationSession } from "./annotate/Annotator";
import { canvasToPng, freezePage, thumbnail, type FrozenPage } from "./annotate/capture";
import { composePickMessage, toTargetUrl, type AnnotatedCapture } from "./composeMessage";
import { composePointer } from "./markedView";
import { browserToolPrefix, hasBrowserMcp } from "./tabMcp";
import { DebugPanel, MIN_PANEL, type DebugTab } from "./debug/DebugPanel";
import { appendBatch, currentCounts, EMPTY_LOG, startDocument } from "./debugLog";
import { useDebugStore } from "./debugStore";
import { DeviceBar } from "./DeviceBar";
import { previewDetectServers, previewResolve, previewSaveCapture, type PreviewTarget } from "./ipc";
import { PageChannel } from "./pageChannel";
import { isPageMessage, type AppMessage, type PickedElement, type SimpleAppMessage } from "./protocol";
import { ResponsiveStage } from "./ResponsiveStage";
import { ActionButton, ToolbarSeparator, ToolButton } from "./toolbarButtons";
import { presetById, type Viewport } from "./viewport";

/** Lo que el proxy inyecta en cada página: el selector y el runtime (control del agente y
 *  captura de debug). Dos scripts sueltos en un solo archivo, así es un único pedido. */
const INJECTED = `${pickerScript}\n;${runtimeScript}`;

const PANEL_HEIGHT_KEY = "cc-browser-debug-height";

/**
 * Por debajo de este ancho la barra no entra en una fila: la dirección se queda con todo el
 * ancho y las acciones pasan a una fila que se despliega. Pasa enseguida con la pantalla
 * dividida — un navegador al lado de una terminal ya no tiene 700 px.
 */
const COMPACT_BELOW = 760;

function savedPanelHeight(): number {
  try {
    const n = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
    return Number.isFinite(n) && n >= MIN_PANEL ? n : 280;
  } catch {
    return 280;
  }
}

/** Una captura anotada que espera en el mensaje. */
interface PendingCapture extends AnnotatedCapture {
  thumb: string;
}

/** La captura como le sirve al agente: id, ruta y página, sin lo que es de la interfaz. */
const bare = (c: PendingCapture): AnnotatedCapture => ({ id: c.id, path: c.path, url: c.url });

/**
 * Un navegador en una tab, para probar el proyecto al lado del agente que lo construye.
 *
 * La página se carga a través de un proxy local (ver `src-tauri/src/preview`) que le
 * agrega el selector de elementos. Con él se marcan partes de la página —un botón, una
 * tarjeta— y se le mandan a un agente con una nota: lo que llega es lo que el agente
 * necesita para encontrarlo en el código (componente, selector, HTML).
 *
 * Y cuando lo que hay que mostrar es cómo se VE, se anota encima: la página se congela en
 * una foto, se dibuja sobre ella, y la foto con los dibujos va en el mismo mensaje.
 */
export function BrowserTab({ view, active }: { view: BrowserView; active: boolean }) {
  const { t } = useTranslation();
  const updateView = useViewTabsStore((s) => s.updateView);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  // Solo agentes: a una terminal `bash` no se le manda lo que marcaste — no lo lee nadie,
  // se pegaría como texto en un prompt de shell.
  const agents = useMemo(
    () => tabs.filter((tab) => tab.cwd === view.cwd && tab.agentId !== "bash"),
    [tabs, view.cwd]
  );

  const [address, setAddress] = useState(view.url);
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState<PickedElement[]>([]);
  const [captures, setCaptures] = useState<PendingCapture[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [note, setNote] = useState("");
  const [agentId, setAgentId] = useState<string | null>(activeTabId);
  const [sent, setSent] = useState<{ tabId: string; title: string } | null>(null);
  const [servers, setServers] = useState<string[] | null>(null);
  const [viewport, setViewportState] = useState<Viewport | null>(view.viewport ?? null);
  const [touch, setTouchState] = useState(view.touch ?? false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugTab, setDebugTab] = useState<DebugTab>("console");
  const [debugHeight, setDebugHeight] = useState(savedPanelHeight);
  const [docId, setDocId] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [frozen, setFrozen] = useState<(FrozenPage & { url: string }) | null>(null);
  const [freezing, setFreezing] = useState(false);
  const [savingCapture, setSavingCapture] = useState(false);
  const annotation = useAnnotationSession();
  const errors = useDebugStore((s) => currentCounts(s.logs[view.id] ?? EMPTY_LOG).errors);
  const root = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  /** Dónde está parada la página, en la URL del proxy: es lo que se recarga. */
  const pageUrl = useRef<string | null>(null);
  /** Lo que el agente lee sin esperar a un render: la última versión de cada cosa. */
  const targetRef = useRef<PreviewTarget | null>(null);
  const shownUrl = useRef(view.url);
  const viewportRef = useRef(viewport);
  const touchRef = useRef(touch);
  /** Cada documento que cargó con el runtime, y si ya llegó a DOMContentLoaded. */
  const doc = useRef<{ id: string | null; count: number; ready: boolean }>({ id: null, count: 0, ready: false });
  const loadWaiters = useRef(new Set<() => void>());
  /** Lo señalado, para que un agente lo lea sin esperar a un render. */
  const marksRef = useRef<{ picks: PickedElement[]; captures: PendingCapture[]; note: string }>({ picks: [], captures: [], note: "" });

  /** Quién espera a que la persona marque algo, cuando lo pidió un agente. */
  const pickWaiter = useRef<((element: PickedElement | null) => void) | null>(null);
  /** Un agente está esperando que señales algo: lo dice la barra. */
  const [agentAsking, setAgentAsking] = useState(false);

  const channel = useMemo(() => new PageChannel(() => (
    targetRef.current ? { window: iframe.current?.contentWindow ?? null, origin: targetRef.current.proxyOrigin } : null
  )), []);

  useEffect(() => () => {
    channel.dispose();
    useDebugStore.getState().drop(view.id);
  }, [channel, view.id]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      // Oculta (otra tab encima) mide 0: ahí no hay nada que decidir.
      if (el.clientWidth > 0) setCompact(el.clientWidth < COMPACT_BELOW);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const postToPage = useCallback((type: SimpleAppMessage["type"]) => {
    if (!target) return;
    iframe.current?.contentWindow?.postMessage({ source: "controlcode", type } satisfies AppMessage, target.proxyOrigin);
  }, [target]);

  const setViewport = useCallback((next: Viewport | null) => {
    viewportRef.current = next;
    setViewportState(next);
    updateView(view.id, { viewport: next });
  }, [updateView, view.id]);

  const setTouch = useCallback(async (next: boolean) => {
    touchRef.current = next;
    setTouchState(next);
    updateView(view.id, { touch: next });
    return channel.run({ op: "touch", on: next }, 8000);
  }, [channel, updateView, view.id]);

  /** `null` si cargó; el motivo si no. */
  const go = useCallback(async (input: string): Promise<string | null> => {
    const url = normalizeUrl(input);
    if (!url) {
      setError(t("browser.invalidUrl"));
      return t("browser.invalidUrl");
    }
    try {
      const resolved = await previewResolve(url, INJECTED);
      // La misma dirección otra vez es "recargá": el `src` no cambia y el iframe no se
      // enteraría.
      if (iframe.current && iframe.current.src === resolved.proxiedUrl) iframe.current.src = resolved.proxiedUrl;
      targetRef.current = resolved;
      shownUrl.current = url;
      setTarget(resolved);
      pageUrl.current = resolved.proxiedUrl;
      setAddress(url);
      setError(null);
      setPicking(false);
      updateView(view.id, { url, title: new URL(url).host });
      return null;
    } catch (e) {
      setError(String(e));
      return String(e);
    }
  }, [t, updateView, view.id]);

  const reload = useCallback(() => {
    if (iframe.current && pageUrl.current) iframe.current.src = pageUrl.current;
  }, []);

  // Lo que maneja un agente. Todo por refs: el pedido llega por fuera de React, y tiene
  // que ver la página como está AHORA, no como estaba en el último render.
  const goRef = useRef(go);
  const postRef = useRef(postToPage);
  goRef.current = go;
  postRef.current = postToPage;
  useEffect(() => registerBrowserHost({
    viewId: view.id,
    cwd: view.cwd,
    channel,
    navigate: async (url) => {
      const failure = await goRef.current(url);
      if (failure) throw new Error(failure);
    },
    history: (action) => (action === "reload" ? reload() : postRef.current(action === "back" ? "history:back" : "history:forward")),
    setViewport,
    viewport: () => viewportRef.current,
    setTouch,
    touch: () => touchRef.current,
    proxyOrigin: () => targetRef.current?.proxyOrigin ?? null,
    targetOrigin: () => targetRef.current?.targetOrigin ?? null,
    currentUrl: () => shownUrl.current,
    loadCount: () => doc.current.count,
    waitForLoad: (after, timeoutMs) => new Promise((resolve) => {
      const check = () => doc.current.count > after && doc.current.ready;
      if (check()) {
        resolve(true);
        return;
      }
      const wake = () => {
        if (!check()) return;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        loadWaiters.current.delete(wake);
        resolve(ok);
      };
      loadWaiters.current.add(wake);
    }),
    marks: () => {
      const { picks, captures, note } = marksRef.current;
      const hay = picks.length > 0 || captures.length > 0 || note.trim() !== "";
      return hay ? { picks, captures: captures.map(bare), note } : null;
    },
    screenshot: async (tag) => {
      const page = iframe.current;
      const frame = column.current;
      if (!page || !frame) throw new Error("La página todavía no está cargada.");
      // La foto es del webview: si la tab no está a la vista, saldría lo que esté encima.
      // Se la trae al frente antes de disparar, que además es lo que hace que el usuario
      // vea lo mismo que el agente.
      useViewTabsStore.getState().activateView(view.id);
      const frozen = await freezePage(page, frame);
      return previewSaveCapture(await canvasToPng(frozen.canvas), tag);
    },
    requestPick: (timeoutMs) => new Promise((resolve) => {
      // Un solo pedido a la vez: el anterior se da por cancelado en vez de quedar colgado.
      pickWaiter.current?.(null);
      const finish = (element: PickedElement | null) => {
        clearTimeout(timer);
        if (pickWaiter.current !== finish) return;
        pickWaiter.current = null;
        setAgentAsking(false);
        setPicking(false);
        postRef.current("pick:off");
        resolve(element);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      pickWaiter.current = finish;
      // Al frente: se le está pidiendo algo a la persona, y en una tab que no está a la
      // vista el pedido se vencería sin que nadie lo hubiera visto nunca.
      useViewTabsStore.getState().activateView(view.id);
      setAgentAsking(true);
      setPicking(true);
      postRef.current("pick:on");
    }),
  }), [channel, reload, setViewport, view.cwd, view.id]);

  // El espejo de lo señalado. En un efecto y no en el render: es para leerlo desde afuera
  // de React, cuando llega el pedido de un agente.
  useEffect(() => {
    marksRef.current = { picks, captures, note };
  }, [picks, captures, note]);

  useEffect(() => {
    if (view.url) go(view.url);
    else {
      previewDetectServers().then(setServers).catch(() => setServers([]));
      addressRef.current?.focus();
    }
    // Solo al abrir la tab: después navega el usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!target) return;
    const display = (url: string) => toTargetUrl(url, target.proxyOrigin, target.targetOrigin);
    const wakeLoadWaiters = () => {
      for (const wake of [...loadWaiters.current]) wake();
    };
    const onMessage = (e: MessageEvent) => {
      // Solo lo que manda ESTE iframe: con dos navegadores abiertos, cada uno escucha lo suyo.
      if (e.source !== iframe.current?.contentWindow || !isPageMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === "nav") {
        pageUrl.current = msg.payload.url;
        const shown = display(msg.payload.url);
        shownUrl.current = shown;
        setAddress(shown);
        let host = shown;
        try { host = new URL(shown).host; } catch { /* se queda con la URL entera */ }
        updateView(view.id, { url: shown, title: msg.payload.title || host });
        doc.current.ready = true;
        wakeLoadWaiters();
      } else if (msg.type === "page:ready") {
        const url = display(msg.payload.url);
        channel.documentChanged(url);
        doc.current = { id: msg.payload.doc, count: doc.current.count + 1, ready: false };
        setDocId(msg.payload.doc);
        useDebugStore.getState().apply(view.id, (log) => startDocument(log, msg.payload.doc, url, Date.now()));
        // Con esto la página aprende a quién mandarle lo que capturó durante la carga.
        (e.source as Window).postMessage({ source: "controlcode", type: "connect" } satisfies AppMessage, target.proxyOrigin);
        // Y el táctil se vuelve a poner: las hojas de estilo de la página nueva están sin
        // tocar, así que sin esto la emulación se apagaría sola al navegar.
        if (touchRef.current) channel.run({ op: "touch", on: true }, 8000).catch(() => undefined);
      } else if (msg.type === "page:reply") {
        channel.reply(msg.payload);
      } else if (msg.type === "debug:batch") {
        const batch = { ...msg.payload, url: display(msg.payload.url) };
        useDebugStore.getState().apply(view.id, (log) => appendBatch(log, batch));
      } else if (msg.type === "pick:selected") {
        const el = msg.payload.element;
        if (pickWaiter.current) {
          pickWaiter.current(el);
          return;
        }
        setPicks((prev) => [...prev.filter((p) => !(p.selector === el.selector && p.url === el.url)), el]);
        setPicking(msg.payload.keepPicking);
        setComposerOpen(true);
        setSent(null);
      } else if (msg.type === "pick:cancel") {
        pickWaiter.current?.(null);
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [channel, target, updateView, view.id]);

  // La página necesita saber si alguien la está mirando: con la tab en segundo plano, el
  // puntero del agente no se anima (nadie lo vería) y cada acción sale más rápido.
  useEffect(() => {
    if (!target) return;
    postToPage(active ? "view:shown" : "view:hidden");
  }, [active, target, postToPage]);

  // Esc también cancela con el foco afuera de la página (en la barra, por ejemplo).
  useEffect(() => {
    if (!picking || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      pickWaiter.current?.(null);
      setPicking(false);
      postToPage("pick:off");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [picking, active, postToPage]);

  // Con el panel abierto, la tab del agente elegido se prende de su color: es cómo se sabe
  // a cuál de tres «Claude Code» le va a llegar esto.
  useEffect(() => {
    if (!composerOpen || !agentId) return;
    highlightAgent(agentId);
    return () => highlightAgent(null);
  }, [composerOpen, agentId]);

  // Si el agente elegido se cerró, se propone el que esté activo.
  useEffect(() => {
    if (!agents.some((a) => a.id === agentId)) setAgentId(agents[0]?.id ?? null);
  }, [agents, agentId]);

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    postToPage(next ? "pick:on" : "pick:off");
  };

  /** Las acciones estaban desplegadas al empezar a anotar: se vuelven a desplegar al terminar. */
  const reopenActions = useRef(false);

  const startAnnotating = async () => {
    if (!target || freezing || frozen || !iframe.current || !column.current) return;
    if (picking) {
      setPicking(false);
      postToPage("pick:off");
    }
    // La barra de anotación es de una fila. Si la foto se sacara con las acciones abiertas
    // (dos filas), al congelar la página subiría esa diferencia y abajo asomaría la viva.
    // `freezePage` espera a que se dibuje esto antes de medir.
    reopenActions.current = compact && actionsOpen;
    if (reopenActions.current) setActionsOpen(false);
    setFreezing(true);
    setError(null);
    try {
      const page = await freezePage(iframe.current, column.current);
      annotation.reset();
      setFrozen({ ...page, url: shownUrl.current });
    } catch (e) {
      setError(t("browser.annotate.failed", { error: String(e) }));
      stopAnnotating();
    } finally {
      setFreezing(false);
    }
  };

  const stopAnnotating = useCallback(() => {
    setFrozen(null);
    if (reopenActions.current) setActionsOpen(true);
    reopenActions.current = false;
  }, []);

  const cancelAnnotating = stopAnnotating;

  const historyRef = useRef(annotation.history);
  historyRef.current = annotation.history;
  const finishAnnotating = async () => {
    if (!frozen || savingCapture) return;
    setSavingCapture(true);
    try {
      const annotated = renderAnnotated(frozen.canvas, historyRef.current.present);
      // El id va en el nombre del archivo: en la carpeta conviven las capturas del usuario
      // con las que sacan los agentes, y la ruta sola alcanza para saber cuál es cuál.
      const id = newMarkId("s");
      const path = await previewSaveCapture(await canvasToPng(annotated), `usuario-${id}`);
      setCaptures((prev) => [...prev, { id, path, url: frozen.url, thumb: thumbnail(annotated) }]);
      stopAnnotating();
      setComposerOpen(true);
      setSent(null);
    } catch (e) {
      setError(t("browser.annotate.saveFailed", { error: String(e) }));
    } finally {
      setSavingCapture(false);
    }
  };

  const attachments = picks.length + captures.length;

  const send = () => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !target || (attachments === 0 && !note.trim())) return;
    const display = (url: string) => toTargetUrl(url, target.proxyOrigin, target.targetOrigin);
    // Único: va en el aviso que recibe el agente y es con lo que lo busca después.
    const batchId = newMarkId("m");
    // Un agente con el MCP de Control Code no necesita el volcado: se le dice qué hay y lo
    // lee con `browser_marked`, que se lo describe como está AHORA —si algo cambió o quedó
    // tapado desde que se marcó, se entera— y le da un ref para tocarlo. Al que no lo
    // tiene se le manda todo servido, que es lo único que le puede llegar.
    const text = hasBrowserMcp(agent.agentId)
      ? composePointer(
        { picks: picks.length, captures: captures.length },
        display(picks[0]?.url ?? pageUrl.current ?? ""),
        note,
        captures.map((c) => c.path),
        batchId,
        browserToolPrefix(agent.agentId)
      )
      : composePickMessage(picks, note, display, captures.map(bare));
    if (!pasteIntoTab(agent.id, text, true)) {
      setError(t("browser.agentNotReady"));
      return;
    }
    setSent({ tabId: agent.id, title: agent.title });
    rememberMarks({
      id: batchId, agentId: agent.id, viewId: view.id, at: Date.now(),
      picks, captures: captures.map(bare), note,
    });
    setPicks([]);
    setCaptures([]);
    setNote("");
  };

  // `pointer-events-none` en la franja y el aviso por encima: si no, el aviso ocupa todo el
  // ancho y se come los clicks de la parte de arriba de la página, que queda muerta hasta
  // que se navegue. Y se puede cerrar, que es lo que uno intenta hacer primero.
  const shownError = error && (
    <div className="absolute inset-x-0 top-0 z-40 p-3 pointer-events-none">
      <Alert variant="danger" className="pointer-events-auto" onClose={() => setError(null)} closeLabel={t("btn.close")}>
        {error}
      </Alert>
    </div>
  );

  const navButtons = (
    <>
      <ToolButton label={t("browser.back")} disabled={!target} onClick={() => postToPage("history:back")}>
        <ArrowLeftIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("browser.forward")} disabled={!target} onClick={() => postToPage("history:forward")}>
        <ArrowRightIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
      <ToolButton label={t("browser.reload")} disabled={!target} onClick={reload}>
        <RefreshIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
    </>
  );

  const addressBar = (
    <form className="flex-1 min-w-0 mx-1.5" onSubmit={(e) => { e.preventDefault(); go(address); }}>
      <input
        ref={addressRef}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        onFocus={(e) => e.target.select()}
        placeholder={t("browser.address")}
        spellCheck={false}
        className="w-full h-8 px-3.5 rounded-full outline-none font-mono text-[12px]
          bg-white dark:bg-white/6 border border-gray-300 dark:border-white/12
          focus:border-blue-500 dark:focus:border-blue-400
          text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/35"
      />
    </form>
  );

  const pageActions = (
    <>
      <ActionButton
        hint={picking ? t("browser.pick.stop") : t("browser.pick.start")}
        disabled={!target}
        active={picking}
        onClick={togglePicking}
      >
        <PickIcon className="w-4 h-4 stroke-2" />
        {t("browser.pick.label")}
      </ActionButton>
      {/* Sin el tooltip de la app: se dibujaría encima de la página y saldría en la foto. */}
      <ActionButton plain hint={t("browser.annotate.start")} disabled={!target || freezing} active={freezing} onClick={startAnnotating}>
        <PenIcon className="w-4 h-4" />
        {freezing ? t("browser.annotate.capturing") : t("browser.annotate.label")}
      </ActionButton>
      <ActionButton
        hint={t("browser.composer")}
        active={composerOpen}
        onClick={() => setComposerOpen((v) => !v)}
      >
        <SendIcon className="w-4 h-4 stroke-2" />
        {t("browser.composer.label")}
        {attachments > 0 && (
          <span className={`min-w-4.5 h-4.5 px-1 rounded-full text-[10px] font-bold leading-[18px] text-center tabular-nums
            ${composerOpen ? "bg-white text-blue-600" : "bg-blue-600 text-white"}`}>
            {attachments}
          </span>
        )}
      </ActionButton>
    </>
  );

  const tabTools = (
    <>
      <ToolButton label={viewport ? t("browser.viewport.exit") : t("browser.viewport.enter")} active={!!viewport}
        onClick={() => {
          const next = viewport ? null : (presetById("phone") ?? null);
          setViewport(next);
          // Un teléfono es táctil. Entrar en modo teléfono con hover sería probar algo que
          // no existe; se apaga con el botón de al lado cuando se quiere comparar.
          setTouch(next !== null).catch(console.error);
        }}>
        <DevicesIcon className="w-4 h-4" />
      </ToolButton>
      <ToolButton label={t("browser.debug.toggle")} active={debugOpen} onClick={() => setDebugOpen((v) => !v)}>
        <BugIcon className="w-4 h-4" />
        {errors > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white
            text-[9.5px] font-bold leading-4 text-center tabular-nums">
            {errors > 99 ? "99+" : errors}
          </span>
        )}
      </ToolButton>
      <ToolButton label={t("browser.openExternal")} disabled={!target}
        onClick={() => openUrl(address).catch(console.error)}>
        <ExternalIcon className="w-4 h-4 stroke-2" />
      </ToolButton>
    </>
  );

  // Con las acciones plegadas, lo que pide atención (algo esperando en el mensaje, errores
  // en la consola) se avisa en el botón que las despliega.
  const pendingAttention = !actionsOpen && (attachments > 0 || errors > 0);

  const toolbar = frozen ? (
    <AnnotationBar
      session={annotation}
      compact={compact}
      busy={savingCapture}
      onCancel={cancelAnnotating}
      onDone={finishAnnotating}
    />
  ) : compact ? (
    <>
      <div className="flex items-center gap-1 h-11 shrink-0 px-2 border-b border-gray-200 dark:border-white/7">
        {addressBar}
        <ToolButton label={actionsOpen ? t("browser.actions.less") : t("browser.actions.more")} active={actionsOpen}
          onClick={() => setActionsOpen((v) => !v)}>
          <DotsIcon className="w-4 h-4" />
          {pendingAttention && (
            <span className={`absolute top-1 right-1 w-2 h-2 rounded-full ${errors > 0 ? "bg-red-600" : "bg-blue-600"}`} />
          )}
        </ToolButton>
      </div>
      {actionsOpen && (
        <div className="flex flex-wrap items-center gap-1 shrink-0 px-2 py-1.5 border-b border-gray-200 dark:border-white/7">
          {navButtons}
          <ToolbarSeparator />
          {pageActions}
          <ToolbarSeparator />
          {tabTools}
        </div>
      )}
    </>
  ) : (
    <div className="flex items-center gap-1 h-11 shrink-0 px-2 border-b border-gray-200 dark:border-white/7">
      {navButtons}
      {addressBar}
      {pageActions}
      <ToolbarSeparator />
      {tabTools}
    </div>
  );

  const capturesLabel = captures.length > 0 ? t("browser.captures", { count: captures.length }) : null;
  const composerTitle = [picks.length > 0 || !capturesLabel ? t("browser.picks", { count: picks.length }) : null, capturesLabel]
    .filter(Boolean)
    .join(" · ");

  return (
    <div ref={root} className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-[#0d1117]">
      {toolbar}

      {viewport && (
        // Congelada, la página no cambia de tamaño: la barra queda a la vista pero quieta.
        <div inert={frozen ? true : undefined} className={`shrink-0 ${frozen ? "opacity-50" : ""}`}>
          <DeviceBar
            viewport={viewport}
            touch={touch}
            onChange={setViewport}
            onTouch={(on) => { setTouch(on).catch(console.error); }}
            onClose={() => { setViewport(null); setTouch(false).catch(console.error); }}
          />
        </div>
      )}

      {picking && (
        <div className={`shrink-0 px-3 py-1 text-[11px] text-center text-white
          ${agentAsking ? "bg-violet-600 dark:bg-violet-700" : "bg-blue-500 dark:bg-blue-600"}`}>
          {agentAsking ? t("browser.pick.agentAsking") : t("browser.pick.hint")}
        </div>
      )}

      <div className={`flex flex-1 min-h-0 ${compact ? "flex-col" : ""}`}>
        <div ref={column} data-browser-column className="relative flex flex-col flex-1 min-w-0 min-h-0">
          {shownError}
          {target ? (
            <ResponsiveStage viewport={viewport} onResize={setViewport}>
            <iframe
              ref={iframe}
              src={target.proxiedUrl}
              title={view.title || view.url}
              onLoad={() => {
                postToPage("hello");
                // La página nueva arranca con el selector apagado; si estaba eligiendo, sigue.
                if (picking) postToPage("pick:on");
              }}
              // Sin `allow-top-navigation`: una página que intente redirigir la ventana
              // entera (los clásicos anti-iframe) no puede sacar a la app de sí misma.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
              allow="clipboard-read; clipboard-write; fullscreen"
              className="block w-full h-full border-0"
            />
            </ResponsiveStage>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 bg-gray-50 dark:bg-[#0d1117]">
              <div className="flex flex-col items-center gap-4 max-w-sm text-center">
                <span className="flex items-center justify-center w-12 h-12 rounded-2xl
                  bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <GlobeIcon className="w-6 h-6" />
                </span>
                <div>
                  <p className="text-[14px] font-semibold text-gray-800 dark:text-gray-100">{t("browser.start.title")}</p>
                  <p className="mt-1 text-[12px] text-gray-500 dark:text-white/40">{t("browser.start.desc")}</p>
                </div>
                {servers === null ? (
                  <p className="text-[11px] text-gray-400 dark:text-white/30">{t("browser.start.detecting")}</p>
                ) : servers.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {servers.map((url) => (
                      <button key={url} onClick={() => go(url)}
                        className="cc-t px-3 h-7 rounded-full font-mono text-[11.5px]
                          bg-white dark:bg-white/5 border border-gray-200 dark:border-white/10
                          text-gray-700 dark:text-gray-300 hover:border-blue-500 dark:hover:border-blue-400">
                        {url.replace("http://", "")}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-400 dark:text-white/30">{t("browser.start.none")}</p>
                )}
              </div>
            </div>
          )}
          {debugOpen && target && (
            <DebugPanel
              viewId={view.id}
              channel={channel}
              proxyOrigin={target.proxyOrigin}
              targetOrigin={target.targetOrigin}
              docId={docId}
              tab={debugTab}
              onTab={setDebugTab}
              height={debugHeight}
              onHeight={(h) => {
                setDebugHeight(h);
                try { localStorage.setItem(PANEL_HEIGHT_KEY, String(h)); } catch { /* recordarlo es cortesía */ }
              }}
              onClose={() => setDebugOpen(false)}
            />
          )}
          {frozen && (
            <AnnotationCanvas frozen={frozen} session={annotation} active={active} onCancel={cancelAnnotating} />
          )}
        </div>

        {composerOpen && (
          // Angosta, el mensaje va abajo: al costado le quitaría a la página casi todo el ancho.
          <aside className={compact
            ? "flex flex-col shrink-0 max-h-[55%] min-h-0 border-t border-gray-200 dark:border-white/7"
            : "flex flex-col w-80 shrink-0 min-h-0 border-l border-gray-200 dark:border-white/7"}>
            <div className="flex items-center gap-2 h-9 shrink-0 pl-3.5 pr-2 border-b border-gray-200 dark:border-white/7">
              <span className="flex-1 min-w-0 truncate text-[11.5px] font-semibold text-gray-700 dark:text-gray-300">
                {composerTitle}
              </span>
              <button onClick={() => setComposerOpen(false)} aria-label={t("btn.close")}
                className="cc-t flex items-center justify-center w-6 h-6 rounded-md
                  text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
                <CloseIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className={`flex-1 min-h-0 cc-scroll p-2.5 gap-1.5 ${compact && attachments > 0 ? "flex flex-row flex-wrap content-start" : "flex flex-col"}`}>
              {attachments === 0 ? (
                <p className="px-1 py-4 text-center text-[11.5px] leading-relaxed text-gray-400 dark:text-white/30">
                  {t("browser.picks.empty")}
                </p>
              ) : (
                <>
                  {captures.map((c) => (
                    <div key={c.id}
                      className={`group relative flex flex-col shrink-0 rounded-lg overflow-hidden bg-white dark:bg-white/4
                        border border-gray-200 dark:border-white/8 ${compact ? "w-44" : ""}`}>
                      <img src={c.thumb} alt="" className="block w-full max-h-36 object-contain bg-gray-100 dark:bg-black/30" />
                      <div className="flex items-center gap-1.5 min-w-0 px-2 py-1.5">
                        <PenIcon className="w-3 h-3 shrink-0 text-blue-600 dark:text-blue-400" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-gray-500 dark:text-white/45" title={c.path}>
                          {c.url}
                        </span>
                        <button onClick={() => setCaptures((prev) => prev.filter((x) => x.id !== c.id))}
                          aria-label={t("btn.delete")}
                          className="cc-t flex items-center justify-center w-5 h-5 shrink-0 rounded
                            text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-white/10">
                          <TrashIcon className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {picks.map((p, i) => (
                    <div key={`${p.url}:${p.selector}`}
                      className={`group flex flex-col gap-0.5 px-2.5 py-2 rounded-lg bg-white dark:bg-white/4
                        border border-gray-200 dark:border-white/8 ${compact ? "w-44 shrink-0" : ""}`}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="shrink-0 text-[10px] tabular-nums text-gray-400">{i + 1}</span>
                        <span className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-gray-800 dark:text-gray-100">
                          {`<${p.tag}>`}{p.component && <span className="text-blue-600 dark:text-blue-400"> {p.component.name}</span>}
                        </span>
                        <div className="flex-1" />
                        <button onClick={() => setPicks((prev) => prev.filter((_, j) => j !== i))}
                          aria-label={t("btn.delete")}
                          className="cc-t hidden group-hover:flex items-center justify-center w-5 h-5 rounded
                            text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-white/10">
                          <TrashIcon className="w-3 h-3" />
                        </button>
                      </div>
                      {p.text && <span className="truncate text-[11px] text-gray-500 dark:text-white/45">«{p.text}»</span>}
                      <span className="truncate font-mono text-[10px] text-gray-400 dark:text-white/30" title={p.selector}>
                        {p.selector}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>

            <div className="flex flex-col gap-2 shrink-0 p-2.5 border-t border-gray-200 dark:border-white/7">
              {sent && (
                <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-400">
                  <span className="flex-1 min-w-0 truncate">{t("browser.sent", { agent: sent.title })}</span>
                  <button onClick={() => activateTab(sent.tabId)} className="shrink-0 underline underline-offset-2">
                    {t("browser.goToAgent")}
                  </button>
                </div>
              )}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
                }}
                rows={compact ? 2 : 3}
                placeholder={t("browser.note")}
                className="w-full resize-none px-2.5 py-1.5 rounded-lg outline-none text-[12px] leading-relaxed
                  bg-white dark:bg-white/4 border border-gray-200 dark:border-white/10
                  focus:border-blue-500 dark:focus:border-blue-400
                  text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
              />
              <div className={compact ? "flex items-center gap-2" : "flex flex-col gap-2"}>
                {agents.length === 0 ? (
                  <p className="flex-1 text-[11px] text-gray-400 dark:text-white/30">{t("browser.noAgents")}</p>
                ) : (
                  <div className={compact ? "flex-1 min-w-0" : undefined}>
                    <AgentPicker agents={agents} value={agentId} onChange={setAgentId} compact={compact} />
                  </div>
                )}
                <Button size="sm" variant="primary" fullWidth={!compact}
                  disabled={!agentId || (attachments === 0 && !note.trim())}
                  onClick={send}>
                  <SendIcon className="w-3.5 h-3.5" />
                  {t("browser.send")}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
