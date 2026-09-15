import { describe, expect, it } from "vitest";

import type { LoggedRequest } from "../debugLog";
import type { ProxyRequestDetail } from "../ipc";
import {
  bodyView, curlCommand, detailForAgent, detailFromPage, detailFromProxy, failureKey, formFields, queryParams,
  requestCookies, responseCookies, statusClass,
} from "../networkDetail";
import {
  errorKindOf, headerList, parseRawHeaders, readResponseBody, requestBodyPreview,
} from "../page/netCapture";

function proxyDetail(patch: Partial<ProxyRequestDetail> = {}): ProxyRequestDetail {
  return {
    seq: 7, rev: 9, at: 1000, method: "POST", url: "http://localhost:5173/api/login?next=%2Fpanel&next=2",
    status: 401, statusText: "Unauthorized", contentType: "application/json", size: 27, ttfbMs: 12, durationMs: 15,
    finished: true, error: null, errorKind: null, websocket: false,
    requestHeaders: [
      { name: "host", value: "localhost:5173", note: "rewritten" },
      { name: "content-type", value: "application/json", note: null },
      { name: "cookie", value: "sid=abc; tema=oscuro", note: null },
      { name: "accept-encoding", value: "gzip", note: "removed" },
      { name: "content-length", value: "31", note: null },
    ],
    responseHeaders: [
      { name: "content-type", value: "application/json", note: null },
      { name: "set-cookie", value: "sid=; Path=/; Max-Age=0; HttpOnly", note: null },
    ],
    httpVersion: "HTTP/1.1", remoteAddress: "127.0.0.1:5173",
    requestBody: { size: 31, text: '{"email":"it\'s@x.com","pw":"1"}', truncated: false, contentType: "application/json" },
    responseBody: { size: 27, text: '{"error":"credenciales"}', truncated: false, contentType: "application/json" },
    ...patch,
  };
}

describe("detalle de un pedido", () => {
  it("lo del proxy y lo de la página quedan con la misma forma", () => {
    const fromProxy = detailFromProxy(proxyDetail());
    expect([fromProxy.key, fromProxy.via, fromProxy.headersLimited, fromProxy.pending]).toEqual(["p7", "proxy", false, false]);

    const page: LoggedRequest = {
      id: 3, doc: "a", at: 5, method: "GET", url: "https://api.x/me", status: 200, type: "fetch", durationMs: 40, size: 9,
      statusText: "OK", responseHeaders: [{ name: "content-type", value: "application/json" }], responseType: "cors",
    };
    const fromPage = detailFromPage(page);
    expect([fromPage.key, fromPage.via, fromPage.headersLimited, fromPage.contentType, fromPage.type])
      .toEqual(["g3", "page", true, "application/json", "fetch"]);
  });

  it("lee los parámetros de la URL, repetidos incluidos", () => {
    expect(queryParams("http://x/a?next=%2Fpanel&next=2&q=a+b")).toEqual([["next", "/panel"], ["next", "2"], ["q", "a b"]]);
    expect(queryParams("no es url")).toEqual([]);
  });

  it("un formulario urlencoded se muestra como campos", () => {
    expect(formFields({ size: 9, text: "a=1&b=dos", truncated: false, contentType: "application/x-www-form-urlencoded" }))
      .toEqual([["a", "1"], ["b", "dos"]]);
    expect(formFields({ size: 9, text: "a=1", truncated: false, contentType: "text/plain" })).toBeNull();
  });

  it("muestra cada cuerpo como se puede", () => {
    expect(bodyView({ size: 7, text: '{"a":1}', truncated: false, contentType: "application/json" }))
      .toEqual({ kind: "json", text: '{\n  "a": 1\n}' });
    // Un JSON cortado no se puede indentar: va tal cual.
    expect(bodyView({ size: 900, text: '{"a":', truncated: true, contentType: "application/json" }).kind).toBe("text");
    expect(bodyView({ size: 3, base64: "iVBO", truncated: false, contentType: "image/png" }))
      .toEqual({ kind: "image", dataUrl: "data:image/png;base64,iVBO" });
    expect(bodyView({ size: 3, base64: "AAAA", truncated: false, contentType: "application/octet-stream" }).kind).toBe("binary");
    expect(bodyView({ size: 3, truncated: false, evicted: true })).toEqual({ kind: "evicted" });
    expect(bodyView({ size: 3, truncated: false, encoding: "br" })).toEqual({ kind: "compressed", encoding: "br" });
    expect(bodyView(null)).toEqual({ kind: "none" });
  });

  it("separa las cookies que mandó el navegador de las que puso el servidor", () => {
    const d = detailFromProxy(proxyDetail());
    expect(requestCookies(d.requestHeaders).map((c) => [c.name, c.value])).toEqual([["sid", "abc"], ["tema", "oscuro"]]);
    expect(responseCookies(d.responseHeaders)).toEqual([
      { name: "sid", value: "", attributes: ["Path=/", "Max-Age=0", "HttpOnly"] },
    ]);
  });

  it("explica el código o el error", () => {
    expect(statusClass(404)).toBe("client");
    expect(statusClass(503)).toBe("server");
    expect(failureKey({ status: 404, error: null, errorKind: null })).toBe("browser.debug.network.code.404");
    // Un código sin explicación propia usa la de su familia.
    expect(failureKey({ status: 418, error: null, errorKind: null })).toBe("browser.debug.network.code.client");
    expect(failureKey({ status: 200, error: null, errorKind: null })).toBeNull();
    expect(failureKey({ status: null, error: "tcp connect error", errorKind: "connectionRefused" }))
      .toBe("browser.debug.network.errorKind.connectionRefused");
  });

  it("arma un curl que se puede pegar en una terminal", () => {
    const curl = curlCommand(detailFromProxy(proxyDetail()));
    expect(curl).toBe(
      "curl 'http://localhost:5173/api/login?next=%2Fpanel&next=2' -X POST -H 'content-type: application/json' " +
      "-H 'cookie: sid=abc; tema=oscuro' --data-raw '{\"email\":\"it'\\''s@x.com\",\"pw\":\"1\"}'"
    );
  });

  it("para un agente trae estado, cabeceras y cuerpos, marcando lo que cambió la vista previa", () => {
    const text = detailForAgent(detailFromProxy(proxyDetail()));
    expect(text).toContain("[p7] POST http://localhost:5173/api/login");
    expect(text).toContain("Estado: 401 Unauthorized · HTTP/1.1 · 127.0.0.1:5173 · visto por el proxy");
    expect(text).toContain("Tiempos: espera 12 ms · total 15 ms · 27 B");
    expect(text).toContain("  host: localhost:5173   (la vista previa lo reescribe)");
    expect(text).toContain("  accept-encoding: gzip   (la vista previa lo quita)");
    expect(text).toContain('    "error": "credenciales"');
    expect(text).toContain("  next = /panel");

    const failed = detailForAgent(detailFromProxy(proxyDetail({
      status: null, statusText: null, error: "tcp connect error: Connection refused", errorKind: "connectionRefused",
      responseHeaders: [], responseBody: null,
    })));
    expect(failed).toContain("Estado: sin respuesta (connectionRefused)");
    expect(failed).toContain("Error: tcp connect error: Connection refused");
  });
});

describe("captura desde la página", () => {
  it("las cabeceras de un pedido, vengan como vengan", () => {
    expect(headerList({ "Content-Type": "application/json", "X-Id": "1" })).toEqual([
      { name: "content-type", value: "application/json" }, { name: "x-id", value: "1" },
    ]);
    expect(headerList([["accept", "text/html"]])).toEqual([{ name: "accept", value: "text/html" }]);
    expect(headerList(undefined)).toEqual([]);
    expect(parseRawHeaders("Content-Type: text/plain\r\nX-Rate-Limit: 10\r\n")).toEqual([
      { name: "content-type", value: "text/plain" }, { name: "x-rate-limit", value: "10" },
    ]);
  });

  it("el cuerpo que arma la página, sin consumir lo que no es texto", () => {
    expect(requestBodyPreview('{"a":1}', "application/json")).toEqual({ size: 7, text: '{"a":1}', truncated: false, contentType: "application/json" });
    expect(requestBodyPreview(new URLSearchParams({ q: "hola" }), null)?.text).toBe("q=hola");
    const form = new FormData();
    form.append("nombre", "Ana");
    form.append("foto", new Blob(["1234"]), "yo.png");
    expect(requestBodyPreview(form, null)?.text).toBe("nombre=Ana\nfoto=[archivo yo.png, 4 B]");
    expect(requestBodyPreview(new Uint8Array(5), null)?.summary).toBe("binario (5 B)");
    expect(requestBodyPreview("x".repeat(20), null, 8)).toMatchObject({ text: "xxxxxxxx", truncated: true, size: 20 });
    expect(requestBodyPreview(null, null)).toBeNull();
  });

  it("lee el principio de la respuesta sin robársela a la página", async () => {
    const response = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    const body = await readResponseBody(response);
    expect(body).toMatchObject({ text: '{"ok":true}', truncated: false, size: 11 });
    // La página todavía la puede leer entera.
    expect(await response.json()).toEqual({ ok: true });

    const big = await readResponseBody(new Response("y".repeat(100), { headers: { "content-type": "text/plain" } }), { max: 10 });
    expect(big).toMatchObject({ truncated: true });
    expect(big?.text?.length).toBeGreaterThanOrEqual(10);

    const image = await readResponseBody(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    expect(image).toMatchObject({ base64: "iVBORw==", truncated: false });
  });

  it("un stream que no termina se deja de leer a tiempo", async () => {
    const endless = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("dato")); } });
    const body = await readResponseBody(new Response(endless, { headers: { "content-type": "text/plain" } }), { waitMs: 50 });
    expect(body).toMatchObject({ text: "dato", truncated: true, summary: "se dejó de leer: tardaba demasiado" });
  });

  it("clasifica por qué no hubo respuesta", () => {
    expect(errorKindOf(new DOMException("x", "AbortError"))).toBe("aborted");
    expect(errorKindOf(new TypeError("Failed to fetch"))).toBe("network");
  });
});
