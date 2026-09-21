import { describe, expect, it } from "vitest";

import {
  appendBatch, appendProxy, clearConsole, consoleForAgent, currentCounts, EMPTY_LOG, filterRequests,
  formatBytes, isFailed, MAX_CONSOLE, mergeCookies, networkForAgent, requestRows, typeOf,
  type DebugLog,
} from "../debugLog";
import type { ProxyRequest } from "../ipc";
import type { ConsoleEntry, DebugBatch } from "../protocol";
import { breakpointOf, clampViewport, fitScale, presetOf, rotate } from "../viewport";

function entry(patch: Partial<ConsoleEntry>): ConsoleEntry {
  return { at: 1000, level: "log", kind: "console", text: "hola", ...patch };
}

function batch(doc: string, console: ConsoleEntry[], url = `http://127.0.0.1:1/${doc}`): DebugBatch {
  return { doc, url, console, network: [] };
}

function proxied(seq: number, patch: Partial<ProxyRequest> = {}): ProxyRequest {
  return {
    seq, rev: seq, at: 1000 + seq, method: "GET", url: `http://localhost:5173/${seq}`, status: 200, statusText: "OK",
    contentType: "application/javascript", size: 10, ttfbMs: 2, durationMs: 3, finished: true,
    error: null, errorKind: null, websocket: false, ...patch,
  };
}

describe("el log sobrevive a las recargas", () => {
  /// Es la razón de que el log viva en la app: el error de la carga anterior, antes del
  /// redirect que se lo lleva, es el que hay que poder leer.
  it("junta las tandas de varias cargas con un separador por documento", () => {
    let log = appendBatch(EMPTY_LOG, batch("a", [entry({ text: "uno" })]));
    log = appendBatch(log, batch("a", [entry({ text: "dos" })]));
    log = appendBatch(log, batch("b", [entry({ text: "tres", level: "error" })]));

    expect(log.console.map((e) => e.text)).toEqual(["uno", "dos", "tres"]);
    expect(log.docs.map((d) => d.doc)).toEqual(["a", "b"]);
    // Los ids son una sola secuencia: el separador de "b" va entre "dos" y "tres".
    const ids = [...log.console.map((e) => e.id), ...log.docs.map((d) => d.id)].sort((x, y) => x - y);
    expect(new Set(ids).size).toBe(ids.length);
    expect(log.docs[1].id).toBeGreaterThan(log.console[1].id);
    expect(log.docs[1].id).toBeLessThan(log.console[2].id);
  });

  it("el contador mira solo la página que se está viendo", () => {
    let log = appendBatch(EMPTY_LOG, batch("a", [entry({ level: "error" }), entry({ level: "warn" })]));
    expect(currentCounts(log)).toEqual({ errors: 1, warnings: 1 });
    log = appendBatch(log, batch("b", [entry({ level: "log" })]));
    expect(currentCounts(log)).toEqual({ errors: 0, warnings: 0 });
  });

  it("tiene techo", () => {
    const many = Array.from({ length: MAX_CONSOLE + 50 }, (_, i) => entry({ text: String(i) }));
    const log = appendBatch(EMPTY_LOG, batch("a", many));
    expect(log.console).toHaveLength(MAX_CONSOLE);
    expect(log.console[log.console.length - 1].text).toBe(String(MAX_CONSOLE + 49));
  });

  it("limpiar deja la carga actual como referencia", () => {
    let log = appendBatch(EMPTY_LOG, batch("a", [entry({})]));
    log = appendBatch(log, batch("b", [entry({})]));
    log = clearConsole(log);
    expect(log.console).toEqual([]);
    expect(log.docs.map((d) => d.doc)).toEqual(["b"]);
  });
});

describe("consoleForAgent", () => {
  const log = [
    batch("a", [entry({ at: 0, text: "arrancó" })]),
    batch("b", [
      entry({ at: 0, level: "warn", text: "deprecado" }),
      entry({ at: 0, level: "error", kind: "exception", text: "TypeError: x is undefined", source: "/src/App.tsx:3:1",
        stack: "TypeError: x is undefined\n    at App (http://127.0.0.1:1/src/App.tsx:3:1)" }),
    ]),
  ].reduce(appendBatch, EMPTY_LOG as DebugLog);

  it("una línea por mensaje, con la carga de página y el lugar del código", () => {
    const { text } = consoleForAgent(log, {});
    const lines = text.split("\n").map((l) => l.replace(/\d\d:\d\d:\d\d\.\d{3}/, "T"));
    expect(lines).toEqual([
      "── T página cargada: http://127.0.0.1:1/a ──",
      "T LOG   arrancó",
      "── T página cargada: http://127.0.0.1:1/b ──",
      "T WARN  deprecado",
      "T ERROR Uncaught TypeError: x is undefined  (/src/App.tsx:3:1)",
      "      at App (http://127.0.0.1:1/src/App.tsx:3:1)",
    ]);
  });

  /// El cursor es lo que deja a un agente preguntar "¿qué pasó desde que hice click?" sin
  /// releer (ni pagar en contexto) todo lo anterior.
  it("con el cursor devuelve solo lo nuevo", () => {
    const { next } = consoleForAgent(log, {});
    expect(consoleForAgent(log, { since: next }).text).toBe("(sin mensajes de consola)");
    const later = appendBatch(log, batch("b", [entry({ text: "después" })]));
    expect(consoleForAgent(later, { since: next }).text).toMatch(/LOG {3}después$/);
  });

  it("filtra por nivel y dice cuánto recortó", () => {
    const errors = consoleForAgent(log, { level: "errors" }).text;
    expect(errors).not.toMatch(/deprecado|arrancó/);
    expect(errors).toMatch(/TypeError/);
    // De las cargas anteriores al primer mensaje mostrado va solo la última.
    expect(errors.match(/página cargada/g)).toHaveLength(1);

    const limited = consoleForAgent(log, { limit: 1 }).text;
    expect(limited.split("\n")[0]).toBe("… 2 mensajes anteriores omitidos (pasá limit para ver más)");
  });
});

describe("red", () => {
  it("clasifica por content-type y, si no hay, por extensión", () => {
    expect(typeOf("text/html; charset=utf-8", "/")).toBe("document");
    expect(typeOf("application/javascript", "/src/main.tsx")).toBe("script");
    expect(typeOf("application/json", "/api/user")).toBe("fetch");
    expect(typeOf(null, "http://cdn.x/logo.svg?v=2")).toBe("image");
    expect(typeOf(null, "/x", true)).toBe("websocket");
    expect(typeOf(null, "/api")).toBe("other");
  });

  it("mezcla lo del proxy y lo de la página en orden de tiempo", () => {
    let log = appendProxy(EMPTY_LOG, { entries: [proxied(1), proxied(3)], next: 3, dropped: false });
    log = appendBatch(log, {
      doc: "a", url: "http://127.0.0.1:1/", console: [],
      network: [{ at: 1002, method: "GET", url: "https://api.x/me", status: null, type: "fetch", durationMs: 5, size: null, error: "Failed to fetch" }],
    });
    const rows = requestRows(log);
    expect(rows.map((r) => [r.via, r.at])).toEqual([["proxy", 1001], ["page", 1002], ["proxy", 1003]]);
    expect(rows.filter(isFailed).map((r) => r.url)).toEqual(["https://api.x/me"]);
  });

  /// Dos lecturas que se pisan (el panel y un agente a la vez) no pueden duplicar filas.
  it("una página del proxy repetida no duplica", () => {
    const page = { entries: [proxied(1), proxied(2)], next: 2, dropped: false };
    const log = appendProxy(appendProxy(EMPTY_LOG, page), page);
    expect(log.proxy.map((e) => e.seq)).toEqual([1, 2]);
  });

  /// Un pedido pendiente vuelve a llegar al terminar: la fila se actualiza en su lugar, y una
  /// lectura atrasada que trae la versión vieja no la pisa.
  it("un pedido que termina reemplaza a su versión pendiente", () => {
    const pending = proxied(1, { rev: 1, status: null, statusText: null, finished: false, durationMs: 0 });
    let log = appendProxy(EMPTY_LOG, { entries: [pending, proxied(2, { rev: 2 })], next: 2, dropped: false });
    expect(requestRows(log)[0]!.pending).toBe(true);

    log = appendProxy(log, { entries: [proxied(1, { rev: 3, status: 404, statusText: "Not Found" })], next: 3, dropped: false });
    expect(log.proxy.map((e) => [e.seq, e.status])).toEqual([[1, 404], [2, 200]]);
    const row = requestRows(log)[0]!;
    expect([row.pending, row.statusText, row.version]).toEqual([false, "Not Found", 3]);

    log = appendProxy(log, { entries: [pending], next: 3, dropped: false });
    expect(log.proxy[0]!.status).toBe(404);
  });

  /// Navegar a otro servidor es otro proxy que numera desde cero: su `p1` no es el `p1` del
  /// anterior, y su cursor tampoco.
  it("otro proxy empieza su lista de cero", () => {
    let log = appendProxy(EMPTY_LOG, { entries: [proxied(1), proxied(2)], next: 40, dropped: false }, "http://127.0.0.1:1");
    log = appendProxy(log, { entries: [proxied(1, { url: "http://localhost:3000/" })], next: 2, dropped: false }, "http://127.0.0.1:2");
    expect(log.proxy.map((e) => e.url)).toEqual(["http://localhost:3000/"]);
    expect([log.proxyNext, log.proxyOrigin]).toEqual([2, "http://127.0.0.1:2"]);
  });

  it("filtra por texto, tipo y fallidos", () => {
    const log = appendProxy(EMPTY_LOG, {
      entries: [proxied(1), proxied(2, { status: 404, url: "http://localhost:5173/logo.png", contentType: "image/png" })],
      next: 2, dropped: false,
    });
    const rows = requestRows(log);
    expect(filterRequests(rows, { text: "", type: "all", failedOnly: true })).toHaveLength(1);
    expect(filterRequests(rows, { text: "404", type: "all", failedOnly: false })).toHaveLength(1);
    expect(filterRequests(rows, { text: "", type: "script", failedOnly: false })).toHaveLength(1);
  });

  it("para un agente: una línea por pedido y un cursor por tiempo", () => {
    const log = appendProxy(EMPTY_LOG, { entries: [proxied(1), proxied(2, { status: 500 })], next: 2, dropped: false });
    const rows = requestRows(log);
    const all = networkForAgent(rows, {});
    expect(all.text.split("\n")).toHaveLength(2);
    expect(all.text).toMatch(/\[p2\] GET {4}500 script {4}http:\/\/localhost:5173\/2 {2}3ms 10 B$/);
    expect(networkForAgent(rows, { since: all.next }).text).toBe("(sin pedidos)");
    expect(networkForAgent(rows, { failedOnly: true }).text.split("\n")).toHaveLength(1);
  });
});

describe("mergeCookies", () => {
  /// Las diferencias entre las tres miradas son los bugs: una cookie que el servidor puso
  /// y el navegador no devuelve casi siempre es un Path o un SameSite mal puesto.
  it("cruza lo que ve la página, lo que puso el servidor y lo que vuelve", () => {
    const rows = mergeCookies([{ name: "tema", value: "oscuro" }], {
      set: [
        { name: "sid", value: "abc", path: "/app", httpOnly: true, secure: false, sameSite: "Lax", expiresAt: null, url: "", at: 0 },
        { name: "tema", value: "oscuro", path: "/", httpOnly: false, secure: false, sameSite: null, expiresAt: null, url: "", at: 0 },
      ],
      sent: { url: "", at: 0, cookies: [{ name: "tema", value: "oscuro" }, { name: "vieja", value: "1" }] },
    });
    expect(rows.map((r) => [r.name, r.httpOnly, r.sent, r.visibleToPage])).toEqual([
      ["sid", true, false, false],
      ["tema", false, true, true],
      // Llega al servidor sin que la página la vea: HttpOnly de antes de que la app mirara.
      ["vieja", true, true, false],
    ]);
  });
});

describe("viewport", () => {
  it("achica para que entre y nunca agranda", () => {
    expect(fitScale({ width: 1920, height: 1080 }, { width: 960, height: 2000 })).toBe(0.5);
    expect(fitScale({ width: 390, height: 844 }, { width: 1200, height: 900 })).toBe(1);
  });

  it("reconoce un preset en cualquier orientación", () => {
    expect(presetOf({ width: 390, height: 844 })).toMatchObject({ preset: { id: "phone" }, rotated: false });
    expect(presetOf(rotate({ width: 390, height: 844 }))).toMatchObject({ preset: { id: "phone" }, rotated: true });
    expect(presetOf({ width: 391, height: 844 })).toBeUndefined();
  });

  it("no deja pedir tamaños absurdos", () => {
    expect(clampViewport({ width: 10, height: 99999 })).toEqual({ width: 240, height: 3840 });
  });

  it("dice en qué breakpoint cae el ancho", () => {
    expect(breakpointOf(390)).toBe("xs");
    expect(breakpointOf(768)).toBe("md");
    expect(breakpointOf(1279)).toBe("lg");
  });

  it("formatea bytes para leer", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
  });
});
