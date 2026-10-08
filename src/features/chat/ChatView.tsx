import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button } from "neogestify-ui-components";

import { useRunsStore } from "@/features/runs/store";
import type { PendingApproval } from "@/features/runs/types";
import { PermissionCard } from "@/features/runs/PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

import { ChatItems } from "./ChatItems";
import { Composer } from "./Composer";
import { chatStop, onChatEvent } from "./ipc";
import { useChatStore } from "./store";
import type { ChatItem } from "./types";

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

  const hidden = Math.max(0, items.length - limit);
  const shown = hidden > 0 ? items.slice(hidden) : items;
  const status = c?.chat.status ?? null;
  const statusText = !status
    ? t("chat.status.working")
    : status === "compacting"
      ? t("chat.status.compacting")
      : status.startsWith("retry:")
        ? t("chat.status.retry", { n: status.slice(6) })
        : t("chat.status.working");

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
        <div ref={content} className="max-w-3xl mx-auto px-4 pt-12 pb-6 flex flex-col gap-3">
          {hidden > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)} className="self-center text-[11.5px]">
              {t("chat.showEarlier", { count: hidden })}
            </Button>
          )}

          {c?.loaded && items.length === 0 && !busy && (
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <span className="text-[14px] font-medium text-gray-700 dark:text-gray-200">{t("chat.empty.title")}</span>
              <span className="text-[12px] text-gray-400 dark:text-white/35">{t("chat.empty.body")}</span>
            </div>
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
            <div className="flex items-center gap-2 text-[11.5px] text-gray-400 dark:text-white/35">
              <AnimateSpin className="w-3 h-3" />
              {c?.starting ? t("chat.status.starting") : statusText}
            </div>
          )}
        </div>
      </div>

      <Composer tab={tab} isActive={isActive} />
    </div>
  );
}
