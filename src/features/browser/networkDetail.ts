/**
 * El detalle de un pedido de red: lo que muestra el panel al elegir una fila y lo que le
 * llega a un agente que pide uno. Lo del proxy y lo de la página llegan con formas
 * distintas; acá quedan en una sola, para que la vista no tenga que saber de dónde vino.
 *
 * Lógica pura, probada en `tests/networkDetail.test.ts`.
 */
import { formatBytes, typeOf, type LoggedRequest, type RequestType } from "./debugLog";
import type { ProxyRequestDetail } from "./ipc";
import type { NetBody, NetErrorKind, NetHeader } from "./protocol";

export interface RequestDetail {
  key: string;
  via: "proxy" | "page";
  at: number;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  type: RequestType;
  contentType: string | null;
  ttfbMs: number | null;
  durationMs: number | null;
  size: number | null;
  pending: boolean;
  error: string | null;
  errorKind: NetErrorKind | null;
  httpVersion: string | null;
  remoteAddress: string | null;
  requestHeaders: NetHeader[];
  responseHeaders: NetHeader[];
  requestBody: NetBody | null;
  responseBody: NetBody | null;
  /** Lo vio la página, que de otro origen solo puede leer las cabeceras que permite CORS. */
  headersLimited: boolean;
  /** `cors`, `opaque`… de un `fetch` de la página. */
  responseType: string | null;
  redirected: boolean;
  finalUrl: string | null;
}

const header = (headers: NetHeader[], name: string): string | null =>
  headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;

export function detailFromProxy(d: ProxyRequestDetail): RequestDetail {
  return {
    key: `p${d.seq}`, via: "proxy", at: d.at, method: d.method, url: d.url,
    status: d.status, statusText: d.statusText, type: typeOf(d.contentType, d.url, d.websocket),
    contentType: d.contentType, ttfbMs: d.ttfbMs, durationMs: d.durationMs, size: d.size,
    pending: !d.finished && !d.error, error: d.error, errorKind: d.errorKind,
    httpVersion: d.httpVersion, remoteAddress: d.remoteAddress,
    requestHeaders: d.requestHeaders, responseHeaders: d.responseHeaders,
    requestBody: d.requestBody, responseBody: d.responseBody,
    headersLimited: false, responseType: null, redirected: false, finalUrl: null,
  };
}

export function detailFromPage(e: LoggedRequest): RequestDetail {
  const responseHeaders = e.responseHeaders ?? [];
  const contentType = e.responseBody?.contentType ?? header(responseHeaders, "content-type");
  return {
    key: `g${e.id}`, via: "page", at: e.at, method: e.method, url: e.url,
    status: e.status, statusText: e.statusText ?? null,
    type: e.type === "fetch" || e.type === "xhr" ? "fetch" : typeOf(contentType, e.url),
    contentType, ttfbMs: e.ttfbMs ?? null, durationMs: e.durationMs, size: e.size,
    pending: false, error: e.error ?? null, errorKind: e.errorKind ?? null,
    httpVersion: null, remoteAddress: null,
    requestHeaders: e.requestHeaders ?? [], responseHeaders,
    requestBody: e.requestBody ?? null, responseBody: e.responseBody ?? null,
    // Un recurso que solo vio el Resource Timing (un `<img>` de un CDN) no trae cabeceras.
    headersLimited: true, responseType: e.responseType ?? null,
    redirected: e.redirected ?? false, finalUrl: e.finalUrl ?? null,
  };
}

// ── Lo que se muestra ────────────────────────────────────────────

/** Los parámetros de la URL, en el orden en que vienen (repetidos incluidos). */
export function queryParams(url: string): [string, string][] {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

/** Un cuerpo `application/x-www-form-urlencoded` como pares; `null` si no lo es. */
export function formFields(body: NetBody | null): [string, string][] | null {
  const ct = (body?.contentType ?? "").toLowerCase();
  if (!body?.text || !ct.includes("x-www-form-urlencoded")) return null;
  return [...new URLSearchParams(body.text).entries()];
}

export type BodyView =
  | { kind: "none" }
  | { kind: "json"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; dataUrl: string }
  | { kind: "binary" }
  | { kind: "compressed"; encoding: string }
  | { kind: "evicted" }
  | { kind: "summary"; text: string };

/** Cómo mostrar un cuerpo: JSON indentado, texto, una imagen, o por qué no se puede. */
export function bodyView(body: NetBody | null): BodyView {
  if (!body) return { kind: "none" };
  if (body.evicted) return { kind: "evicted" };
  if (body.encoding) return { kind: "compressed", encoding: body.encoding };
  const ct = (body.contentType ?? "").toLowerCase();
  if (typeof body.text === "string") {
    const trimmed = body.text.trim();
    if (ct.includes("json") || (!body.truncated && /^[[{]/.test(trimmed))) {
      try {
        return { kind: "json", text: JSON.stringify(JSON.parse(trimmed), null, 2) };
      } catch {
        /* cortado o mal formado: se muestra tal cual */
      }
    }
    if (body.summary && !body.text) return { kind: "summary", text: body.summary };
    return { kind: "text", text: body.text };
  }
  if (body.base64) {
    return ct.startsWith("image/") && !body.truncated
      ? { kind: "image", dataUrl: `data:${ct.split(";")[0]};base64,${body.base64}` }
      : { kind: "binary" };
  }
  if (body.summary) return { kind: "summary", text: body.summary };
  return { kind: "none" };
}

export interface ParsedCookie {
  name: string;
  value: string;
  /** Los atributos tal como vienen: `Path=/`, `HttpOnly`, `SameSite=Lax`… */
  attributes: string[];
}

/** Las cookies que mandó el navegador (`Cookie: a=1; b=2`). */
export function requestCookies(headers: NetHeader[]): ParsedCookie[] {
  const raw = headers.filter((h) => h.name.toLowerCase() === "cookie").map((h) => h.value).join("; ");
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes: [] };
    });
}

/** Las que puso el servidor, una por `Set-Cookie`. */
export function responseCookies(headers: NetHeader[]): ParsedCookie[] {
  return headers
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .flatMap((h) => {
      const [first, ...attributes] = h.value.split(";").map((part) => part.trim());
      const eq = first?.indexOf("=") ?? -1;
      if (!first || eq <= 0) return [];
      return [{ name: first.slice(0, eq), value: first.slice(eq + 1), attributes: attributes.filter(Boolean) }];
    });
}

export type StatusClass = "info" | "success" | "redirect" | "client" | "server";

export function statusClass(status: number | null): StatusClass | null {
  if (status === null || status < 100) return null;
  if (status < 200) return "info";
  if (status < 300) return "success";
  if (status < 400) return "redirect";
  if (status < 500) return "client";
  return "server";
}

/** Los códigos que tienen explicación propia en el panel; los demás usan la de su familia. */
export const EXPLAINED_STATUS = [
  400, 401, 403, 404, 405, 406, 408, 409, 410, 413, 414, 415, 422, 429, 431, 500, 501, 502, 503, 504,
] as const;

/** La clave de i18n que explica un status o un error de red. */
export function failureKey(detail: Pick<RequestDetail, "status" | "errorKind" | "error">): string | null {
  if (detail.error || detail.errorKind) return `browser.debug.network.errorKind.${detail.errorKind ?? "other"}`;
  const status = detail.status;
  if (status === null || status < 400) return null;
  if ((EXPLAINED_STATUS as readonly number[]).includes(status)) return `browser.debug.network.code.${status}`;
  return `browser.debug.network.code.${statusClass(status)}`;
}

const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * El pedido como `curl`, para repetirlo desde una terminal. Con las cabeceras que recibió
 * el servidor, menos las que `curl` pone solo.
 */
export function curlCommand(detail: RequestDetail): string {
  const parts = ["curl", shellQuote(detail.url)];
  if (detail.method !== "GET") parts.push("-X", detail.method);
  for (const h of detail.requestHeaders) {
    const name = h.name.toLowerCase();
    if (h.note === "removed" || name === "host" || name === "content-length") continue;
    parts.push("-H", shellQuote(`${h.name}: ${h.value}`));
  }
  const body = detail.requestBody;
  if (body?.text && !body.summary) parts.push("--data-raw", shellQuote(body.text));
  return parts.join(" ");
}

// ── Para un agente ───────────────────────────────────────────────

const MAX_AGENT_BODY = 6000;

function bodyForAgent(title: string, body: NetBody | null): string[] {
  if (!body) return [];
  const view = bodyView(body);
  const meta = [body.contentType, body.size !== null ? formatBytes(body.size) : null].filter(Boolean).join(", ");
  const head = `${title}${meta ? ` (${meta})` : ""}:`;
  switch (view.kind) {
    case "none":
      return [];
    case "json":
    case "text": {
      const clipped = view.text.length > MAX_AGENT_BODY;
      const text = clipped ? view.text.slice(0, MAX_AGENT_BODY) : view.text;
      const note = clipped || body.truncated ? "\n  … (cortado)" : "";
      return [head, ...text.split("\n").map((l) => `  ${l}`), ...(note ? [note.trimStart()] : [])];
    }
    case "image":
      return [`${head} imagen`];
    case "binary":
      return [`${head} binario`];
    case "compressed":
      return [`${head} comprimido (${view.encoding}), no se puede leer`];
    case "evicted":
      return [`${head} ya no está guardado (se liberó para pedidos más nuevos)`];
    case "summary":
      return [`${head} ${view.text}`];
  }
}

function headersForAgent(title: string, headers: NetHeader[]): string[] {
  if (headers.length === 0) return [];
  const note = (h: NetHeader) =>
    h.note === "rewritten" ? "   (la vista previa lo reescribe)"
      : h.note === "removed" ? "   (la vista previa lo quita)"
        : h.note === "kept" ? "   (stored in the preview's cookie jar; the page never receives this header)"
          : "";
  return [`${title}:`, ...headers.map((h) => `  ${h.name}: ${h.value}${note(h)}`)];
}

export function detailForAgent(d: RequestDetail): string {
  const status = d.pending
    ? "pendiente"
    : d.error
      ? `sin respuesta${d.errorKind ? ` (${d.errorKind})` : ""}`
      : `${d.status ?? "—"}${d.statusText ? ` ${d.statusText}` : ""}`;
  const general = [
    `[${d.key}] ${d.method} ${d.url}`,
    `Estado: ${status}${d.httpVersion ? ` · ${d.httpVersion}` : ""}${d.remoteAddress ? ` · ${d.remoteAddress}` : ""} · ${d.via === "proxy" ? "visto por el proxy" : "visto desde la página (otro origen)"}`,
    `Tiempos: ${d.ttfbMs !== null ? `espera ${d.ttfbMs} ms · ` : ""}total ${d.durationMs ?? "—"} ms${d.size !== null ? ` · ${formatBytes(d.size)}` : ""}`,
  ];
  if (d.error) general.push(`Error: ${d.error}`);
  if (d.redirected && d.finalUrl) general.push(`Redirigido a: ${d.finalUrl}`);
  const params = queryParams(d.url);
  const sections = [
    general,
    params.length ? ["Parámetros de la URL:", ...params.map(([k, v]) => `  ${k} = ${v}`)] : [],
    headersForAgent("Encabezados de la solicitud", d.requestHeaders),
    bodyForAgent("Cuerpo de la solicitud", d.requestBody),
    headersForAgent("Encabezados de la respuesta", d.responseHeaders),
    d.headersLimited && d.responseHeaders.length > 0
      ? ["  (desde la página solo se ven las cabeceras que permite CORS)"]
      : [],
    bodyForAgent("Cuerpo de la respuesta", d.responseBody),
  ];
  return sections.filter((s) => s.length).map((s) => s.join("\n")).join("\n\n");
}
