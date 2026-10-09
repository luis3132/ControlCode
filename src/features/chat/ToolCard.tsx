import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, CheckIcon, ChevronDownIcon, ChevronRightIcon, ErrorIcon, useTheme } from "neogestify-ui-components";

import { readFile } from "@/features/editor/ipc";
import { highlightFile, type Span } from "@/features/editor/highlight";
import { diffLines, patchLines, withContext, type PatchHunk } from "@/shared/lineDiff";
import { Markdown } from "@/shared/ui/Markdown";
import { PermissionCard } from "@/features/runs/PermissionCard";

import { QuestionCard, questionsOf } from "./QuestionCard";
import type { PendingApproval } from "@/features/runs/types";

import type { ChatItem, ToolResult } from "./types";

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** Las líneas que se dibujan de un bloque largo antes de ofrecer "ver todo". */
const PREVIEW_LINES = 40;
/** Líneas iguales que se muestran alrededor de cada cambio, como `git diff`. */
const DIFF_CONTEXT = 3;
/** Por encima de esto no se colorea: un `Write` de miles de líneas tardaría en el hilo de
 *  la página, y se lee igual sin colores. */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** La carpeta de la tab, para mostrar las rutas como las muestra la TUI: relativas. */
export const ChatCwd = createContext<string | null>(null);

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
    <div className={`flex flex-col rounded-xl border overflow-hidden
      ${approval
        ? "border-amber-300/70 dark:border-amber-500/30"
        : state === "error"
          ? "border-red-300/60 dark:border-red-500/25"
          : "border-gray-200/80 dark:border-white/[0.07]"}
      bg-gray-50/70 dark:bg-white/[0.025]`}>
      <Button variant="custom" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 h-9 text-left hover:bg-gray-100 dark:hover:bg-white/[0.045]">
        <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">
          {state === "running" && <AnimateSpin className="w-3 h-3 text-blue-500" />}
          {state === "ok" && <CheckIcon className="w-3.5 h-3.5 text-emerald-500" />}
          {state === "error" && <ErrorIcon className="w-3.5 h-3.5 text-red-500" />}
          {state === "cut" && <span className="w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-white/30" />}
        </span>
        <ToolTitle tool={tool} />
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
              {approval.toolName === "AskUserQuestion"
                ? <div className="mx-3 mb-2.5"><QuestionCard approval={approval} /></div>
                : <PermissionCard approval={approval} focused={focused} hidePreview
                  onDecide={(allow, remember) => onDecide(approval, allow, remember)} />}
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
          <Diff before={str(input, "old_string") ?? ""} after={str(input, "new_string") ?? ""} patch={result?.patch}
            path={str(input, "file_path") ?? str(input, "notebook_path")} />
          <ErrorOnly result={result} />
        </>
      );
    case "MultiEdit": {
      const edits = Array.isArray(input?.edits) ? (input!.edits as Record<string, unknown>[]) : [];
      return (
        <>
          {/* Ya aplicadas, el diff de la CLI las muestra juntas, en el archivo; antes, una
              por una. */}
          {result?.patch?.length
            ? <Diff before="" after="" patch={result.patch} path={str(input, "file_path")} />
            : edits.map((e, i) => (
              <Diff key={i} before={str(e, "old_string") ?? ""} after={str(e, "new_string") ?? ""}
                path={str(input, "file_path")} />
            ))}
          <ErrorOnly result={result} />
        </>
      );
    }
    case "Write":
      return (
        <>
          <WriteDiff path={str(input, "file_path")} content={str(input, "content") ?? ""} result={result} />
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
    case "AskUserQuestion": {
      // Mientras espera, las preguntas las muestra la tarjeta para contestarlas; acá queda
      // el registro de qué se preguntó y qué se respondió.
      if (!result) return null;
      return (
        <>
          <ul className="flex flex-col gap-0.5 text-[12px] text-gray-600 dark:text-white/55">
            {questionsOf(input ?? {}).map((q) => <li key={q.question}>{q.question}</li>)}
          </ul>
          <Result result={result} />
        </>
      );
    }
    case "Read":
      return (
        <>
          <FilePath path={str(input, "file_path")} />
          <Result result={result} folded />
        </>
      );
    default:
      // Grep, Glob, WebFetch, las de un MCP: los parámetros como campos, no como JSON.
      return (
        <>
          <Params input={input} />
          <SmartResult result={result} />
        </>
      );
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

/**
 * Un `Write`: trae el archivo entero, no qué cambia. Si el archivo ya existía, pintarlo todo
 * de verde dice "todo esto es nuevo", y no lo es (issue #23).
 *
 * - Ya corrió: el diff de la CLI (`patch`) contra lo que había. Sin `patch`, el archivo era
 *   nuevo y sí es todo agregado.
 * - Todavía no corrió (esperando tu permiso, o en curso): se compara contra el archivo como
 *   está en disco ahora. Después de correr ya no sirve leerlo: tendría el contenido nuevo.
 */
function WriteDiff({ path, content, result }: { path?: string; content: string; result: ToolResult | null }) {
  const [onDisk, setOnDisk] = useState<string | null>(null);
  const pending = result === null;
  useEffect(() => {
    if (!pending || !path) return;
    let stale = false;
    readFile(path)
      .then((f) => { if (!stale && f.kind === "text") setOnDisk(f.content); })
      // No existe (o no se puede leer): es un archivo nuevo, todo agregado.
      .catch(() => {});
    return () => { stale = true; };
  }, [pending, path]);
  // El archivo entero contra el archivo entero: los números son los del archivo.
  return <Diff before={pending ? onDisk ?? "" : ""} after={content} patch={result?.patch} path={path} numbered />;
}

/**
 * Una edición como diff: en rojo solo lo que sale, en verde solo lo que entra, y lo que
 * queda igual sin color (issue #23).
 *
 * Si la herramienta ya corrió, se usa el diff que hizo la CLI contra el archivo de verdad
 * (`patch`), con sus números de línea. Antes de eso —mientras espera tu permiso, o en
 * un historial viejo— se calcula entre lo que sale y lo que entra.
 */
function Diff({ before, after, patch, path, numbered = false }: {
  before: string;
  after: string;
  patch?: PatchHunk[] | null;
  /** Para elegir el resaltado de sintaxis por la extensión. */
  path?: string;
  /** Los números son del archivo (diff de la CLI, o un `Write` contra el archivo entero).
   *  Un `Edit` sin resultado compara solo el fragmento: ahí un "1" diría algo falso. */
  numbered?: boolean;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const [all, setAll] = useState(false);
  const rows = useMemo(
    () => (patch?.length ? patchLines(patch) : withContext(diffLines(before, after), DIFF_CONTEXT)),
    [patch, before, after]
  );
  const showNumbers = numbered || !!patch?.length;

  // El código de las filas, en orden, para colorearlo de una: así un string o un comentario
  // de varias líneas se colorea entero, como en el editor.
  const code = useMemo(() => rows.flatMap((r) => (r.sign === "gap" ? [] : [r.text])).join("\n"), [rows]);
  const [spans, setSpans] = useState<Span[][] | null>(null);
  useEffect(() => {
    setSpans(null);
    if (!path || code.length > MAX_HIGHLIGHT_CHARS) return;
    let alive = true;
    highlightFile(code, path, dark)
      .then((s) => { if (alive) setSpans(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [code, path, dark]);

  const cut = !all && rows.length > PREVIEW_LINES;
  let k = -1;
  return (
    <div className="flex flex-col min-w-0">
      <div className="max-h-[28rem] overflow-auto rounded-md border border-gray-200/70 dark:border-white/5
        bg-white dark:bg-[#0d1117] py-1">
        {(cut ? rows.slice(0, PREVIEW_LINES) : rows).map((row, i) => {
          if (row.sign === "gap") {
            return (
              <div key={i} className="px-2 font-mono text-[10.5px] leading-[1.6] select-none
                text-gray-400 dark:text-white/30 bg-gray-50 dark:bg-white/[0.02]">
                {row.count > 0 ? t("chat.tool.unchanged", { count: row.count }) : "⋯"}
              </div>
            );
          }
          k++;
          const colored = spans?.[k];
          return (
            <div key={i} className={`flex px-2 font-mono text-[11.5px] leading-[1.55] [tab-size:2]
              ${row.sign === "-"
                ? "bg-red-500/15 dark:bg-red-500/[0.18]"
                : row.sign === "+"
                  ? "bg-emerald-500/15 dark:bg-emerald-500/[0.16]"
                  : ""}`}>
              {showNumbers && (
                <span className="w-9 shrink-0 pr-2 text-right select-none text-gray-400 dark:text-white/30 tabular-nums">
                  {row.sign === "-" ? row.oldNo : row.newNo}
                </span>
              )}
              <span className={`w-3 shrink-0 select-none
                ${row.sign === "-" ? "text-red-600 dark:text-red-400" : row.sign === "+" ? "text-emerald-600 dark:text-emerald-400" : "opacity-0"}`}>
                {row.sign}
              </span>
              <span className={`min-w-0 whitespace-pre-wrap break-words
                ${colored ? "" : row.sign === "-" ? "text-red-800 dark:text-red-200" : row.sign === "+" ? "text-emerald-800 dark:text-emerald-200" : "text-gray-700 dark:text-white/70"}`}>
                {colored && colored.length > 0
                  ? colored.map((s, j) => <span key={j} className={s.className}>{s.text}</span>)
                  : row.text || " "}
              </span>
            </div>
          );
        })}
      </div>
      {cut && (
        <Button variant="link" size="sm" onClick={() => setAll(true)} className="self-start text-[11px]">
          {t("chat.tool.showAll", { count: rows.length })}
        </Button>
      )}
    </div>
  );
}

/** `mcp__controlcode__browser_click` → servidor y herramienta. `null` = no es de un MCP. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** El dato que identifica una llamada, para el encabezado: la URL, el comando, el texto… */
export function mainArg(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const preferred = ["url", "command", "query", "pattern", "path", "file_path", "selector", "target", "ref", "text", "name", "title"];
  for (const key of [...preferred, ...Object.keys(input)]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0]!;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** El encabezado: las nativas como siempre (`Bash(cargo test)`); las de un MCP con su
 *  servidor aparte y el nombre legible, en vez de `mcp__controlcode__browser_click`. */
function ToolTitle({ tool }: { tool: Tool }) {
  const file = fileChange(tool);
  if (file) return <FileTitle change={file} />;
  const mcp = mcpParts(tool.name);
  if (!mcp) {
    return (
      <span className="truncate font-mono text-[11.5px] text-gray-800 dark:text-gray-200" title={tool.label}>
        {tool.label}
      </span>
    );
  }
  const arg = mainArg(tool.input);
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={tool.name}>
      <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-medium
        bg-violet-500/10 text-violet-700 dark:bg-violet-400/12 dark:text-violet-300">
        {mcp.server}
      </span>
      <span className="shrink-0 text-[12px] font-medium text-gray-800 dark:text-gray-100">
        {mcp.tool.replace(/_/g, " ")}
      </span>
      {arg && (
        <span className="truncate font-mono text-[11px] text-gray-500 dark:text-white/45">{arg}</span>
      )}
    </span>
  );
}

/** Los parámetros de una llamada, campo por campo. Lo largo o lo que es un objeto va en un
 *  bloque aparte, para que la lista se pueda leer de un vistazo. */
function Params({ input }: { input: Record<string, unknown> | null }) {
  const entries = Object.entries(input ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 py-2 rounded-md text-[11.5px]
      bg-white dark:bg-black/25 border border-gray-200/70 dark:border-white/5">
      {entries.map(([key, value]) => {
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        const long = typeof value === "object" || text.length > 160 || text.includes("\n");
        return (
          <div key={key} className="contents">
            <dt className="font-medium text-gray-500 dark:text-white/45">{key}</dt>
            <dd className="min-w-0">
              {long
                ? <Block text={text} tone="input" />
                : <span className={`break-words ${typeof value === "string" ? "text-gray-800 dark:text-gray-200" : "font-mono text-blue-700 dark:text-blue-300"}`}>{text}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** El resultado: un JSON se muestra con formato; un texto largo, plegado. */
function SmartResult({ result }: { result: ToolResult | null }) {
  const { t } = useTranslation();
  const pretty = useMemo(() => {
    const text = result?.content.trim() ?? "";
    if (!/^[[{]/.test(text)) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }, [result?.content]);
  if (!result) return null;
  if (result.isError || !pretty) {
    const lines = result.content.trim().split("\n").length;
    return lines > 12 && !result.isError
      ? <Folded label={t("chat.tool.lines", { count: lines })} text={result.content.trim()} />
      : <Result result={result} />;
  }
  const lines = pretty.split("\n").length;
  return lines > 12
    ? <Folded label={t("chat.tool.lines", { count: lines })} text={pretty} />
    : <Block text={pretty} tone="output" />;
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export interface FileChange {
  /** `created` (un Write de un archivo nuevo), `modified` (ya aplicado), `pending` (todavía
   *  no corrió). */
  state: "created" | "modified" | "pending";
  path: string;
  /** `null` = todavía no se sabe (un Write que no corrió: depende de lo que haya en disco). */
  added: number | null;
  removed: number | null;
}

/** Qué le pasó al archivo, para el encabezado: como la TUI, "Created src/a.ts (+19 −0)". */
export function fileChange(tool: { name: string; input: Record<string, unknown> | null; result: ToolResult | null }): FileChange | null {
  if (!FILE_TOOLS.has(tool.name)) return null;
  const input = tool.input;
  const path = str(input, "file_path") ?? str(input, "notebook_path");
  if (!path) return null;
  const count = (lines: { sign: string }[]) => ({
    added: lines.filter((l) => l.sign === "+").length,
    removed: lines.filter((l) => l.sign === "-").length,
  });
  const result = tool.result;
  if (result?.patch?.length) return { state: "modified", path, ...count(patchLines(result.patch)) };
  if (tool.name === "Write") {
    // Ya corrió y no trajo diff: el archivo era nuevo, todo es agregado.
    if (result && !result.isError) return { state: "created", path, ...count(diffLines("", str(input, "content") ?? "")) };
    return { state: "pending", path, added: null, removed: null };
  }
  const edits = tool.name === "MultiEdit" && Array.isArray(input?.edits)
    ? (input!.edits as Record<string, unknown>[])
    : [input ?? {}];
  const lines = edits.flatMap((e) => diffLines(str(e, "old_string") ?? "", str(e, "new_string") ?? ""));
  return { state: result && !result.isError ? "modified" : "pending", path, ...count(lines) };
}

/** La ruta como la muestra la TUI: relativa a la carpeta de la tab si está adentro. */
export function relativePath(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, "");
  return path.startsWith(base + "/") || path.startsWith(base + "\\") ? path.slice(base.length + 1) : path;
}

function FileTitle({ change }: { change: FileChange }) {
  const { t } = useTranslation();
  const cwd = useContext(ChatCwd);
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={change.path}>
      <span className="shrink-0 text-[12px] font-medium text-gray-800 dark:text-gray-100">
        {t(`chat.file.${change.state}`)}
      </span>
      <span className="truncate font-mono text-[11.5px] text-gray-700 dark:text-gray-200">
        {relativePath(change.path, cwd)}
      </span>
      {change.added !== null && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{change.added}</span>
          {" "}
          <span className="text-red-600 dark:text-red-400">−{change.removed}</span>
        </span>
      )}
    </span>
  );
}
