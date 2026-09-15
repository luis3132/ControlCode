/**
 * El runtime de la página: lo que deja a un agente usar la página como la usaría una
 * persona, y lo que alimenta el panel de debug. NO es parte del bundle de la app: se
 * compila a un script suelto (`import runtimeScript from "./page/runtime.ts?script"`) y
 * el proxy lo sirve junto con el selector, justo después de `<head>`.
 *
 * Eso último importa: corre ANTES que cualquier script de la página, así que los errores,
 * logs y pedidos de red de la carga inicial —los que más interesan cuando algo no
 * arranca— quedan capturados desde el primero.
 *
 * Dos mitades que no se tocan:
 *
 * - **Captura**, siempre prendida: consola, errores sin atrapar, recursos que no cargaron
 *   y pedidos de red a otros orígenes. Se juntan y se mandan en tandas.
 * - **Órdenes**, solo cuando la app las pide: snapshot, click, tipear, leer el storage…
 *   Cada una contesta con el mismo `id` con que llegó.
 *
 * Todo lo que sale de acá es contenido de la página, y para un agente es DATO: un texto
 * de la página que diga "ignorá tus instrucciones" es texto de la página.
 */
import type {
  AppMessage, ConsoleEntry, ConsoleLevel, DebugBatch, PageCommand, PageMessage, PageNetworkEntry, StorageArea,
} from "../protocol";
import { describeElement, selectorOf } from "./dom";
import {
  errorKindOf, headerList, headerValue, parseRawHeaders, readResponseBody, requestBodyPreview, MAX_PAGE_BODY,
} from "./netCapture";
import { callerOf, clip, displayPath, formatConsoleArgs, formatValue, toTransferable } from "./serialize";
import {
  displayHref, formatSnapshot, normalizeName, parseKeyCombo, parseTarget, type SnapshotNode,
} from "./snapshotFormat";

declare global {
  interface Window {
    __controlcodePage?: boolean;
  }
}

(() => {
  if (window.__controlcodePage || window.parent === window) return;
  window.__controlcodePage = true;

  // Las referencias nativas se toman ahora, antes de que la página pueda envolverlas: un
  // `setTimeout` o un `fetch` parcheados por la página (mocks, polyfills) no pueden
  // romper la captura.
  const setTimer = window.setTimeout.bind(window);
  const clearTimer = window.clearTimeout.bind(window);
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  const doc = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let parentOrigin: string | null = null;

  /** `false` si no se pudo mandar: todavía sin conectar, o algo que no se puede clonar. */
  function post(message: Omit<PageMessage, "source">, beforeConnect = false): boolean {
    if (!parentOrigin && !beforeConnect) return false;
    const full = { source: "controlcode-preview", ...message } as PageMessage;
    // El origen de la app se aprende del primer mensaje que manda; si el motor lo
    // serializa como "null" no hay a quién apuntar con precisión.
    const target = parentOrigin && parentOrigin !== "null" ? parentOrigin : "*";
    try {
      window.parent.postMessage(full, target);
      return true;
    } catch {
      return false;
    }
  }

  // ── Captura ───────────────────────────────────────────────────

  const MAX_QUEUE = 500;
  const pending: { console: ConsoleEntry[]; network: PageNetworkEntry[] } = { console: [], network: [] };
  let flushTimer: number | null = null;

  function flush(): void {
    if (flushTimer !== null) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    // Hasta conectar se acumula: lo que pasó durante la carga es justo lo que se quiere ver.
    if (!parentOrigin || (pending.console.length === 0 && pending.network.length === 0)) return;
    const batch: DebugBatch = {
      doc,
      url: location.href,
      console: pending.console.splice(0),
      network: pending.network.splice(0),
    };
    post({ type: "debug:batch", payload: batch });
  }

  function schedule(): void {
    if (flushTimer === null) flushTimer = setTimer(flush, 150);
  }

  function pushConsole(entry: ConsoleEntry): void {
    if (pending.console.length >= MAX_QUEUE) pending.console.shift();
    pending.console.push(entry);
    schedule();
  }

  function pushNetwork(entry: PageNetworkEntry): void {
    if (pending.network.length >= MAX_QUEUE) pending.network.shift();
    pending.network.push(entry);
    schedule();
  }

  const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const level of LEVELS) {
    const original = con[level];
    if (typeof original !== "function") continue;
    con[level] = function (this: unknown, ...args: unknown[]) {
      try {
        pushConsole({ at: Date.now(), level, kind: "console", text: formatConsoleArgs(args), source: callerOf(new Error().stack) });
      } catch {
        /* capturar nunca puede impedir que la página loguee */
      }
      return original.apply(this, args);
    };
  }
  const originalAssert = con.assert;
  if (typeof originalAssert === "function") {
    con.assert = function (this: unknown, condition?: unknown, ...args: unknown[]) {
      if (!condition) {
        pushConsole({
          at: Date.now(), level: "error", kind: "console",
          text: `Assertion failed${args.length ? `: ${formatConsoleArgs(args)}` : ""}`,
          source: callerOf(new Error().stack),
        });
      }
      return originalAssert.call(this, condition, ...args);
    };
  }

  window.addEventListener("error", (event) => {
    const target = event.target as (Element & { src?: string; href?: string; currentSrc?: string }) | null;
    // En fase de captura también llegan los `<img>`/`<script>`/`<link>` que no cargaron:
    // esos no burbujean, y son la mitad de los "la página se ve rota".
    if (target && (target as unknown) !== window && target.nodeType === 1) {
      const url = target.currentSrc || target.src || target.href || "";
      pushConsole({
        at: Date.now(), level: "error", kind: "resource",
        text: `No cargó <${target.tagName.toLowerCase()}> ${url}`,
      });
      return;
    }
    const e = event as ErrorEvent;
    const error = e.error as { stack?: string } | undefined;
    pushConsole({
      at: Date.now(),
      level: "error",
      kind: "exception",
      text: clip(e.error ? formatValue(e.error) : e.message || "Error", 4000),
      source: e.filename ? `${displayPath(e.filename)}:${e.lineno}:${e.colno}` : callerOf(error?.stack),
      stack: error?.stack ? clip(String(error.stack), 3000) : undefined,
    });
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string } | undefined;
    pushConsole({
      at: Date.now(),
      level: "error",
      kind: "rejection",
      text: `Promesa rechazada sin catch: ${formatValue(event.reason)}`,
      source: callerOf(reason?.stack),
      stack: reason?.stack ? clip(String(reason.stack), 3000) : undefined,
    });
  });

  // Red. Los pedidos al propio servidor pasan por el proxy, que los registra mejor que
  // cualquier cosa que se pueda ver desde acá; la página solo cuenta los que van a OTRO
  // origen (una API en otro puerto, un CDN), que el proxy no ve.
  const isForeign = (url: string): boolean => {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };
  const absolute = (url: string): string => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };
  const sizeFrom = (header: string | null): number | null => {
    const n = header ? Number.parseInt(header, 10) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };

  if (nativeFetch) {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      let url = "";
      let method = "GET";
      try {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      } catch {
        /* un input raro: fetch decide */
      }
      const result = nativeFetch(input, init);
      if (!url || !isForeign(url)) return result;
      const at = Date.now();
      const started = performance.now();
      let detail: Pick<PageNetworkEntry, "requestHeaders" | "requestBody"> = {};
      try {
        const requestHeaders = headerList(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        detail = {
          requestHeaders,
          requestBody: requestBodyPreview(init?.body ?? null, headerValue(requestHeaders, "content-type")),
        };
      } catch {
        /* capturar nunca puede romper el pedido */
      }
      const base = { at, method, url: absolute(url), type: "fetch", ...detail };
      return result.then(
        (response) => {
          const ttfbMs = Math.round(performance.now() - started);
          // El cuerpo se lee de un clon y sin demorar a la página: ella recibe su respuesta ya.
          readResponseBody(response, { timer: setTimer as typeof setTimeout })
            .catch(() => null)
            .then((responseBody) => {
              pushNetwork({
                ...base,
                status: response.status || null,
                statusText: response.statusText || null,
                ttfbMs,
                durationMs: Math.round(performance.now() - started),
                size: responseBody?.size ?? sizeFrom(response.headers.get("content-length")),
                responseHeaders: headerList(response.headers),
                responseBody,
                responseType: response.type,
                redirected: response.redirected,
                finalUrl: response.redirected ? response.url : null,
              });
            });
          return response;
        },
        (error: unknown) => {
          pushNetwork({
            ...base, status: null, durationMs: Math.round(performance.now() - started), size: null,
            error: formatValue(error), errorKind: errorKindOf(error),
          });
          throw error;
        }
      );
    };
  }

  const xhrInfo = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: { name: string; value: string }[] }>();
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: String(url), headers: [] });
    return (xhrOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    xhrInfo.get(this)?.headers.push({ name: String(name).toLowerCase(), value: String(value) });
    return xhrSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = xhrInfo.get(this);
    if (info && isForeign(info.url)) {
      const at = Date.now();
      const started = performance.now();
      let ttfbMs: number | null = null;
      let ended: "abort" | "timeout" | null = null;
      this.addEventListener("readystatechange", () => {
        if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED && ttfbMs === null) ttfbMs = Math.round(performance.now() - started);
      });
      this.addEventListener("abort", () => { ended = "abort"; });
      this.addEventListener("timeout", () => { ended = "timeout"; });
      this.addEventListener("loadend", () => {
        try {
          const responseHeaders = parseRawHeaders(this.getAllResponseHeaders());
          const contentType = headerValue(responseHeaders, "content-type");
          const failed = this.status === 0;
          pushNetwork({
            at, method: info.method, url: absolute(info.url), type: "xhr",
            status: this.status || null,
            statusText: this.statusText || null,
            ttfbMs,
            durationMs: Math.round(performance.now() - started),
            size: sizeFrom(this.getResponseHeader("content-length")),
            requestHeaders: info.headers,
            requestBody: requestBodyPreview(body ?? null, headerValue(info.headers, "content-type")),
            responseHeaders,
            responseBody: failed ? null : xhrBody(this, contentType),
            error: failed
              ? ended === "abort" ? "cancelado" : ended === "timeout" ? "se venció el tiempo de espera" : "sin respuesta (red caída o bloqueado por CORS)"
              : undefined,
            errorKind: failed ? (ended === "abort" ? "aborted" : ended === "timeout" ? "timeout" : "network") : undefined,
          });
        } catch {
          /* capturar nunca puede romper el pedido */
        }
      });
    }
    return xhrSend.call(this, body);
  };

  /** El cuerpo de un XHR ya terminado, según cómo pidió la página leerlo. */
  function xhrBody(xhr: XMLHttpRequest, contentType: string | null): PageNetworkEntry["responseBody"] {
    if (xhr.responseType === "" || xhr.responseType === "text") {
      const text = xhr.responseText ?? "";
      return { size: text.length, text: text.slice(0, MAX_PAGE_BODY), truncated: text.length > MAX_PAGE_BODY, contentType };
    }
    if (xhr.responseType === "json") {
      const text = JSON.stringify(xhr.response) ?? "";
      return { size: null, text: text.slice(0, MAX_PAGE_BODY), truncated: text.length > MAX_PAGE_BODY, contentType };
    }
    return { size: null, truncated: false, contentType, summary: `responseType "${xhr.responseType}"` };
  }

  const vitals: { lcp: number | null; cls: number | null; longTasks: { count: number; totalMs: number } | null } = {
    lcp: null, cls: null, longTasks: null,
  };

  if (typeof PerformanceObserver === "function") {
    try {
      // El buffer por defecto es de 250 entradas: un servidor de desarrollo sirve más
      // módulos que eso en una sola carga.
      performance.setResourceTimingBufferSize?.(2000);
    } catch {
      /* no disponible */
    }
    const observe = (type: string, onEntries: (entries: PerformanceEntry[]) => void): boolean => {
      try {
        new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, buffered: true });
        return true;
      } catch {
        return false;
      }
    };
    observe("resource", (entries) => {
      for (const entry of entries as PerformanceResourceTiming[]) {
        // fetch y XHR ya los cuentan sus envoltorios, con el status.
        if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") continue;
        if (!isForeign(entry.name)) continue;
        const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
        pushNetwork({
          at: Math.round(performance.timeOrigin + entry.startTime),
          method: "GET",
          url: entry.name,
          status: status && status > 0 ? status : null,
          type: entry.initiatorType || "other",
          durationMs: Math.round(entry.duration),
          size: entry.transferSize > 0 ? entry.transferSize : null,
        });
      }
    });
    observe("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last) vitals.lcp = Math.round(last.startTime);
    });
    if (observe("layout-shift", (entries) => {
      for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) vitals.cls = (vitals.cls ?? 0) + entry.value;
      }
    })) vitals.cls = vitals.cls ?? 0;
    if (observe("longtask", (entries) => {
      const current = vitals.longTasks ?? { count: 0, totalMs: 0 };
      for (const entry of entries) {
        current.count += 1;
        current.totalMs += Math.round(entry.duration);
      }
      vitals.longTasks = current;
    })) vitals.longTasks = vitals.longTasks ?? { count: 0, totalMs: 0 };
  }

  window.addEventListener("pagehide", flush);

  // ── Órdenes ───────────────────────────────────────────────────

  /** Los refs del último snapshot. Se reemplazan enteros con cada uno: un ref viejo que
   *  apunte a otra cosa sería peor que un ref que no existe. */
  let refs = new Map<string, Element>();

  const INTERACTIVE_ROLES = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider",
    "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  ]);
  /** Roles cuyo nombre es su propio texto: adentro no hay nada más que listar. */
  const NAME_FROM_CONTENT = new Set([...INTERACTIVE_ROLES, "heading", "listitem", "cell", "columnheader", "rowheader"]);
  const HAS_STRUCTURE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[role]", "[tabindex]",
    "[contenteditable]", "img[alt]:not([alt=''])", "h1", "h2", "h3", "h4", "h5", "h6", "iframe", "video", "ul", "ol", "table",
  ].join(",");
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "svg"]);
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button",
    reset: "button", image: "button", file: "button", search: "searchbox", number: "spinbutton",
  };
  const TAG_ROLES: Record<string, string> = {
    BUTTON: "button", TEXTAREA: "textbox", SUMMARY: "button", H1: "heading", H2: "heading", H3: "heading",
    H4: "heading", H5: "heading", H6: "heading", NAV: "navigation", MAIN: "main", HEADER: "banner",
    FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", UL: "list", OL: "list",
    LI: "listitem", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", IFRAME: "iframe", VIDEO: "video",
  };

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
    switch (el.tagName) {
      case "A": return el.hasAttribute("href") ? "link" : null;
      case "INPUT": {
        const type = (el as HTMLInputElement).type;
        return type === "hidden" ? null : (INPUT_ROLES[type] ?? "textbox");
      }
      case "SELECT": {
        const select = el as HTMLSelectElement;
        return select.multiple || select.size > 1 ? "listbox" : "combobox";
      }
      case "IMG": return el.getAttribute("alt") === "" ? null : "img";
    }
    if (TAG_ROLES[el.tagName]) return TAG_ROLES[el.tagName];
    if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return "textbox";
    return null;
  }

  const isFormControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";

  function textOf(el: Element): string {
    return (el as HTMLElement).innerText ?? el.textContent ?? "";
  }

  /** El texto de un `<label>` sin el del control que envuelve: el de un `<select>` son todas
   *  sus opciones, y "País Argentina Chile Uruguay" no es un nombre. */
  function labelText(label: Element): string {
    let text = "";
    for (const node of Array.from(label.childNodes)) {
      if (node.nodeType === 3) text += node.textContent ?? "";
      else if (node.nodeType === 1 && !isFormControl(node as Element)) {
        text += (node as Element).querySelector("input,select,textarea") ? labelText(node as Element) : textOf(node as Element);
      }
    }
    return text;
  }

  function nameOf(el: Element, role: string): string {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return normalizeName(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.trim()) return normalizeName(text);
    }
    if (isFormControl(el)) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) return normalizeName(Array.from(labels).map(labelText).join(" "));
      const input = el as HTMLInputElement;
      if (["button", "submit", "reset"].includes(input.type)) return normalizeName(input.value || input.type);
      return normalizeName(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
    }
    if (el.tagName === "IMG") return normalizeName(el.getAttribute("alt") || el.getAttribute("title") || "");
    if (NAME_FROM_CONTENT.has(role)) {
      const text = normalizeName(textOf(el));
      if (text) return text;
      // Un botón que es solo un icono: el nombre está en el `alt` o en el `<title>` del SVG.
      const img = el.querySelector("img[alt], svg title");
      const inner = img?.getAttribute("alt") || img?.textContent || "";
      return normalizeName(inner || el.getAttribute("title") || "");
    }
    return normalizeName(el.getAttribute("title") || "");
  }

  function statesOf(el: Element, role: string): string[] {
    const states: string[] = [];
    const attr = (name: string) => el.getAttribute(name);
    if ((el as HTMLButtonElement).disabled || attr("aria-disabled") === "true") states.push("disabled");
    if ((el as HTMLInputElement).checked || attr("aria-checked") === "true") states.push("checked");
    if (attr("aria-checked") === "mixed" || (el as HTMLInputElement).indeterminate) states.push("mixed");
    if (attr("aria-expanded") === "true") states.push("expanded");
    if (attr("aria-expanded") === "false") states.push("collapsed");
    if (attr("aria-selected") === "true" || (el as HTMLOptionElement).selected) states.push("selected");
    if (attr("aria-pressed") === "true") states.push("pressed");
    if ((el as HTMLInputElement).required || attr("aria-required") === "true") states.push("required");
    if ((el as HTMLInputElement).readOnly) states.push("readonly");
    if (attr("aria-invalid") === "true") states.push("invalid");
    if (role === "heading") states.push(`level=${attr("aria-level") ?? el.tagName.slice(1)}`);
    if (document.activeElement === el) states.push("focused");
    if (el.tagName === "DIALOG" && (el as HTMLDialogElement).open) states.push("open");
    return states;
  }

  function valueOf(el: Element): string | undefined {
    if (el.tagName === "SELECT") {
      const select = el as HTMLSelectElement;
      return normalizeName(Array.from(select.selectedOptions).map((o) => o.text).join(", "), 100);
    }
    if (el.tagName === "TEXTAREA") {
      const v = (el as HTMLTextAreaElement).value;
      return v ? normalizeName(v, 100) : undefined;
    }
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      if (["checkbox", "radio", "button", "submit", "reset", "image", "file"].includes(input.type) || !input.value) return undefined;
      // La contraseña no sale de la página: alcanza con saber que hay algo escrito.
      return input.type === "password" ? "•".repeat(Math.min(input.value.length, 8)) : normalizeName(input.value, 100);
    }
    if ((el as HTMLElement).isContentEditable) return normalizeName(textOf(el), 100) || undefined;
    return undefined;
  }

  /** Algo que la página hizo clickeable sin decirlo (`<div onClick>`): se delata por el
   *  cursor, que es lo mismo que mira una persona para saber si algo se toca. */
  function looksClickable(el: Element, style: CSSStyleDeclaration): boolean {
    if ((el as HTMLElement).tabIndex >= 0 && el.hasAttribute("tabindex")) return true;
    if (style.cursor !== "pointer") return false;
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  function snapshot(all: boolean): string {
    refs = new Map();
    const nodes: SnapshotNode[] = [];
    const limit = all ? 3000 : 600;
    let omitted = 0;
    let nextRef = 1;

    const add = (node: SnapshotNode): void => {
      if (nodes.length >= limit) omitted += 1;
      else nodes.push(node);
    };

    const walkChildren = (parent: Node, depth: number): void => {
      const host = parent as Element;
      const children: Node[] = host.shadowRoot ? Array.from(host.shadowRoot.childNodes) : Array.from(parent.childNodes);
      // El texto de un label que envuelve su control ya es el nombre del control: listarlo
      // aparte lo repetiría en la línea de arriba.
      const labelsControl = host.tagName === "LABEL" && !!(host as HTMLLabelElement).control;
      for (const child of children) {
        if (labelsControl && child.nodeType === 3) continue;
        walk(child, depth);
      }
    };

    const walk = (node: Node, depth: number): void => {
      if (node.nodeType === 3) {
        const text = normalizeName(node.textContent ?? "", 200);
        if (text) add({ depth, role: "text", name: text, states: [] });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName) || el.getAttribute("aria-hidden") === "true") return;
      if (el.tagName === "SLOT") {
        for (const assigned of (el as HTMLSlotElement).assignedNodes({ flatten: true })) walk(assigned, depth);
        return;
      }
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      const visible = style.visibility !== "hidden" && (style.display === "contents" || el.getClientRects().length > 0);

      let role = roleOf(el);
      if (!role && visible && looksClickable(el, style)) role = "clickable";
      if (!role || !visible) {
        // Un contenedor sin rol no se lista, pero lo que tiene adentro sí. Si adentro no hay
        // nada más que texto, va entero en una línea en vez de un renglón por nodo de texto.
        if (visible && !el.shadowRoot && !el.querySelector(HAS_STRUCTURE) && el.childElementCount > 0) {
          const text = normalizeName(textOf(el), 200);
          if (text) add({ depth, role: "text", name: text, states: [] });
          return;
        }
        walkChildren(el, depth);
        return;
      }

      const interactive = INTERACTIVE_ROLES.has(role) || role === "clickable";
      const leaf = interactive || (NAME_FROM_CONTENT.has(role) && !el.querySelector(HAS_STRUCTURE));
      const entry: SnapshotNode = {
        depth,
        role,
        name: leaf || !NAME_FROM_CONTENT.has(role) ? nameOf(el, role) : normalizeName(el.getAttribute("aria-label") ?? ""),
        states: statesOf(el, role),
        value: valueOf(el),
      };
      if (interactive) {
        entry.ref = `e${nextRef++}`;
        refs.set(entry.ref, el);
      }
      if (el.tagName === "A") {
        const href = (el as HTMLAnchorElement).href;
        if (href) entry.href = displayHref(href, location.origin);
      }
      add(entry);
      if (!leaf) walkChildren(el, depth + 1);
    };

    if (document.body) walkChildren(document.body, 0);
    const root = document.documentElement;
    return formatSnapshot(nodes, {
      url: location.href,
      title: document.title,
      viewport: { width: root.clientWidth, height: window.innerHeight },
      scrollY: window.scrollY,
      documentHeight: root.scrollHeight,
      omitted,
    });
  }

  function isVisible(el: Element): boolean {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function resolve(target: string): Element {
    const spec = parseTarget(target);
    if (spec.kind === "ref") {
      const el = refs.get(spec.ref);
      if (!el) throw new Error(`No hay ningún elemento ${spec.ref}: tomá un snapshot nuevo (los refs cambian con cada uno).`);
      if (!el.isConnected) throw new Error(`${spec.ref} ya no está en la página (cambió desde el último snapshot): tomá uno nuevo.`);
      return el;
    }
    if (spec.kind === "text") {
      const wanted = spec.text.toLowerCase();
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      let partial: Element | null = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || !isVisible(parent)) continue;
        const text = normalizeName(n.textContent ?? "", 10_000).toLowerCase();
        const hit = parent.closest("a[href],button,[role=button],[role=link],label,summary,[role=tab],[role=menuitem],[role=option]") ?? parent;
        if (text === wanted) return hit;
        if (!partial && text.includes(wanted)) partial = hit;
      }
      if (partial) return partial;
      throw new Error(`No hay ningún elemento visible con el texto "${spec.text}".`);
    }
    let el: Element | null;
    try {
      el = document.querySelector(spec.selector);
    } catch {
      throw new Error(`"${spec.selector}" no es un ref (e12), un texto (text=Entrar) ni un selector CSS válido.`);
    }
    if (!el) throw new Error(`Ningún elemento coincide con "${spec.selector}".`);
    return el;
  }

  /** Espera a que la página termine de reaccionar: sin cambios en el DOM por un rato, o el
   *  tope. Con timers y no con frames: un iframe que no se está mostrando no pinta. */
  function settle(maxMs = 1500, quietMs = 150): Promise<void> {
    return new Promise((done) => {
      let finished = false;
      let quiet = setTimer(finish, quietMs);
      const hard = setTimer(finish, maxMs);
      const observer = new MutationObserver(() => {
        clearTimer(quiet);
        quiet = setTimer(finish, quietMs);
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      function finish() {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimer(quiet);
        clearTimer(hard);
        done();
      }
    });
  }

  function mouse(el: Element, type: string, x: number, y: number): boolean {
    const init: MouseEventInit = {
      bubbles: !type.endsWith("enter"), cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: type.endsWith("down") ? 1 : 0, view: window,
    };
    const event = type.startsWith("pointer") && typeof PointerEvent === "function"
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
      : new MouseEvent(type.replace("pointer", "mouse"), init);
    return el.dispatchEvent(event);
  }

  /** Dónde tocar el elemento, trayéndolo a la vista. Falla si otra cosa lo tapa: eso es un
   *  bug de la página (un overlay que quedó abierto), y un click que lo atraviesa lo
   *  escondería. */
  function aim(el: Element): { x: number; y: number; target: Element } {
    el.scrollIntoView({ block: "center", inline: "center" });
    let target = el;
    let rect = el.getBoundingClientRect();
    // Los checkbox "lindos" esconden el input (0×0 o transparente) y se tocan por su label.
    const labels = isFormControl(el) ? (el as HTMLInputElement).labels : null;
    if ((rect.width === 0 || rect.height === 0) && labels && labels.length) {
      target = labels[0];
      target.scrollIntoView({ block: "center", inline: "center" });
      rect = target.getBoundingClientRect();
    }
    if (rect.width === 0 || rect.height === 0) throw new Error(`${describeElement(el)} no se ve (mide 0×0).`);
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const ok = !hit || hit === target || target.contains(hit) || hit.contains(target)
      || (labels !== null && Array.from(labels).some((l) => l === hit || l.contains(hit)));
    if (!ok && hit) {
      throw new Error(`${describeElement(el)} está tapado por ${describeElement(hit)} (${selectorOf(hit)}). `
        + "Si es un modal u overlay, cerralo primero; si hay que forzarlo, usá eval.");
    }
    return { x, y, target };
  }

  async function click(el: Element): Promise<unknown> {
    if ((el as HTMLButtonElement).disabled) throw new Error(`${describeElement(el)} está deshabilitado.`);
    const { x, y, target } = aim(el);
    const before = location.href;
    for (const type of ["pointerover", "pointerenter", "pointermove", "pointerdown"]) mouse(target, type, x, y);
    if (typeof (target as HTMLElement).focus === "function") (target as HTMLElement).focus({ preventScroll: true });
    mouse(target, "pointerup", x, y);
    // `click()` y no un MouseEvent a mano: dispara lo que hace el navegador con un click de
    // verdad (seguir el link, marcar el checkbox, enviar el form).
    if (typeof (target as HTMLElement).click === "function") (target as HTMLElement).click();
    else mouse(target, "click", x, y);
    await settle();
    return {
      clicked: describeElement(el),
      ...(location.href !== before ? { url: location.href } : {}),
      ...invalidForm(target),
    };
  }

  /** Un submit que el navegador frenó por validación no hace nada visible: sin decirlo, el
   *  agente creería que la página ignoró el click. */
  function invalidForm(el: Element): { formInvalid?: { field: string; message: string }[] } {
    const button = el as HTMLButtonElement | HTMLInputElement;
    const isSubmit = (el.tagName === "BUTTON" && (button.type === "submit" || !el.getAttribute("type")))
      || (el.tagName === "INPUT" && button.type === "submit");
    const form = isSubmit ? button.form : null;
    if (!form || form.noValidate || form.checkValidity()) return {};
    const fields = Array.from(form.elements) as HTMLInputElement[];
    return {
      formInvalid: fields
        .filter((f) => typeof f.checkValidity === "function" && !f.checkValidity())
        .slice(0, 10)
        .map((f) => ({ field: describeElement(f), message: f.validationMessage })),
    };
  }

  function nativeSetValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    // El setter del prototipo, no `el.value = …`: React guarda el último valor que vio y,
    // si se asigna directo, cree que no cambió nada y descarta el evento.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function inputEvent(el: Element, data: string | null): void {
    const event = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data })
      : new Event("input", { bubbles: true, composed: true });
    el.dispatchEvent(event);
  }

  async function type(el: Element, text: string, clear: boolean, submit: boolean): Promise<unknown> {
    if ((el as HTMLInputElement).disabled) throw new Error(`${describeElement(el)} está deshabilitado.`);
    (el as HTMLElement).focus?.({ preventScroll: false });
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (["checkbox", "radio", "button", "submit", "file"].includes((field as HTMLInputElement).type)) {
        throw new Error(`${describeElement(el)} es un ${(field as HTMLInputElement).type}: se usa con click, no tipeando.`);
      }
      if ((field as HTMLInputElement).readOnly) throw new Error(`${describeElement(el)} es de solo lectura.`);
      nativeSetValue(field, clear ? text : field.value + text);
      inputEvent(field, text);
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      if (clear) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      if (!document.execCommand("insertText", false, text)) {
        el.textContent = clear ? text : `${el.textContent ?? ""}${text}`;
        inputEvent(el, text);
      }
    } else {
      throw new Error(`${describeElement(el)} no es un campo de texto.`);
    }
    if (submit) return press("Enter", el);
    await settle(800);
    return { typed: describeElement(el), value: valueOf(el) ?? "" };
  }

  function focusables(): HTMLElement[] {
    const all = Array.from(document.querySelectorAll<HTMLElement>(
      "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable]"
    )).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && isVisible(el));
    const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...all.filter((el) => el.tabIndex === 0)];
  }

  const CLICK_ON_ENTER = new Set(["A", "BUTTON", "SUMMARY"]);

  async function press(key: string, targetEl?: Element): Promise<unknown> {
    const combo = parseKeyCombo(key);
    const el = targetEl ?? document.activeElement ?? document.body;
    if (targetEl) (targetEl as HTMLElement).focus?.({ preventScroll: false });
    const code = /^[a-z]$/i.test(combo.key) ? `Key${combo.key.toUpperCase()}`
      : /^\d$/.test(combo.key) ? `Digit${combo.key}` : combo.key === " " ? "Space" : combo.key;
    const init: KeyboardEventInit = {
      key: combo.key, code, bubbles: true, cancelable: true, composed: true,
      ctrlKey: combo.ctrlKey, shiftKey: combo.shiftKey, altKey: combo.altKey, metaKey: combo.metaKey,
    };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));

    // Una tecla sintética no hace lo que haría el teclado de verdad: eso se simula acá,
    // salvo que la página la haya cancelado con `preventDefault`.
    if (proceed) {
      const role = el.getAttribute("role");
      if (combo.key === "Enter") {
        if (CLICK_ON_ENTER.has(el.tagName) || role === "button" || role === "link") {
          (el as HTMLElement).click();
        } else if (el.tagName === "INPUT") {
          const form = (el as HTMLInputElement).form;
          if (form) {
            const submitter = form.querySelector<HTMLElement>("button:not([type]),button[type=submit],input[type=submit]");
            if (submitter) submitter.click();
            else if (typeof form.requestSubmit === "function") form.requestSubmit();
            else if (form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))) form.submit();
          }
        }
      } else if (combo.key === " " && (el.tagName === "BUTTON" || role === "button"
        || (el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
        (el as HTMLElement).click();
      } else if (combo.key === "Tab") {
        const list = focusables();
        const index = list.indexOf(el as HTMLElement);
        const next = list[(index + (combo.shiftKey ? -1 : 1) + list.length) % list.length];
        next?.focus();
      }
    }
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    await settle(1000);
    const focused = document.activeElement;
    return {
      pressed: key,
      on: describeElement(el),
      focused: focused && focused !== document.body ? describeElement(focused) : null,
    };
  }

  async function select(el: Element, value: string): Promise<unknown> {
    if (el.tagName !== "SELECT") {
      throw new Error(`${describeElement(el)} no es un <select>. Si es un menú propio, abrilo con click y elegí la opción con click.`);
    }
    const selectEl = el as HTMLSelectElement;
    const options = Array.from(selectEl.options);
    const wanted = value.trim().toLowerCase();
    const option = options.find((o) => o.value === value) ?? options.find((o) => normalizeName(o.text).toLowerCase() === wanted);
    if (!option) {
      const known = options.slice(0, 25).map((o) => `"${normalizeName(o.text)}"`).join(", ");
      throw new Error(`Ninguna opción es "${value}". Hay: ${known}`);
    }
    selectEl.value = option.value;
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(800);
    return { selected: normalizeName(option.text), value: option.value };
  }

  async function hover(el: Element): Promise<unknown> {
    const { x, y, target } = aim(el);
    for (const t of ["pointerover", "pointerenter", "pointermove"]) mouse(target, t, x, y);
    mouse(target, "mouseover", x, y);
    mouse(target, "mouseenter", x, y);
    await settle(800);
    return { hovered: describeElement(el), note: "Dispara los eventos del mouse; el :hover de CSS no se puede simular desde la página." };
  }

  async function scroll(command: Extract<PageCommand, { op: "scroll" }>): Promise<unknown> {
    const root = document.documentElement;
    if (command.target) {
      const el = resolve(command.target);
      if (command.dy) el.scrollBy(0, command.dy);
      else el.scrollIntoView({ block: "center" });
    } else if (command.to === "top") {
      window.scrollTo(0, 0);
    } else if (command.to === "bottom") {
      window.scrollTo(0, root.scrollHeight);
    } else {
      window.scrollBy(0, command.dy ?? Math.round(window.innerHeight * 0.8));
    }
    await settle(600, 100);
    return { scrollY: Math.round(window.scrollY), documentHeight: root.scrollHeight, viewportHeight: window.innerHeight };
  }

  function wait(command: Extract<PageCommand, { op: "wait" }>): Promise<unknown> {
    const { text, selector, gone } = command;
    if (!text && !selector) return Promise.reject(new Error("Pasá text o selector."));
    const timeout = Math.min(Math.max(command.timeoutMs ?? 5000, 0), 15_000);
    const started = Date.now();
    const present = (): boolean => {
      if (selector) {
        try {
          return Array.from(document.querySelectorAll(selector)).some(isVisible);
        } catch {
          throw new Error(`"${selector}" no es un selector CSS válido.`);
        }
      }
      return textOf(document.body ?? document.documentElement).toLowerCase().includes(text!.toLowerCase());
    };
    return new Promise((done, fail) => {
      const tick = () => {
        let ok: boolean;
        try {
          ok = present() !== !!gone;
        } catch (e) {
          fail(e);
          return;
        }
        if (ok) done({ waitedMs: Date.now() - started });
        else if (Date.now() - started >= timeout) {
          const what = selector ? `el selector "${selector}"` : `el texto "${text}"`;
          fail(new Error(`${gone ? "Sigue estando" : "No apareció"} ${what} después de ${timeout} ms.`));
        } else setTimer(tick, 100);
      };
      tick();
    });
  }

  async function evaluate(code: string): Promise<unknown> {
    let fn: () => Promise<unknown>;
    try {
      // Primero como expresión (`document.title`), después como cuerpo con `return`.
      fn = new Function(`return (async () => (${code}\n))()`) as () => Promise<unknown>;
    } catch {
      fn = new Function(`return (async () => {${code}\n})()`) as () => Promise<unknown>;
    }
    return toTransferable(await fn.call(window));
  }

  function layout(): unknown {
    const root = document.documentElement;
    const vw = root.clientWidth;
    const vh = window.innerHeight;
    const clips = new Map<Element, boolean>();
    const clippedByAncestor = (el: Element): boolean => {
      for (let a = el.parentElement; a && a !== document.body && a !== root; a = a.parentElement) {
        let clipped = clips.get(a);
        if (clipped === undefined) {
          const overflow = getComputedStyle(a).overflowX;
          clipped = overflow !== "visible";
          clips.set(a, clipped);
        }
        if (clipped) return true;
      }
      return false;
    };

    const overflowing: Element[] = [];
    const small: string[] = [];
    let smallCount = 0;
    let tinyTextCount = 0;
    const tinyText: string[] = [];
    const elements = document.body ? Array.from(document.body.querySelectorAll("*")).slice(0, 8000) : [];
    for (const el of elements) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if ((rect.right > vw + 1 || rect.left < -1) && !overflowing.some((o) => o.contains(el)) && !clippedByAncestor(el)) {
        if (getComputedStyle(el).position !== "fixed") overflowing.push(el);
      }
      const role = roleOf(el);
      // WCAG 2.2 pide 24×24 como mínimo para lo que se toca; un link en medio de un
      // párrafo está exceptuado, así que solo se miran los que no están en línea con texto.
      if (role && INTERACTIVE_ROLES.has(role) && (rect.width < 24 || rect.height < 24)
        && getComputedStyle(el).display !== "inline" && isVisible(el)) {
        smallCount += 1;
        if (small.length < 5) small.push(`${describeElement(el)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
      if (ownText && Number.parseFloat(getComputedStyle(el).fontSize) < 12 && isVisible(el)) {
        tinyTextCount += 1;
        if (tinyText.length < 3) tinyText.push(`${describeElement(el)} ${getComputedStyle(el).fontSize}`);
      }
    }

    return {
      viewport: { width: vw, height: vh, devicePixelRatio: window.devicePixelRatio },
      document: { width: root.scrollWidth, height: root.scrollHeight },
      horizontalScroll: root.scrollWidth > vw,
      overflowing: overflowing.slice(0, 10).map((el) => {
        const r = el.getBoundingClientRect();
        return { element: describeElement(el), selector: selectorOf(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      }),
      smallTapTargets: { count: smallCount, examples: small },
      smallText: { count: tinyTextCount, examples: tinyText },
      hasViewportMeta: !!document.querySelector("meta[name=viewport]"),
    };
  }

  function storageOf(area: StorageArea): Storage {
    return area === "local" ? window.localStorage : window.sessionStorage;
  }

  async function storage(command: Extract<PageCommand, { op: "storage" }>): Promise<unknown> {
    if (command.action === "set") {
      storageOf(command.area).setItem(command.key, command.value);
      return { ok: true };
    }
    if (command.action === "remove") {
      storageOf(command.area).removeItem(command.key);
      return { ok: true };
    }
    if (command.action === "clear") {
      storageOf(command.area).clear();
      return { ok: true };
    }
    const read = (area: StorageArea) => {
      try {
        const s = storageOf(area);
        return Array.from({ length: s.length }, (_, i) => {
          const key = s.key(i) ?? "";
          const value = s.getItem(key) ?? "";
          return { key, value: clip(value, 4000), size: key.length + value.length };
        });
      } catch (e) {
        return { error: formatValue(e) };
      }
    };
    const attempt = async <T,>(fn: () => Promise<T> | T): Promise<T | null> => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };
    return {
      local: read("local"),
      session: read("session"),
      indexedDB: await attempt(async () => {
        const idb = window.indexedDB as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> };
        return idb?.databases ? (await idb.databases()).map((d) => ({ name: d.name ?? "", version: d.version ?? null })) : null;
      }),
      cacheStorage: await attempt(async () => (typeof caches !== "undefined" ? await caches.keys() : null)),
      serviceWorkers: await attempt(async () => (navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope)
        : null)),
    };
  }

  function documentCookies(): { name: string; value: string }[] {
    return document.cookie.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? { name: "", value: pair } : { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  }

  async function cookies(command: Extract<PageCommand, { op: "cookies" }>): Promise<unknown> {
    if (command.action === "list") return { cookies: documentCookies() };
    if (command.action === "set") {
      if (/[;\r\n]/.test(command.value) || /[=;\s]/.test(command.name)) throw new Error("El nombre o el valor tienen caracteres que una cookie no admite.");
      const maxAge = command.maxAge != null ? `; max-age=${Math.round(command.maxAge)}` : "";
      document.cookie = `${command.name}=${command.value}; path=${command.path ?? "/"}${maxAge}; samesite=lax`;
      return { set: documentCookies().some((c) => c.name === command.name) };
    }
    const paths = new Set([command.path ?? "/", "/", location.pathname]);
    const segments = location.pathname.split("/").filter(Boolean);
    for (let i = 1; i < segments.length; i++) paths.add(`/${segments.slice(0, i).join("/")}`);
    for (const path of paths) document.cookie = `${command.name}=; max-age=0; path=${path}`;
    // Las HttpOnly no se pueden tocar desde acá: las borra el proxy, que es quien las vio
    // llegar y sabe con qué `Path` se guardaron.
    let viaProxy = false;
    if (nativeFetch) {
      try {
        const response = await nativeFetch(`/__controlcode__/cookies/clear?name=${encodeURIComponent(command.name)}`, {
          credentials: "same-origin", cache: "no-store",
        });
        viaProxy = response.ok;
      } catch {
        /* sin proxy delante (una página abierta por fuera de la app) */
      }
    }
    return { deleted: !documentCookies().some((c) => c.name === command.name), viaProxy };
  }

  function performanceReport(): unknown {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const round = (n: number | undefined) => (n && n > 0 ? Math.round(n) : null);
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const byType: Record<string, number> = {};
    let transfer = 0;
    for (const r of resources) {
      byType[r.initiatorType || "other"] = (byType[r.initiatorType || "other"] ?? 0) + 1;
      transfer += r.transferSize || 0;
    }
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const fcp = round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime);
    const load = round(nav?.loadEventEnd);
    return {
      navigation: nav ? {
        type: nav.type,
        ttfbMs: round(nav.responseStart),
        domContentLoadedMs: round(nav.domContentLoadedEventEnd),
        loadMs: round(nav.loadEventEnd),
        transferBytes: nav.transferSize || null,
      } : null,
      firstContentfulPaintMs: fcp,
      // Una tab de navegador que un agente carga sin mostrarla no pinta hasta que alguien la
      // mira: un FCP muy posterior a la carga mide eso, no lo que tarda la página.
      paintDeferred: fcp !== null && load !== null && fcp - load > 3000,
      largestContentfulPaintMs: vitals.lcp,
      cumulativeLayoutShift: vitals.cls === null ? null : Math.round(vitals.cls * 1000) / 1000,
      longTasks: vitals.longTasks,
      // Solo Chromium (WebView2) expone el heap de JS. En WebKit no hay forma de medirlo
      // desde la página; `null` dice eso y no "cero".
      memory: memory ? {
        usedJSHeapBytes: memory.usedJSHeapSize,
        totalJSHeapBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      } : null,
      domNodes: document.getElementsByTagName("*").length,
      resources: { count: resources.length, transferBytes: transfer, byType },
      uptimeMs: Math.round(performance.now()),
    };
  }

  function execute(command: PageCommand): Promise<unknown> | unknown {
    switch (command.op) {
      case "snapshot": return snapshot(!!command.all);
      case "click": return click(resolve(command.target));
      case "hover": return hover(resolve(command.target));
      case "type": return type(resolve(command.target), command.text, !!command.clear, !!command.submit);
      case "press": return press(command.key, command.target ? resolve(command.target) : undefined);
      case "select": return select(resolve(command.target), command.value);
      case "scroll": return scroll(command);
      case "wait": return wait(command);
      case "eval": return evaluate(command.code);
      case "layout": return layout();
      case "storage": return storage(command);
      case "cookies": return cookies(command);
      case "performance": return performanceReport();
    }
  }

  async function run(id: string, command: PageCommand): Promise<void> {
    let payload: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
    try {
      payload = { id, ok: true, result: await execute(command) };
    } catch (e) {
      payload = { id, ok: false, error: e instanceof Error ? e.message : formatValue(e) };
    }
    if (!post({ type: "page:reply", payload })) {
      post({ type: "page:reply", payload: { id, ok: false, error: "El resultado no se puede transferir a la app." } });
    }
    // Lo que la acción haya logueado viaja enseguida: la app lo junta con la respuesta.
    flush();
  }

  window.addEventListener("message", (e: MessageEvent<AppMessage>) => {
    if (e.source !== window.parent || e.data?.source !== "controlcode") return;
    parentOrigin = e.origin;
    const message = e.data;
    if (message.type === "connect" || message.type === "hello") flush();
    else if (message.type === "page:run") void run(message.id, message.command);
  });

  post({ type: "page:ready", payload: { doc, url: location.href } }, true);
})();
