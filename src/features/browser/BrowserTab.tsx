import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Alert, ArrowLeftIcon, ArrowRightIcon, Button, CloseIcon, Select, TrashIcon, Tooltip,
} from "neogestify-ui-components";

import { ExternalIcon, GlobeIcon, PickIcon, RefreshIcon, SendIcon } from "@/app/icons";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { normalizeUrl, type BrowserView } from "@/features/tabs/viewTabs";
import { pasteIntoTab } from "@/features/terminal/terminalRegistry";

import pickerScript from "./picker.ts?script";
import { composePickMessage, toTargetUrl } from "./composeMessage";
import { previewDetectServers, previewResolve, type PreviewTarget } from "./ipc";
import { isPageMessage, type AppMessage, type PickedElement } from "./protocol";

function ToolButton({ label, onClick, disabled, active, children }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        // Contraste de texto, no de adorno: estos son los controles con los que se usa la
        // tab. Con el gris al 45% sobre el fondo oscuro, y encima atenuados al 35% mientras
        // la página no cargó, prácticamente no se veían.
        className={`cc-t relative flex items-center justify-center w-8 h-8 rounded-lg shrink-0
          disabled:text-gray-400 dark:disabled:text-white/30 disabled:hover:bg-transparent
          ${active
            ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-300"
            : "text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** Una acción propia de esta tab, con rótulo. Marcar y enviar no son iconos que alguien
 *  reconozca de un navegador: sin la palabra al lado había que pasar el mouse para saber
 *  qué hacían. */
function ActionButton({ hint, onClick, disabled, active, children }: {
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={hint} placement="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        className={`cc-t flex items-center gap-1.5 h-8 px-2.5 rounded-lg shrink-0 border text-[12px] font-semibold
          disabled:opacity-45 disabled:hover:bg-transparent
          ${active
            ? "bg-blue-600 border-blue-600 text-white hover:bg-blue-500"
            : "border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10"}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * Un navegador en una tab, para probar el proyecto al lado del agente que lo construye.
 *
 * La página se carga a través de un proxy local (ver `src-tauri/src/preview`) que le
 * agrega el selector de elementos. Con él se marcan partes de la página —un botón, una
 * tarjeta— y se le mandan a un agente con una nota: lo que llega es lo que el agente
 * necesita para encontrarlo en el código (componente, selector, HTML), no una captura.
 */
export function BrowserTab({ view, active }: { view: BrowserView; active: boolean }) {
  const { t } = useTranslation();
  const updateView = useViewTabsStore((s) => s.updateView);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activateTab = useTabsStore((s) => s.activateTab);
  const agents = useMemo(() => tabs.filter((tab) => tab.cwd === view.cwd), [tabs, view.cwd]);

  const [address, setAddress] = useState(view.url);
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [picks, setPicks] = useState<PickedElement[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [note, setNote] = useState("");
  const [agentId, setAgentId] = useState<string | null>(activeTabId);
  const [sent, setSent] = useState<{ tabId: string; title: string } | null>(null);
  const [servers, setServers] = useState<string[] | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  /** Dónde está parada la página, en la URL del proxy: es lo que se recarga. */
  const pageUrl = useRef<string | null>(null);

  const postToPage = useCallback((type: AppMessage["type"]) => {
    if (!target) return;
    iframe.current?.contentWindow?.postMessage({ source: "controlcode", type } satisfies AppMessage, target.proxyOrigin);
  }, [target]);

  const go = useCallback(async (input: string) => {
    const url = normalizeUrl(input);
    if (!url) {
      setError(t("browser.invalidUrl"));
      return;
    }
    try {
      const resolved = await previewResolve(url, pickerScript);
      // La misma dirección otra vez es "recargá": el `src` no cambia y el iframe no se
      // enteraría.
      if (iframe.current && iframe.current.src === resolved.proxiedUrl) iframe.current.src = resolved.proxiedUrl;
      setTarget(resolved);
      pageUrl.current = resolved.proxiedUrl;
      setAddress(url);
      setError(null);
      setPicking(false);
      updateView(view.id, { url, title: new URL(url).host });
    } catch (e) {
      setError(String(e));
    }
  }, [t, updateView, view.id]);

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
    const onMessage = (e: MessageEvent) => {
      // Solo lo que manda ESTE iframe: con dos navegadores abiertos, cada uno escucha lo suyo.
      if (e.source !== iframe.current?.contentWindow || !isPageMessage(e.data)) return;
      const msg = e.data;
      if (msg.type === "nav") {
        pageUrl.current = msg.payload.url;
        const shown = toTargetUrl(msg.payload.url, target.proxyOrigin, target.targetOrigin);
        setAddress(shown);
        let host = shown;
        try { host = new URL(shown).host; } catch { /* se queda con la URL entera */ }
        updateView(view.id, { url: shown, title: msg.payload.title || host });
      } else if (msg.type === "pick:selected") {
        const el = msg.payload.element;
        setPicks((prev) => [...prev.filter((p) => !(p.selector === el.selector && p.url === el.url)), el]);
        setPicking(msg.payload.keepPicking);
        setComposerOpen(true);
        setSent(null);
      } else if (msg.type === "pick:cancel") {
        setPicking(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [target, updateView, view.id]);

  // Esc también cancela con el foco afuera de la página (en la barra, por ejemplo).
  useEffect(() => {
    if (!picking || !active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPicking(false);
      postToPage("pick:off");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [picking, active, postToPage]);

  // Si el agente elegido se cerró, se propone el que esté activo.
  useEffect(() => {
    if (!agents.some((a) => a.id === agentId)) setAgentId(agents[0]?.id ?? null);
  }, [agents, agentId]);

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    postToPage(next ? "pick:on" : "pick:off");
  };

  const send = () => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !target || (picks.length === 0 && !note.trim())) return;
    const text = composePickMessage(
      picks,
      note,
      (url) => toTargetUrl(url, target.proxyOrigin, target.targetOrigin),
      {
        header: (url) => t("browser.message.header", { url }),
        page: t("browser.message.page"),
        selector: t("browser.message.selector"),
        component: t("browser.message.component"),
        attributes: t("browser.message.attributes"),
        html: "HTML",
        note: t("browser.message.note"),
      }
    );
    if (!pasteIntoTab(agent.id, text, true)) {
      setError(t("browser.agentNotReady"));
      return;
    }
    setSent({ tabId: agent.id, title: agent.title });
    setPicks([]);
    setNote("");
  };

  const shownError = error && (
    <div className="absolute inset-x-0 top-0 z-10 p-3"><Alert variant="danger">{error}</Alert></div>
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-[#0d1117]">
      <div className="flex items-center gap-1 h-11 shrink-0 px-2 border-b border-gray-200 dark:border-white/7">
        <ToolButton label={t("browser.back")} disabled={!target} onClick={() => postToPage("history:back")}>
          <ArrowLeftIcon className="w-4 h-4 stroke-2" />
        </ToolButton>
        <ToolButton label={t("browser.forward")} disabled={!target} onClick={() => postToPage("history:forward")}>
          <ArrowRightIcon className="w-4 h-4 stroke-2" />
        </ToolButton>
        <ToolButton label={t("browser.reload")} disabled={!target}
          onClick={() => { if (iframe.current && pageUrl.current) iframe.current.src = pageUrl.current; }}>
          <RefreshIcon className="w-4 h-4 stroke-2" />
        </ToolButton>

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

        <ActionButton
          hint={picking ? t("browser.pick.stop") : t("browser.pick.start")}
          disabled={!target}
          active={picking}
          onClick={togglePicking}
        >
          <PickIcon className="w-4 h-4 stroke-2" />
          {t("browser.pick.label")}
        </ActionButton>
        <ActionButton
          hint={t("browser.composer")}
          active={composerOpen}
          onClick={() => setComposerOpen((v) => !v)}
        >
          <SendIcon className="w-4 h-4 stroke-2" />
          {t("browser.composer.label")}
          {picks.length > 0 && (
            <span className={`min-w-4.5 h-4.5 px-1 rounded-full text-[10px] font-bold leading-[18px] text-center tabular-nums
              ${composerOpen ? "bg-white text-blue-600" : "bg-blue-600 text-white"}`}>
              {picks.length}
            </span>
          )}
        </ActionButton>
        <ToolButton label={t("browser.openExternal")} disabled={!target}
          onClick={() => openUrl(address).catch(console.error)}>
          <ExternalIcon className="w-4 h-4 stroke-2" />
        </ToolButton>
      </div>

      {picking && (
        <div className="shrink-0 px-3 py-1 text-[11px] text-center
          bg-blue-500 text-white dark:bg-blue-600">
          {t("browser.pick.hint")}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="relative flex-1 min-w-0 bg-white">
          {shownError}
          {target ? (
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
              className="w-full h-full border-0"
            />
          ) : (
            <div className="flex items-center justify-center h-full p-8 bg-gray-50 dark:bg-[#0d1117]">
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
        </div>

        {composerOpen && (
          <aside className="flex flex-col w-80 shrink-0 min-h-0 border-l border-gray-200 dark:border-white/7">
            <div className="flex items-center gap-2 h-9 shrink-0 pl-3.5 pr-2 border-b border-gray-200 dark:border-white/7">
              <span className="flex-1 text-[11.5px] font-semibold text-gray-700 dark:text-gray-300">
                {t("browser.picks", { count: picks.length })}
              </span>
              <button onClick={() => setComposerOpen(false)} aria-label={t("btn.close")}
                className="cc-t flex items-center justify-center w-6 h-6 rounded-md
                  text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
                <CloseIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 cc-scroll p-2.5 flex flex-col gap-1.5">
              {picks.length === 0 ? (
                <p className="px-1 py-4 text-center text-[11.5px] leading-relaxed text-gray-400 dark:text-white/30">
                  {t("browser.picks.empty")}
                </p>
              ) : picks.map((p, i) => (
                <div key={`${p.url}:${p.selector}`}
                  className="group flex flex-col gap-0.5 px-2.5 py-2 rounded-lg bg-white dark:bg-white/4
                    border border-gray-200 dark:border-white/8">
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
                rows={3}
                placeholder={t("browser.note")}
                className="w-full resize-none px-2.5 py-1.5 rounded-lg outline-none text-[12px] leading-relaxed
                  bg-white dark:bg-white/4 border border-gray-200 dark:border-white/10
                  focus:border-blue-500 dark:focus:border-blue-400
                  text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-white/25"
              />
              {agents.length === 0 ? (
                <p className="text-[11px] text-gray-400 dark:text-white/30">{t("browser.noAgents")}</p>
              ) : (
                <Select
                  value={agentId ?? ""}
                  onChange={(e) => setAgentId(e.target.value)}
                  options={agents.map((a) => ({ value: a.id, label: a.title }))}
                  size="sm"
                  variant="outline"
                />
              )}
              <Button size="sm" variant="primary" fullWidth
                disabled={!agentId || (picks.length === 0 && !note.trim())}
                onClick={send}>
                <SendIcon className="w-3.5 h-3.5" />
                {t("browser.send")}
              </Button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
