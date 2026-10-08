import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, ChevronDownIcon, ChevronUpIcon, Tooltip } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";
import { useAgentAccounts } from "@/features/tabs/wizard/AccountPickerStep";

import { useRunsStore } from "@/features/runs/store";
import type { PendingApproval } from "@/features/runs/types";
import { PermissionCard } from "@/features/runs/PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

import { ChatItems } from "./ChatItems";
import { agentWords, chatDefaults, chatModels, type ChatDefaults } from "./ipc";
import { useWorkingWords } from "./workingWords";
import { modelChoices, modelShownAs } from "./message";
import { Composer } from "./Composer";
import { chatStop, onChatEvent } from "./ipc";
import { useChatStore } from "./store";
import type { ChatItem, LiveUsage } from "./types";

/** Cuántas cosas se dibujan de entrada; las anteriores, a pedido. Una sesión larga tiene
 *  miles, y cada una es Markdown o una tarjeta. */
const PAGE = 150;

/** A cuántos px del final todavía se considera "abajo de todo": ahí el chat sigue lo nuevo. */
const STICK_PX = 80;

function toolIds(items: ChatItem[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.kind !== "tool") continue;
    out.add(item.toolUseId);
    toolIds(item.children, out);
  }
  return out;
}

/**
 * Una tab de Claude Code en modo HTML: la conversación dibujada por la app y un input
 * propio, en vez de la TUI en una terminal. Cada mensaje es un turno `claude -p --resume`
 * sobre la misma sesión (ver `src-tauri/src/chat`), así que se puede volver a la consola
 * en cualquier momento y sigue la misma conversación.
 */
export function ChatView({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const { t } = useTranslation();
  const tabId = tab.id;
  const c = useChatStore((s) => s.chats[tabId]);
  const load = useChatStore((s) => s.load);
  const allApprovals = useRunsStore((s) => s.approvals);
  const decideApproval = useRunsStore((s) => s.decideApproval);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    load(tab).catch(console.error);
    // Solo al montar: después la conversación la mantienen los eventos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    const unlisten = onChatEvent(tabId, (env) => useChatStore.getState().onEnvelope(tabId, env));
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
      // Se desmonta porque la tab se cerró: su turno no tiene a quién contarle nada.
      if (!useTabsStore.getState().tabs.some((tb) => tb.id === tabId)) {
        chatStop(tabId).catch(() => {});
        useChatStore.getState().forget(tabId);
      }
    };
  }, [tabId]);

  const items = c?.chat.items ?? [];
  const busy = !!c && (c.running || c.starting);

  // Los permisos de esta tab, junto a la herramienta que los pidió. Uno que no se puede
  // ubicar (llegó antes que su herramienta) va al final, para que nunca quede sin verse.
  const { byTool, loose } = useMemo(() => {
    const mine = allApprovals.filter((a) => a.tabId === tabId);
    const known = toolIds(items);
    const byTool = new Map<string, PendingApproval>();
    const loose: PendingApproval[] = [];
    for (const a of mine) {
      if (a.toolUseId && known.has(a.toolUseId) && !byTool.has(a.toolUseId)) byTool.set(a.toolUseId, a);
      else loose.push(a);
    }
    return { byTool, loose };
  }, [allApprovals, tabId, items]);

  const decide = (approval: PendingApproval, allow: boolean, remember: boolean) => {
    decideApproval(approval.id, allow, remember).catch((e) =>
      useChatStore.getState().notice(tabId, "error", String(e))
    );
  };

  // Abajo de todo se queda abajo mientras llega lo nuevo; si la persona subió a leer, no
  // se la arrastra. Por tamaño y no por cambio de datos: el Markdown, una tarjeta que se
  // despliega o una imagen crecen después del render que los trajo.
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = () => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const ro = new ResizeObserver(follow);
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // Ir al mensaje anterior (o siguiente) escrito por la persona. En una conversación larga
  // los propios pedidos son las marcas que uno busca al releer: el scroll los pasa de largo
  // y volver a encontrarlos a rueda es lo que cansa.
  const jump = useCallback((dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top;
    const tops = [...el.querySelectorAll<HTMLElement>("[data-chat-user]")]
      .map((m) => Math.round(m.getBoundingClientRect().top - base + el.scrollTop));
    if (tops.length === 0) return;
    // Un margen chico para que "anterior" no devuelva el mismo que ya está arriba de todo.
    const cur = el.scrollTop + 4;
    const target = dir === -1
      ? [...tops].reverse().find((top) => top < cur - 8)
      : tops.find((top) => top > cur + 8);
    if (target === undefined) return;
    stuck.current = false;
    el.scrollTo({ top: Math.max(0, target - 16), behavior: "smooth" });
  }, []);

  const userMarks = items.filter((i) => i.kind === "user").length;
  const hidden = Math.max(0, items.length - limit);
  const shown = hidden > 0 ? items.slice(hidden) : items;
  const status = c?.chat.status ?? null;
  // Mientras no esté pasando nada que contar, el estado es una palabra al azar que va
  // cambiando, como en la consola. Compactar o reintentar SÍ son algo que contar, y ahí
  // gana el texto de verdad: la gracia de la palabra tonta es que aparece cuando no hay
  // noticias, no que tape una.
  const word = useWorkingWord(busy && !status, tab.agentId);
  const statusText = !status
    ? word
    : status === "compacting"
      ? t("chat.status.compacting")
      : status.startsWith("retry:")
        ? t("chat.status.retry", { n: status.slice(6) })
        : word;

  return (
    <div className="absolute inset-0 flex flex-col bg-white dark:bg-[#0d1117]">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <div ref={content} className="w-full px-5 lg:px-8 pt-10 pb-8 flex flex-col gap-5">
          {hidden > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)} className="self-center text-[11.5px]">
              {t("chat.showEarlier", { count: hidden })}
            </Button>
          )}

          {c?.loaded && items.length === 0 && !busy && (
            <StartBanner tab={tab} model={c?.model ?? null} effort={c?.effort ?? null} />
          )}

          <ChatItems items={shown} running={busy} approvals={byTool} onDecide={decide} focused={isActive} />

          {loose.map((a) => (
            <div key={a.id} className="-mx-3">
              {a.toolName === "AskUserQuestion"
                ? <div className="mx-3"><QuestionCard approval={a} /></div>
                : <PermissionCard approval={a} focused={isActive} onDecide={(allow, remember) => decide(a, allow, remember)} />}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 self-start px-2.5 h-7 rounded-full text-[11.5px]
              bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-white/50">
              <AnimateSpin className="w-3 h-3" />
              {c?.starting ? t("chat.status.starting") : statusText}
              <Working since={c?.startedAt ?? null} usage={c?.chat.usage ?? null} />
            </div>
          )}
        </div>
      </div>

      {userMarks > 1 && (
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 z-10 flex flex-col
          rounded-full overflow-hidden opacity-45 hover:opacity-100 transition-opacity
          border border-gray-200 dark:border-white/10
          bg-white/95 dark:bg-[#161b22]/95 shadow-sm backdrop-blur">
          <Tooltip content={t("chat.jump.prev")} placement="left">
            <Button variant="custom" onClick={() => jump(-1)} aria-label={t("chat.jump.prev")} className={JUMP}>
              <ChevronUpIcon className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={t("chat.jump.next")} placement="left">
            <Button variant="custom" onClick={() => jump(1)} aria-label={t("chat.jump.next")} className={JUMP}>
              <ChevronDownIcon className="w-3.5 h-3.5" />
            </Button>
          </Tooltip>
        </div>
      )}

      <Composer tab={tab} isActive={isActive} />
    </div>
  );
}

const JUMP = `cc-t w-7 h-7 flex items-center justify-center
  text-gray-500 dark:text-white/50
  hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white`;

/**
 * Con qué va a arrancar una conversación nueva: el agente, su versión, el modelo y el
 * esfuerzo, la cuenta y la carpeta.
 *
 * Es lo mismo que escribe la TUI al abrirse, y por el mismo motivo: antes del primer
 * mensaje, lo único que hace falta saber es con qué se va a hablar y desde dónde. Pedirlo
 * mirando tres selectores distintos es peor que leerlo en tres renglones.
 */
function StartBanner({ tab, model, effort }: { tab: Tab; model: string | null; effort: string | null }) {
  const { t } = useTranslation();
  const Icon = agentIcon(tab.agentId, tab.command);
  const detected = useTabsStore((s) => s.detectedAgents.find((a) => a.id === tab.agentId));
  const accounts = useAgentAccounts(tab.agentId);
  const account = tab.accountId ? accounts.find((a) => a.id === tab.accountId) : null;
  // Lo que la propia TUI tiene configurado, para no decir "predeterminado" cuando se puede
  // decir cuál. Es su `settings.json`, la misma fuente que ella lee al arrancar.
  const [defaults, setDefaults] = useState<ChatDefaults | null>(null);
  useEffect(() => {
    let stale = false;
    chatDefaults(tab.cwd, tab.accountId ?? null)
      .then((d) => { if (!stale) setDefaults(d); })
      .catch(console.error);
    return () => { stale = true; };
  }, [tab.cwd, tab.accountId]);

  // La versión, no el alias: `opus` en la configuración dice "Opus 5.5" acá.
  const [known, setKnown] = useState<{ id: string; name: string | null }[]>([]);
  useEffect(() => {
    let stale = false;
    chatModels(tab.accountId ?? null)
      .then((list) => { if (!stale) setKnown(list); })
      .catch(console.error);
    return () => { stale = true; };
  }, [tab.accountId]);
  const shownModel = model ?? defaults?.model ?? null;
  const shownEffort = effort ?? defaults?.effort ?? null;
  const specs = [
    shownModel ? modelShownAs(shownModel, modelChoices(known, [])) : t("chat.model.default"),
    shownEffort ? t("chat.banner.effort", { level: t(`chat.effort.${shownEffort}`, { defaultValue: shownEffort }) }) : null,
    // Ultracode no se puede pedir desde acá (no hay flag en `-p`), pero si está puesto en la
    // TUI, los turnos salen con eso: callarlo sería esconder con qué se está corriendo.
    defaults?.ultracode ? "Ultracode" : null,
    tab.accountId ? (account?.label ?? account?.name ?? t("chat.banner.account")) : t("accounts.system"),
  ].filter(Boolean);

  return (
    // Arriba de todo, como el banner de la TUI: es lo primero que se lee al abrir, no algo
    // centrado en el vacío.
    <div className="flex items-start gap-4 pt-1 pb-10">
      {/* El naranja de Claude Code, el mismo con el que se dibuja en su propia consola. El
          icono es el único lugar donde la marca del agente tiene sentido: el resto de la
          pantalla es de la app. */}
      <Icon className="w-11 h-11 shrink-0 text-[#d97757]" />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-[14px] font-bold text-gray-900 dark:text-white">{tab.agentLabel}</span>
          {detected?.version && (
            <span className="font-mono text-[11.5px] text-gray-400 dark:text-white/35">
              v{detected.version.replace(/^v/, "").split(" ")[0]}
            </span>
          )}
        </span>
        <span className="text-[12.5px] text-gray-500 dark:text-white/45">{specs.join(" · ")}</span>
        <span className="font-mono text-[11.5px] text-gray-400 dark:text-white/30 break-all">{shortCwd(tab.cwd)}</span>
        <span className="mt-2 text-[12px] text-gray-400 dark:text-white/35">{t("chat.empty.body")}</span>
      </div>
    </div>
  );
}

/** `/home/luis/Documents/x` → `~/Documents/x`, como lo escribe la TUI. */
function shortCwd(cwd: string): string {
  const home = /^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:\\Users\\[^\\]+)/.exec(cwd)?.[1];
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * El reloj y lo gastado mientras el turno corre, como la línea de la TUI.
 *
 * Avanza de verdad (un número congelado diría "0 s" para siempre) y los tokens son los que
 * informa el stream: el contexto que entró y lo que lleva escrito. Es lo que deja decidir
 * si vale la pena esperar o cortar.
 */
function Working({ since, usage }: { since: number | null; usage: LiveUsage | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const parts = [
    since ? clock(Math.max(0, Math.floor((now - since) / 1000))) : null,
    usage?.input ? `↓ ${tokens(usage.input)}` : null,
    usage?.output ? `↑ ${tokens(usage.output)}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="tabular-nums opacity-70">· {parts.join(" · ")}</span>;
}

function clock(secs: number): string {
  if (secs < 60) return `${secs} s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m ${String(secs % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Cada cuánto cambia la palabra de "trabajando". Lo bastante seguido para que se note que
 *  sigue vivo, lo bastante espaciado para no competir con lo que se está leyendo. */
const WORD_EVERY = 9000;

/**
 * La palabra que acompaña al spinner: una al azar de las que trae la propia TUI.
 *
 * La lista **no es de la app**: es la de Claude Code, leída de su binario (ver
 * `agents/words.rs`). No la manda el servidor —no está en las features que la CLI cachea ni
 * en su configuración— y el stream de `-p` tampoco la dice, así que leerla de ahí es la
 * única forma de mostrar las mismas. Si no se encuentran, queda el "trabajando" de siempre:
 * mejor nuestro texto neutro que inventarle palabras a otro.
 */
function useWorkingWord(active: boolean, agentId: string): string {
  const { t } = useTranslation();
  const [fromTui, setFromTui] = useState<string[]>([]);
  const [word, setWord] = useState("");
  // La lista editada en Ajustes pisa a la de la TUI, y el cambio se ve sin reabrir la tab.
  const custom = useWorkingWords((s) => s.custom);
  const loadCustom = useWorkingWords((s) => s.load);

  useEffect(() => {
    loadCustom().catch(console.error);
  }, [loadCustom]);

  useEffect(() => {
    let stale = false;
    agentWords(agentId)
      .then((list) => { if (!stale) setFromTui(list); })
      .catch(console.error);
    return () => { stale = true; };
  }, [agentId]);

  const words = custom ?? fromTui;

  useEffect(() => {
    if (!active || words.length === 0) return;
    const pick = () => setWord(`${words[Math.floor(Math.random() * words.length)]}…`);
    // Una palabra nueva por turno, y después cada tanto: un texto fijo durante dos minutos
    // parece colgado.
    pick();
    const id = setInterval(pick, WORD_EVERY);
    return () => clearInterval(id);
  }, [active, words]);

  return word || t("chat.status.working");
}
