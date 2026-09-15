/**
 * El registro de debug de una tab de navegador: consola, red y cookies, juntando lo que
 * cuenta la página (su runtime) con lo que vio el proxy.
 *
 * Vive en la app y no en la página porque tiene que sobrevivir a las recargas: el error
 * que importa suele ser el de la carga anterior, justo antes de que un redirect se lo
 * lleve. Lógica pura, probada en `tests/debugLog.test.ts`; el store y el panel la usan, y
 * el MCP la formatea para un agente con las mismas funciones.
 */
import type { CookieReport, ProxyNetworkPage, ProxyRequest } from "./ipc";
import type { ConsoleEntry, ConsoleLevel, DebugBatch, PageNetworkEntry } from "./protocol";

export interface LoggedConsole extends ConsoleEntry {
  id: number;
  doc: string;
}

export interface LoggedRequest extends PageNetworkEntry {
  id: number;
  doc: string;
}

/** Una carga de documento: lo que separa una página de la siguiente en el log. */
export interface DocMark {
  id: number;
  doc: string;
  url: string;
  at: number;
}

export interface DebugLog {
  console: LoggedConsole[];
  docs: DocMark[];
  /** Lo que la página pidió a OTROS orígenes. */
  requests: LoggedRequest[];
  /** Lo que pasó por el proxy (el propio servidor). */
  proxy: ProxyRequest[];
  proxyNext: number;
  /** Consola y documentos comparten numeración: así un cursor sirve para las dos. */
  nextId: number;
}

export const MAX_CONSOLE = 2000;
export const MAX_REQUESTS = 1500;

export const EMPTY_LOG: DebugLog = { console: [], docs: [], requests: [], proxy: [], proxyNext: 0, nextId: 1 };

const tail = <T,>(items: T[], max: number) => (items.length > max ? items.slice(items.length - max) : items);

export function startDocument(log: DebugLog, doc: string, url: string, at: number): DebugLog {
  if (log.docs[log.docs.length - 1]?.doc === doc) return log;
  return {
    ...log,
    docs: tail([...log.docs, { id: log.nextId, doc, url, at }], 200),
    nextId: log.nextId + 1,
  };
}

export function appendBatch(log: DebugLog, batch: DebugBatch): DebugLog {
  if (batch.console.length === 0 && batch.network.length === 0) return log;
  const first = batch.console[0]?.at ?? batch.network[0]?.at ?? Date.now();
  let next = startDocument(log, batch.doc, batch.url, first);
  let id = next.nextId;
  const console = batch.console.map((entry) => ({ ...entry, id: id++, doc: batch.doc }));
  const requests = batch.network.map((entry) => ({ ...entry, id: id++, doc: batch.doc }));
  next = {
    ...next,
    console: tail([...next.console, ...console], MAX_CONSOLE),
    requests: tail([...next.requests, ...requests], MAX_REQUESTS),
    nextId: id,
  };
  return next;
}

export function appendProxy(log: DebugLog, page: ProxyNetworkPage): DebugLog {
  if (page.entries.length === 0 && page.next === log.proxyNext) return log;
  const known = log.proxy[log.proxy.length - 1]?.seq ?? 0;
  const fresh = page.entries.filter((e) => e.seq > known);
  return { ...log, proxy: tail([...log.proxy, ...fresh], MAX_REQUESTS), proxyNext: page.next };
}

export function clearConsole(log: DebugLog): DebugLog {
  return { ...log, console: [], docs: log.docs.slice(-1) };
}

export function clearNetwork(log: DebugLog): DebugLog {
  return { ...log, requests: [], proxy: [] };
}

/** Errores y avisos del documento actual: los de páginas anteriores ya no dicen cómo está
 *  la que se ve. */
export function currentCounts(log: DebugLog): { errors: number; warnings: number } {
  const doc = log.docs[log.docs.length - 1]?.doc;
  let errors = 0;
  let warnings = 0;
  for (const entry of log.console) {
    if (doc && entry.doc !== doc) continue;
    if (entry.level === "error") errors += 1;
    else if (entry.level === "warn") warnings += 1;
  }
  return { errors, warnings };
}

// ── Red ─────────────────────────────────────────────────────────

export type RequestType = "document" | "script" | "style" | "image" | "font" | "fetch" | "websocket" | "media" | "other";

export interface RequestRow {
  key: string;
  at: number;
  method: string;
  url: string;
  status: number | null;
  type: RequestType;
  durationMs: number | null;
  size: number | null;
  error: string | null;
  contentType: string | null;
  /** Quién lo vio: el proxy (mismo servidor) o la página (otro origen). */
  via: "proxy" | "page";
}

const EXTENSIONS: [RegExp, RequestType][] = [
  [/\.(m?js|cjs|jsx|tsx?|vue|svelte)$/i, "script"],
  [/\.(css|scss|sass|less)$/i, "style"],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i, "image"],
  [/\.(woff2?|ttf|otf|eot)$/i, "font"],
  [/\.(mp4|webm|ogg|mp3|wav|m4a)$/i, "media"],
  [/\.html?$/i, "document"],
];

export function typeOf(contentType: string | null | undefined, url: string, websocket = false): RequestType {
  if (websocket) return "websocket";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* ya es una ruta */
  }
  // La extensión manda sobre el content-type: un `/logo.png` que da 404 llega como
  // `text/html` o `text/plain`, y listarlo como documento o fetch escondería qué faltó.
  const byExtension = EXTENSIONS.find(([re]) => re.test(path))?.[1];
  if (byExtension) return byExtension;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("text/html")) return "document";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "script";
  if (ct.startsWith("text/css")) return "style";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("font/") || ct.includes("font-woff")) return "font";
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return "media";
  if (ct.includes("json") || ct.includes("xml") || ct.startsWith("text/plain") || ct.includes("event-stream")) return "fetch";
  return "other";
}

const INITIATOR: Record<string, RequestType> = {
  fetch: "fetch", xhr: "fetch", xmlhttprequest: "fetch", beacon: "fetch", script: "script",
  link: "style", css: "style", img: "image", image: "image", video: "media", audio: "media",
};

export function requestRows(log: DebugLog): RequestRow[] {
  const rows: RequestRow[] = [
    ...log.proxy.map((e): RequestRow => ({
      key: `p${e.seq}`, at: e.at, method: e.method, url: e.url, status: e.status,
      type: typeOf(e.contentType, e.url, e.websocket), durationMs: e.durationMs, size: e.size,
      error: e.error, contentType: e.contentType, via: "proxy",
    })),
    ...log.requests.map((e): RequestRow => ({
      key: `g${e.id}`, at: e.at, method: e.method, url: e.url, status: e.status,
      type: INITIATOR[e.type] ?? typeOf(null, e.url), durationMs: e.durationMs, size: e.size,
      error: e.error ?? null, contentType: null, via: "page",
    })),
  ];
  return rows.sort((a, b) => a.at - b.at);
}

export function isFailed(row: RequestRow): boolean {
  return row.error !== null || (row.status !== null && row.status >= 400);
}

export function filterRequests(
  rows: RequestRow[],
  { text, type, failedOnly }: { text: string; type: RequestType | "all"; failedOnly: boolean }
): RequestRow[] {
  const needle = text.trim().toLowerCase();
  return rows.filter((r) => (type === "all" || r.type === type)
    && (!failedOnly || isFailed(r))
    && (!needle || r.url.toLowerCase().includes(needle) || String(r.status ?? "").startsWith(needle)));
}

// ── Cookies ─────────────────────────────────────────────────────

export interface CookieRow {
  name: string;
  value: string;
  path: string | null;
  /** `null` = no se sabe (nadie vio el `Set-Cookie`). */
  httpOnly: boolean | null;
  secure: boolean | null;
  sameSite: string | null;
  expiresAt: number | null;
  /** El navegador se la mandó al servidor en el último pedido. */
  sent: boolean;
  /** `document.cookie` la ve. */
  visibleToPage: boolean;
}

/**
 * Junta las tres miradas sobre las cookies: lo que la página ve, lo que el servidor puso
 * y lo que el navegador le devuelve. Las diferencias entre las tres son justamente los
 * bugs: una cookie que el servidor puso y el navegador no manda (Path, Secure, SameSite).
 */
export function mergeCookies(pageCookies: { name: string; value: string }[], report: CookieReport | null): CookieRow[] {
  const sentNames = new Set(report?.sent?.cookies.map((c) => c.name) ?? []);
  const pageByName = new Map(pageCookies.map((c) => [c.name, c.value]));
  const rows: CookieRow[] = [];
  const seen = new Set<string>();

  for (const c of report?.set ?? []) {
    seen.add(c.name);
    rows.push({
      name: c.name, value: pageByName.get(c.name) ?? c.value, path: c.path, httpOnly: c.httpOnly, secure: c.secure,
      sameSite: c.sameSite, expiresAt: c.expiresAt, sent: sentNames.has(c.name), visibleToPage: pageByName.has(c.name),
    });
  }
  for (const c of pageCookies) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    rows.push({
      name: c.name, value: c.value, path: null, httpOnly: false, secure: null, sameSite: null, expiresAt: null,
      sent: sentNames.has(c.name), visibleToPage: true,
    });
  }
  for (const c of report?.sent?.cookies ?? []) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    // Llega al servidor pero la página no la ve: es HttpOnly, aunque su Set-Cookie sea de
    // antes de que la app empezara a mirar.
    rows.push({
      name: c.name, value: c.value, path: null, httpOnly: true, secure: null, sameSite: null, expiresAt: null,
      sent: true, visibleToPage: false,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Formato ─────────────────────────────────────────────────────

export function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const LEVELS_FOR: Record<"all" | "errors" | "warnings", ConsoleLevel[] | null> = {
  all: null,
  errors: ["error"],
  warnings: ["error", "warn"],
};

/**
 * La consola para un agente: una línea por mensaje, las cargas de página como
 * separadores, y un cursor para pedir solo lo nuevo la próxima vez.
 */
export function consoleForAgent(
  log: DebugLog,
  { since = 0, level = "all", limit = 100 }: { since?: number; level?: "all" | "errors" | "warnings"; limit?: number }
): { text: string; next: number } {
  const levels = LEVELS_FOR[level];
  const entries = log.console.filter((e) => e.id > since && (!levels || levels.includes(e.level)));
  const shown = entries.slice(-limit);
  // De las cargas anteriores al primer mensaje mostrado solo va la última: dice en qué
  // página se logueó, sin arrastrar las recargas cuyos mensajes quedaron afuera.
  const firstShown = shown[0]?.id;
  const allMarks = log.docs.filter((d) => d.id > since);
  const marks = firstShown === undefined ? allMarks : [
    ...allMarks.filter((d) => d.id < firstShown).slice(-1),
    ...allMarks.filter((d) => d.id > firstShown),
  ];

  const items: { id: number; line: string }[] = [
    ...marks.map((d) => ({ id: d.id, line: `── ${formatClock(d.at)} página cargada: ${d.url} ──` })),
    ...shown.map((e) => {
      const prefix = e.kind === "exception" ? "Uncaught " : "";
      let line = `${formatClock(e.at)} ${e.level.toUpperCase().padEnd(5)} ${prefix}${e.text}`;
      if (e.source) line += `  (${e.source})`;
      if (e.stack && e.kind !== "console") {
        // Los marcos del propio runtime (el envoltorio de la consola) no son código del proyecto.
        const frames = e.stack.split("\n").map((l) => l.trim())
          .filter((l) => l && !e.text.includes(l) && !l.includes("/__controlcode__/")).slice(0, 4);
        line += frames.map((f) => `\n      ${f}`).join("");
      }
      return { id: e.id, line };
    }),
  ].sort((a, b) => a.id - b.id);

  const omitted = entries.length - shown.length;
  const lines = items.map((i) => i.line);
  if (omitted > 0) lines.unshift(`… ${omitted} mensajes anteriores omitidos (pasá limit para ver más)`);
  const next = log.nextId - 1;
  return { text: lines.length ? lines.join("\n") : "(sin mensajes de consola)", next };
}

export function networkForAgent(
  rows: RequestRow[],
  { since = 0, failedOnly = false, limit = 80 }: { since?: number; failedOnly?: boolean; limit?: number }
): { text: string; next: number } {
  const fresh = rows.filter((r) => r.at > since && (!failedOnly || isFailed(r)));
  const shown = fresh.slice(-limit);
  const lines = shown.map((r) => {
    const status = r.error ? `ERR` : String(r.status ?? "—");
    const extra = [r.durationMs !== null ? `${r.durationMs}ms` : null, r.size !== null ? formatBytes(r.size) : null]
      .filter(Boolean).join(" ");
    return `${formatClock(r.at)} ${r.method.padEnd(6)} ${status.padEnd(3)} ${r.type.padEnd(9)} ${r.url}${extra ? `  ${extra}` : ""}${r.error ? `  — ${r.error}` : ""}`;
  });
  if (fresh.length > shown.length) lines.unshift(`… ${fresh.length - shown.length} pedidos anteriores omitidos`);
  const next = rows.length ? Math.max(since, ...rows.map((r) => r.at)) : since;
  return { text: lines.length ? lines.join("\n") : failedOnly ? "(ningún pedido falló)" : "(sin pedidos)", next };
}
