import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckIcon, ChevronDownIcon, ChevronRightIcon, ErrorIcon } from "neogestify-ui-components";

import { Markdown } from "@/shared/ui/Markdown";
import { PermissionCard } from "@/features/runs/PermissionCard";
import type { PendingApproval } from "@/features/runs/types";

import type { ChatItem, ToolResult } from "./types";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** Las líneas que se dibujan de un bloque largo antes de ofrecer "ver todo". */
const PREVIEW_LINES = 40;

const str = (input: Record<string, unknown> | null, key: string) =>
  input && typeof input[key] === "string" ? (input[key] as string) : undefined;

/** Las que se abren solas: lo que cambia archivos se mira, lo demás se despliega si hace
 *  falta. */
const OPEN_BY_DEFAULT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "TodoWrite"]);

/**
 * Una herramienta que usó el agente: el encabezado (`Bash(cargo test)`) con su estado y,
 * desplegado, lo que pidió y lo que le devolvió. Si está esperando un permiso, la tarjeta
 * para decidirlo va adentro, junto a lo que pide.
 */
export function ToolCard({ tool, running, approval, onDecide, focused, renderChildren }: {
  tool: Tool;
  /** El turno sigue: una herramienta sin resultado está corriendo, no colgada. */
  running: boolean;
  approval: PendingApproval | null;
  onDecide: (approval: PendingApproval, allow: boolean, remember: boolean) => void;
  focused: boolean;
  renderChildren: (items: ChatItem[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(() => OPEN_BY_DEFAULT.has(tool.name) || tool.result?.isError === true);
  const expanded = open || approval !== null;
  const state = tool.result ? (tool.result.isError ? "error" : "ok") : running ? "running" : "cut";

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden
      ${approval
        ? "border-amber-300/70 dark:border-amber-500/30"
        : state === "error"
          ? "border-red-300/60 dark:border-red-500/25"
          : "border-gray-200 dark:border-white/8"}
      bg-gray-50/60 dark:bg-white/[0.02]`}>
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-2.5 h-8 text-left hover:bg-gray-100 dark:hover:bg-white/[0.04]">
        <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
          {state === "running" && <AnimateSpin className="w-3 h-3 text-blue-500" />}
          {state === "ok" && <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />}
          {state === "error" && <ErrorIcon className="w-3.5 h-3.5 text-red-500" />}
          {state === "cut" && <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-white/30" />}
        </span>
        <span className="truncate font-mono text-[11.5px] text-gray-800 dark:text-gray-200" title={tool.label}>
          {tool.label}
        </span>
        {tool.children.length > 0 && (
          <span className="shrink-0 text-[10.5px] text-gray-400 dark:text-white/35">
            {t("chat.tool.steps", { count: tool.children.length })}
          </span>
        )}
        <span className="flex-1" />
        {approval && (
          <span className="shrink-0 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
            {t("chat.tool.waiting")}
          </span>
        )}
        {expanded
          ? <ChevronDownIcon className="w-3 h-3 shrink-0 text-gray-400" />
          : <ChevronRightIcon className="w-3 h-3 shrink-0 text-gray-400" />}
      </Button>

      {expanded && (
        <div className="flex flex-col gap-2 px-2.5 pb-2.5 pt-1 min-w-0">
          <ToolBody tool={tool} renderChildren={renderChildren} />
          {approval && (
            <div className="-mx-3 -mb-2.5">
              <PermissionCard approval={approval} focused={focused} hidePreview
                onDecide={(allow, remember) => onDecide(approval, allow, remember)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolBody({ tool, renderChildren }: { tool: Tool; renderChildren: (items: ChatItem[]) => ReactNode }) {
  const { t } = useTranslation();
  const input = tool.input;
  const result = tool.result;

  switch (tool.name) {
    case "Bash":
    case "BashOutput":
      return (
        <>
          {str(input, "description") && (
            <span className="text-[11px] text-gray-500 dark:text-white/45">{str(input, "description")}</span>
          )}
          <Block text={`$ ${str(input, "command") ?? ""}`} tone="command" />
          <Result result={result} />
        </>
      );
    case "Edit":
    case "NotebookEdit":
      return (
        <>
          <FilePath path={str(input, "file_path") ?? str(input, "notebook_path")} />
          <Diff before={str(input, "old_string") ?? ""} after={str(input, "new_string") ?? ""} />
          <ErrorOnly result={result} />
        </>
      );
    case "MultiEdit": {
      const edits = Array.isArray(input?.edits) ? (input!.edits as Record<string, unknown>[]) : [];
      return (
        <>
          <FilePath path={str(input, "file_path")} />
          {edits.map((e, i) => (
            <Diff key={i} before={str(e, "old_string") ?? ""} after={str(e, "new_string") ?? ""} />
          ))}
          <ErrorOnly result={result} />
        </>
      );
    }
    case "Write":
      return (
        <>
          <FilePath path={str(input, "file_path")} />
          <Diff before="" after={str(input, "content") ?? ""} />
          <ErrorOnly result={result} />
        </>
      );
    case "TodoWrite": {
      const todos = Array.isArray(input?.todos) ? (input!.todos as Record<string, unknown>[]) : [];
      return (
        <ul className="flex flex-col gap-1">
          {todos.map((todo, i) => {
            const status = str(todo, "status");
            return (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <span className={`mt-[3px] w-3 h-3 shrink-0 rounded-sm border flex items-center justify-center
                  ${status === "completed"
                    ? "bg-emerald-500 border-emerald-500"
                    : status === "in_progress"
                      ? "border-blue-500"
                      : "border-gray-300 dark:border-white/25"}`}>
                  {status === "completed" && <CheckIcon className="w-2.5 h-2.5 text-white" />}
                  {status === "in_progress" && <span className="w-1.5 h-1.5 rounded-sm bg-blue-500" />}
                </span>
                <span className={status === "completed"
                  ? "line-through text-gray-400 dark:text-white/35"
                  : "text-gray-700 dark:text-gray-200"}>
                  {status === "in_progress" ? str(todo, "activeForm") ?? str(todo, "content") : str(todo, "content")}
                </span>
              </li>
            );
          })}
        </ul>
      );
    }
    case "Task":
    case "Agent":
      return (
        <>
          {str(input, "prompt") && <Folded label={t("chat.tool.prompt")} text={str(input, "prompt")!} />}
          {tool.children.length > 0 && (
            <div className="flex flex-col gap-2 pl-2.5 border-l-2 border-gray-200 dark:border-white/8">
              {renderChildren(tool.children)}
            </div>
          )}
          {result && (result.isError
            ? <Result result={result} />
            : <div className="min-w-0"><Markdown content={result.content} /></div>)}
        </>
      );
    case "Read":
      return (
        <>
          <FilePath path={str(input, "file_path")} />
          <Result result={result} folded />
        </>
      );
    default: {
      // Grep, Glob, WebFetch, WebSearch, las MCP: lo que pidió tal cual y lo que volvió.
      const shown = input && Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : null;
      return (
        <>
          {shown && <Block text={shown} tone="input" />}
          <Result result={result} />
        </>
      );
    }
  }
}

function FilePath({ path }: { path?: string }) {
  if (!path) return null;
  return <span className="truncate font-mono text-[11px] text-gray-500 dark:text-white/45" title={path}>{path}</span>;
}

/** Un bloque monoespaciado que se recorta a las primeras líneas, con "ver todo". */
function Block({ text, tone }: { text: string; tone: "command" | "input" | "output" | "error" }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const cut = !all && lines.length > PREVIEW_LINES;
  return (
    <div className="flex flex-col min-w-0">
      <pre className={`max-h-[28rem] overflow-auto px-2.5 py-1.5 rounded-md font-mono text-[11px] leading-[1.5]
        whitespace-pre-wrap break-words [tab-size:2]
        ${tone === "command"
          ? "bg-gray-900 text-gray-100 dark:bg-black/40"
          : tone === "error"
            ? "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200"
            : "bg-white text-gray-700 dark:bg-black/25 dark:text-gray-300 border border-gray-200/70 dark:border-white/5"}`}>
        {cut ? lines.slice(0, PREVIEW_LINES).join("\n") : text}
      </pre>
      {cut && (
        <Button variant="link" size="sm" onClick={() => setAll(true)} className="self-start text-[11px]">
          {t("chat.tool.showAll", { count: lines.length })}
        </Button>
      )}
    </div>
  );
}

function Folded({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="self-start flex items-center gap-1 text-[11px] text-gray-500 dark:text-white/45 hover:underline">
        {open ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
        {label}
      </Button>
      {open && <Block text={text} tone="input" />}
    </div>
  );
}

function Result({ result, folded = false }: { result: ToolResult | null; folded?: boolean }) {
  const { t } = useTranslation();
  if (!result) return null;
  const text = result.content.trim();
  const extra = [
    result.images > 0 ? t("chat.tool.images", { count: result.images }) : null,
    result.truncated ? t("chat.tool.truncated") : null,
  ].filter(Boolean).join(" · ");
  return (
    <>
      {text && (folded && !result.isError
        ? <Folded label={t("chat.tool.lines", { count: text.split("\n").length })} text={text} />
        : <Block text={text} tone={result.isError ? "error" : "output"} />)}
      {extra && <span className="text-[10.5px] text-gray-400 dark:text-white/35">{extra}</span>}
    </>
  );
}

/** En una edición el resultado es "listo" y no aporta nada; solo se muestra si falló. */
function ErrorOnly({ result }: { result: ToolResult | null }) {
  return result?.isError ? <Result result={result} /> : null;
}

/** Lo que sale y lo que entra, línea por línea. */
function Diff({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const split = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);
  const lines = [
    ...split(before).map((text) => ({ sign: "-" as const, text })),
    ...split(after).map((text) => ({ sign: "+" as const, text })),
  ];
  const cut = !all && lines.length > PREVIEW_LINES;
  return (
    <div className="flex flex-col min-w-0">
      <div className="max-h-[28rem] overflow-auto rounded-md border border-gray-200/70 dark:border-white/5
        bg-white dark:bg-black/25 py-1">
        {(cut ? lines.slice(0, PREVIEW_LINES) : lines).map((line, i) => (
          <div key={i} className={`px-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words [tab-size:2]
            ${line.sign === "-"
              ? "bg-red-500/10 text-red-700 dark:text-red-300"
              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>
            <span className="select-none opacity-50">{line.sign} </span>
            {line.text || " "}
          </div>
        ))}
      </div>
      {cut && (
        <Button variant="link" size="sm" onClick={() => setAll(true)} className="self-start text-[11px]">
          {t("chat.tool.showAll", { count: lines.length })}
        </Button>
      )}
    </div>
  );
}
