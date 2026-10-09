import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, ChevronDownIcon, ChevronRightIcon } from "neogestify-ui-components";

import { Markdown } from "@/shared/ui/Markdown";
import type { PendingApproval } from "@/features/runs/types";

import { ToolCard } from "./ToolCard";
import type { ChatItem } from "./types";

export interface ItemsProps {
  items: ChatItem[];
  running: boolean;
  /** Los permisos que esperan esta tab, por id de la herramienta que los pidió. */
  approvals: Map<string, PendingApproval>;
  onDecide: (approval: PendingApproval, allow: boolean, remember: boolean) => void;
  focused: boolean;
}

/** La conversación, una cosa debajo de la otra. También dibuja lo de un subagente. */
export function ChatItems({ items, ...rest }: ItemsProps) {
  return (
    <>
      {items.map((item) => <Item key={item.id} item={item} {...rest} />)}
    </>
  );
}

type ItemProps = Omit<ItemsProps, "items"> & { item: ChatItem };

/**
 * Una cosa de la conversación. Memoizada: mientras el agente escribe, el reductor deja
 * intactas (la misma referencia) todas menos la que crece, así que solo esa se redibuja. Sin
 * esto, cada pedacito de texto volvía a armar el Markdown de la conversación entera y la
 * ventana se congelaba.
 */
const Item = memo(function Item({ item, ...props }: ItemProps) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "user":
      return (
        // Lo que escribió la persona va en una burbuja al margen derecho y en un gris
        // tranquilo, no en el azul del acento: el acento de la app marca lo accionable
        // (botones, selección), y un párrafo que grita azul al lado de la respuesta —que es
        // lo que de verdad se lee— le roba la atención a la conversación.
        // `data-chat-user`: lo que busca el salto entre mensajes de `ChatView`.
        <div data-chat-user className="self-end max-w-[78%] flex flex-col items-end gap-1">
          <div className="px-3.5 py-2.5 rounded-2xl rounded-br-md text-[13.5px] leading-[1.6]
            whitespace-pre-wrap break-words
            bg-gray-100 text-gray-900 border border-gray-200/70
            dark:bg-white/[0.07] dark:text-gray-100 dark:border-white/[0.06]">
            {item.text || <span className="italic text-gray-400 dark:text-white/35">{t("chat.imageOnly")}</span>}
          </div>
          {item.images > 0 && (
            <span className="text-[10.5px] text-gray-400 dark:text-white/35">
              {t("chat.tool.images", { count: item.images })}
            </span>
          )}
        </div>
      );
    case "text":
      return (
        <div className="min-w-0 [&_p]:text-[13.5px] [&_p]:leading-[1.75] [&_li]:text-[13.5px]">
          <Markdown content={item.text} />
          {item.streaming && <span className="inline-block w-1.5 h-3.5 ml-0.5 align-middle bg-gray-400 animate-pulse" />}
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} streaming={item.streaming} />;
    case "tool":
      return (
        <ToolCard
          tool={item}
          running={props.running}
          approval={props.approvals.get(item.toolUseId) ?? null}
          onDecide={props.onDecide}
          focused={props.focused}
          renderChildren={(children) => <ChatItems {...props} items={children} />}
        />
      );
    case "command":
      return (
        <div className="flex flex-col gap-1 self-end items-end">
          <span className="px-2 py-1 rounded-md font-mono text-[11.5px] bg-gray-100 dark:bg-white/8 text-gray-700 dark:text-gray-200">
            /{item.name}{item.args ? ` ${item.args}` : ""}
          </span>
          {item.output && <span className="text-[11px] text-gray-500 dark:text-white/45">{item.output}</span>}
        </div>
      );
    case "compacted":
      return <Compacted summary={item.summary} />;
    case "result":
      return <ResultLine item={item} />;
    case "side":
      return <SideQuestion item={item} {...props} />;
    case "notice":
      return (
        <div className={`px-3 py-2 rounded-lg text-[12px] whitespace-pre-wrap break-words
          ${item.tone === "error"
            ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
            : "bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-white/55"}`}>
          {item.text}
        </div>
      );
  }
});

/**
 * Una pregunta al margen (`/btw`): se contesta sobre una COPIA de la conversación, así que
 * la ve entera y no le agrega nada ni toca archivos.
 *
 * Va con su propio marco y no como un mensaje más para que se entienda de un vistazo que
 * eso NO es parte de la conversación: el agente, cuando siga, no se acuerda de esto.
 */
function SideQuestion({ item, ...props }: Omit<ItemsProps, "items"> & { item: Extract<ChatItem, { kind: "side" }> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col rounded-xl border border-dashed overflow-hidden
      border-violet-300/70 dark:border-violet-400/25 bg-violet-50/40 dark:bg-violet-400/[0.04]">
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="flex items-start gap-2 w-full px-3 py-2 text-left
          hover:bg-violet-100/50 dark:hover:bg-violet-400/[0.07]">
        <span className="shrink-0 mt-px text-[10px] font-bold uppercase tracking-wider
          text-violet-600 dark:text-violet-300/90">
          {t("chat.btw")}
        </span>
        <span className="flex-1 min-w-0 text-[12.5px] text-gray-700 dark:text-gray-200 break-words">
          {item.question}
        </span>
        {item.running && <AnimateSpin className="w-3 h-3 shrink-0 mt-0.5 text-violet-500" />}
        {open ? <ChevronDownIcon className="w-3 h-3 shrink-0 mt-1 text-gray-400" />
              : <ChevronRightIcon className="w-3 h-3 shrink-0 mt-1 text-gray-400" />}
      </Button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pb-2.5">
          <ChatItems {...props} items={item.inner.items} />
          <span className="text-[10.5px] text-violet-700/70 dark:text-violet-300/50">
            {t("chat.btw.hint")}
          </span>
        </div>
      )}
    </div>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="self-start flex items-center gap-1 text-[11.5px] italic text-gray-500 dark:text-white/45 hover:underline">
        {open ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
        {streaming ? t("chat.thinkingNow") : t("chat.thinking")}
      </Button>
      {open && (
        <p className="pl-4 border-l-2 border-gray-200 dark:border-white/10 text-[12px] italic whitespace-pre-wrap
          text-gray-500 dark:text-white/45">
          {text}
        </p>
      )}
    </div>
  );
}

function Compacted({ summary }: { summary: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
        <Button variant="custom" disabled={!summary} onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-white/40 hover:underline disabled:no-underline">
          {summary && (open ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />)}
          {t("chat.compacted")}
        </Button>
        <span className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
      </div>
      {open && summary && (
        <div className="px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/[0.03]"><Markdown content={summary} /></div>
      )}
    </div>
  );
}

function ResultLine({ item }: { item: Extract<ChatItem, { kind: "result" }> }) {
  const { t } = useTranslation();
  const parts = [
    item.durationMs !== null ? `${(item.durationMs / 1000).toFixed(1)} s` : null,
    item.costUsd !== null ? `$${item.costUsd.toFixed(4)}` : null,
    item.tokensIn !== null ? t("chat.tokens", { input: compact(item.tokensIn), output: compact(item.tokensOut ?? 0) }) : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1">
      {!item.ok && (
        <div className="px-3 py-2 rounded-lg text-[12px] bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {item.error ?? t("chat.failed")}
        </div>
      )}
      {parts.length > 0 && (
        <span className="self-start text-[10.5px] text-gray-400 dark:text-white/30">{parts.join(" · ")}</span>
      )}
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
