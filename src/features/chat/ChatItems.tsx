import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, ChevronDownIcon, ChevronRightIcon } from "neogestify-ui-components";

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
export function ChatItems(props: ItemsProps) {
  const { items } = props;
  return (
    <>
      {items.map((item) => <Item key={item.id} item={item} {...props} />)}
    </>
  );
}

function Item({ item, ...props }: ItemsProps & { item: ChatItem }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end max-w-[85%] flex flex-col items-end gap-1">
          <div className="px-3 py-2 rounded-2xl rounded-br-md text-[13px] leading-relaxed whitespace-pre-wrap break-words
            bg-blue-600 text-white">
            {item.text || <span className="italic opacity-70">{t("chat.imageOnly")}</span>}
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
        <div className="min-w-0 [&_p]:text-[13px]">
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
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="self-start flex items-center gap-1 text-[11.5px] italic text-gray-500 dark:text-white/40 hover:underline">
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
