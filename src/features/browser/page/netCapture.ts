/**
 * Lo que la página guarda de un pedido a otro origen para el panel de red: cabeceras,
 * cuerpos y por qué falló. Funciones sueltas y sin estado, para probarlas en Node; el
 * runtime las usa desde sus envoltorios de `fetch` y `XMLHttpRequest`.
 *
 * Todo con tope: esto corre adentro de la página del usuario, y guardar una descarga de
 * 50 MB para mostrarla en un panel sería hacerle pagar a su página lo que mira la app.
 */
import type { NetBody, NetErrorKind, NetHeader } from "../protocol";

/** Hasta cuánto de un cuerpo se guarda desde la página. */
export const MAX_PAGE_BODY = 256 * 1024;

/** Cuánto se espera un cuerpo antes de dejarlo: un stream largo no puede tener el pedido
 *  pendiente para siempre. */
export const BODY_WAIT_MS = 3000;

/** Un `HeadersInit` cualquiera (objeto, pares, `Headers`) como lista. */
export function headerList(source: HeadersInit | null | undefined): NetHeader[] {
  if (!source) return [];
  try {
    return [...new Headers(source)].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** Lo que devuelve `getAllResponseHeaders()`: una cabecera por línea. */
export function parseRawHeaders(raw: string | null | undefined): NetHeader[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      return colon > 0 ? { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() } : null;
    })
    .filter((h): h is NetHeader => h !== null);
}

export function headerValue(headers: NetHeader[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** Si un content-type se puede mostrar como texto. */
export function isTextual(contentType: string | null | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.startsWith("text/") || /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv/.test(ct);
}

const clipText = (text: string, max: number): NetBody => ({
  size: new TextEncoder().encode(text).length,
  text: text.length > max ? text.slice(0, max) : text,
  truncated: text.length > max,
});

/**
 * El cuerpo de un pedido tal como lo armó la página. Lo que no es texto no se lee (un
 * `Blob` o un stream habría que consumirlos): se describe.
 */
export function requestBodyPreview(body: unknown, contentType: string | null, max = MAX_PAGE_BODY): NetBody | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return { ...clipText(body, max), contentType };
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return { ...clipText(body.toString(), max), contentType: contentType ?? "application/x-www-form-urlencoded" };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const lines: string[] = [];
    body.forEach((value, name) => {
      lines.push(typeof value === "string" ? `${name}=${value}` : `${name}=[archivo ${(value as File).name || "sin nombre"}, ${(value as Blob).size} B]`);
    });
    return { size: null, text: lines.join("\n"), truncated: false, contentType: contentType ?? "multipart/form-data", summary: "FormData" };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { size: body.size, truncated: false, contentType: body.type || contentType, summary: `Blob (${body.size} B)` };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const size = body instanceof ArrayBuffer ? body.byteLength : (body as ArrayBufferView).byteLength;
    return { size, truncated: false, contentType, summary: `binario (${size} B)` };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return { size: null, truncated: false, contentType, summary: "stream" };
  }
  return { size: null, truncated: false, contentType, summary: Object.prototype.toString.call(body) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * Lee el principio de una respuesta sin robársela a la página: sobre un `clone()`, hasta
 * `max` bytes o `waitMs`, y después suelta el resto.
 */
export async function readResponseBody(
  response: Response,
  { max = MAX_PAGE_BODY, waitMs = BODY_WAIT_MS, timer = setTimeout }: { max?: number; waitMs?: number; timer?: typeof setTimeout } = {}
): Promise<NetBody | null> {
  const contentType = response.headers.get("content-type");
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const size = Number.isFinite(declared) ? declared : null;
  if (response.type === "opaque" || response.type === "opaqueredirect") {
    return { size: null, truncated: false, contentType, summary: "respuesta opaca (no-cors): el navegador no deja leerla" };
  }
  if ((contentType ?? "").toLowerCase().includes("event-stream")) {
    return { size, truncated: false, contentType, summary: "stream de eventos (Server-Sent Events)" };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const body = response.clone().body;
    if (!body) return null;
    reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let read = 0;
    let done = false;
    let timedOut = false;
    const deadline = new Promise<"timeout">((resolve) => timer(() => resolve("timeout"), waitMs));
    while (read < max) {
      const step = await Promise.race([reader.read(), deadline]);
      if (step === "timeout") {
        timedOut = true;
        break;
      }
      if (step.done) {
        done = true;
        break;
      }
      chunks.push(step.value);
      read += step.value.byteLength;
    }
    const bytes = new Uint8Array(Math.min(read, max));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.byteLength, bytes.length - offset);
      bytes.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= bytes.length) break;
    }
    const truncated = !done;
    const total = done ? read : size;
    if (isTextual(contentType) || contentType === null) {
      const text = new TextDecoder().decode(bytes, { stream: truncated });
      return { size: total, text, truncated, contentType, summary: timedOut ? "se dejó de leer: tardaba demasiado" : null };
    }
    return { size: total, base64: toBase64(bytes), truncated, contentType };
  } catch {
    return { size, truncated: false, contentType, summary: "no se pudo leer el cuerpo" };
  } finally {
    reader?.cancel().catch(() => undefined);
  }
}

/** Por qué no hubo respuesta, hasta donde lo deja saber el navegador. */
export function errorKindOf(error: unknown): NetErrorKind {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError") return "timeout";
  return "network";
}
