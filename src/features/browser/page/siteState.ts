/**
 * Lo que la página recuerda entre arranques de la app, por sitio (dirección + puerto): sus
 * cookies, su localStorage y su sessionStorage. Corre adentro del runtime inyectado, antes
 * que cualquier script de la página.
 *
 * El motor del webview no sirve para esto: para él la página es un iframe de terceros
 * adentro de la app, y así la trata — WebKitGTK tira su localStorage al cerrar, WKWebView
 * le bloquea las cookies, y ninguno separa las cookies por puerto. Lo explica entero
 * `src-tauri/src/preview/site.rs`. Acá está la mitad de la página:
 *
 * - **Cookies**: `document.cookie` lee y escribe el frasco del proxy, que es el que las
 *   manda al servidor. Es sincrónico porque `document.cookie` lo es: un `fetch` justo
 *   después de escribir una cookie tiene que llevarla.
 * - **Storage**: vive en el navegador como siempre; se le manda una copia al proxy cuando
 *   cambia, y la primera página después de arrancar la app repone lo que el motor perdió.
 * - **Barras de scroll**: con las barras overlay de GNOME y macOS, la página no mostraba
 *   ninguna hasta pasar el mouse por el borde exacto.
 */

/** Rutas y cabeceras que entiende el proxy (`site.rs`). */
const COOKIE_PATH = "/__controlcode__/cookie";
const STORAGE_PATH = "/__controlcode__/storage";
export const OWN_HEADER = "x-controlcode";
export const JAR_HEADER = "x-controlcode-jar";

/** Cuánto se espera después de un cambio del storage para mandar la copia. */
const FLUSH_DELAY_MS = 400;
/** Cada cuánto se mira si el storage cambió por un camino que no pasa por sus métodos. */
const POLL_MS = 2000;
/** Lo más que viaja con `keepalive` al irse de la página: más grande, el motor lo rechaza. */
const KEEPALIVE_MAX = 60_000;

export type Entries = [string, string][];

export interface StorageCopy {
  local: Entries | null;
  session: Entries | null;
}

/** Las funciones del navegador tomadas antes de que nadie las envuelva. */
export interface Natives {
  open: XMLHttpRequest["open"];
  send: XMLHttpRequest["send"];
  setHeader: XMLHttpRequest["setRequestHeader"];
  fetch: typeof fetch | null;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
}

export function takeNatives(): Natives {
  return {
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    setHeader: XMLHttpRequest.prototype.setRequestHeader,
    fetch: typeof window.fetch === "function" ? window.fetch.bind(window) : null,
    setTimeout: window.setTimeout.bind(window) as typeof setTimeout,
    setInterval: window.setInterval.bind(window) as typeof setInterval,
  };
}

/** Un pedido sincrónico al proxy. `null` si no contestó bien: sin proxy delante, la página
 *  sigue con lo que tenga el navegador. */
function ask(natives: Natives, method: "GET" | "POST", url: string, body?: string): string | null {
  try {
    const xhr = new XMLHttpRequest();
    (natives.open as (m: string, u: string, async: boolean) => void).call(xhr, method, url, false);
    natives.setHeader.call(xhr, OWN_HEADER, "1");
    natives.send.call(xhr, body ?? null);
    return xhr.status >= 200 && xhr.status < 300 ? xhr.responseText : null;
  } catch {
    return null;
  }
}

// ── Cookies ─────────────────────────────────────────────────────

/** `a=1; b=2` → pares, como los lee `cookieStore`. */
export function cookiePairs(header: string): { name: string; value: string }[] {
  return header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    return eq < 0 ? { name: "", value: part } : { name: part.slice(0, eq), value: part.slice(eq + 1) };
  });
}

export interface CookieInit {
  name: string;
  value?: string;
  path?: string | null;
  expires?: number | Date | null;
  sameSite?: string | null;
}

/** Lo que `cookieStore.set`/`delete` significan, dicho como una asignación a `document.cookie`. */
export function cookieLine(init: CookieInit, remove = false): string {
  const parts = [`${init.name}=${remove ? "" : init.value ?? ""}`, `path=${init.path ?? "/"}`];
  if (remove) parts.push("max-age=0");
  else if (init.expires != null) parts.push(`expires=${new Date(init.expires).toUTCString()}`);
  if (init.sameSite) parts.push(`samesite=${init.sameSite}`);
  return parts.join("; ");
}

export interface CookieJar {
  /** Una respuesta del proxy trae la versión del frasco: si no es la de la copia, la
   *  próxima lectura vuelve a preguntar. */
  seen(version: string | null): void;
  /** El frasco cambió por un camino que no pasa por `document.cookie`. */
  invalidate(): void;
}

/**
 * `document.cookie` contra el frasco del proxy. La lectura usa una copia mientras nada la
 * invalide (una respuesta que cambió el frasco, otra pestaña del mismo sitio que escribió,
 * otra página): hay páginas que leen cookies en cada render.
 */
export function installCookieJar(natives: Natives): CookieJar | null {
  let owner: object | null = Object.getPrototypeOf(document);
  let native: PropertyDescriptor | undefined;
  while (owner && !(native = Object.getOwnPropertyDescriptor(owner, "cookie"))) owner = Object.getPrototypeOf(owner);
  const nativeGet = native?.get;
  const nativeSet = native?.set;
  if (!owner || !nativeGet || !nativeSet || !native?.configurable) return null;

  let copy: { path: string; cookie: string; v: number } | null = null;
  let stale = true;
  const others = typeof BroadcastChannel === "function" ? new BroadcastChannel("controlcode:cookies") : null;
  if (others) others.onmessage = () => { stale = true; };

  const url = (path: string) => `${COOKIE_PATH}?path=${encodeURIComponent(path)}`;
  const take = (raw: string | null, path: string): string | null => {
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { cookie: unknown; v: unknown };
      if (typeof parsed.cookie !== "string" || typeof parsed.v !== "number") return null;
      copy = { path, cookie: parsed.cookie, v: parsed.v };
      stale = false;
      return parsed.cookie;
    } catch {
      return null;
    }
  };
  const read = (): string | null => {
    const path = location.pathname;
    if (!stale && copy && copy.path === path) return copy.cookie;
    return take(ask(natives, "GET", url(path)), path);
  };
  const write = (line: string): boolean => {
    const before = copy?.v;
    if (take(ask(natives, "POST", url(location.pathname), line), location.pathname) === null) return false;
    if (copy && copy.v !== before) others?.postMessage(copy.v);
    return true;
  };

  Object.defineProperty(owner, "cookie", {
    configurable: true,
    enumerable: native?.enumerable ?? true,
    get(this: Document) {
      if (this !== document) return nativeGet.call(this);
      return read() ?? nativeGet.call(this);
    },
    set(this: Document, value: unknown) {
      if (this !== document || !write(String(value))) nativeSet.call(this, value);
    },
  });

  // Solo si el motor lo tiene: agregarlo cambiaría qué camino toma una página que lo
  // detecta. Si se lo dejara nativo, escribiría en las cookies del motor, que ya no viajan.
  if ("cookieStore" in window) {
    const matching = (arg?: string | { name?: string }) => {
      const name = typeof arg === "string" ? arg : arg?.name;
      return cookiePairs(read() ?? "").filter((c) => name === undefined || c.name === name);
    };
    const store = Object.assign(new EventTarget(), {
      get: async (arg?: string | { name?: string }) => matching(arg)[0] ?? null,
      getAll: async (arg?: string | { name?: string }) => matching(arg),
      set: async (arg: string | CookieInit, value?: string) => {
        write(cookieLine(typeof arg === "string" ? { name: arg, value } : arg));
      },
      delete: async (arg: string | CookieInit) => {
        write(cookieLine(typeof arg === "string" ? { name: arg } : arg, true));
      },
    });
    try {
      Object.defineProperty(window, "cookieStore", { configurable: true, get: () => store });
    } catch {
      /* un motor que no deja redefinirlo sigue con el suyo */
    }
  }

  return {
    seen(version) {
      if (version !== null && Number(version) !== copy?.v) stale = true;
    },
    invalidate() {
      stale = true;
    },
  };
}

// ── Storage ─────────────────────────────────────────────────────

export function entriesOf(storage: Storage | null): Entries | null {
  if (!storage) return null;
  try {
    const out: Entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) out.push([key, storage.getItem(key) ?? ""]);
    }
    return out;
  } catch {
    return null;
  }
}

/** Algo barato que cambia cuando cambia el storage: claves y largo de cada valor. Se
 *  calcula cada pocos segundos, así que no puede serializar megas cada vez. */
export function signatureOf(storage: Storage | null): string {
  if (!storage) return "-";
  try {
    let sign = `${storage.length}`;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) sign += `|${key}:${storage.getItem(key)?.length ?? 0}`;
    }
    return sign;
  } catch {
    return "?";
  }
}

/** Lo guardado va solo a un área vacía: si el motor la conservó, la suya es la que vale. */
export function restoreInto(storage: Storage | null, saved: Entries | null, setItem: Storage["setItem"]): number {
  if (!storage || !saved?.length) return 0;
  try {
    if (storage.length > 0) return 0;
  } catch {
    return 0;
  }
  let restored = 0;
  for (const [key, value] of saved) {
    try {
      setItem.call(storage, key, value);
      restored++;
    } catch {
      break; // sin cuota: no va a entrar nada más
    }
  }
  return restored;
}

function storageArea(name: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[name];
  } catch {
    return null; // un sandbox o el usuario le negó el storage a la página
  }
}

export function installStorageSync(natives: Natives): void {
  const local = storageArea("localStorage");
  const session = storageArea("sessionStorage");
  if (!local && !session || typeof Storage === "undefined") return;
  const proto = Storage.prototype;
  const { setItem, removeItem, clear } = proto;

  const empty = (s: Storage | null) => {
    try {
      return s !== null && s.length === 0;
    } catch {
      return false;
    }
  };
  if (empty(local) || empty(session)) {
    let saved: StorageCopy | null = null;
    try {
      const raw = ask(natives, "GET", STORAGE_PATH);
      saved = raw ? JSON.parse(raw) as StorageCopy : null;
    } catch {
      saved = null;
    }
    restoreInto(local, saved?.local ?? null, setItem);
    restoreInto(session, saved?.session ?? null, setItem);
  }

  let last = "";
  const flush = (leaving: boolean) => {
    let body: string;
    try {
      body = JSON.stringify({ local: entriesOf(local), session: entriesOf(session) } satisfies StorageCopy);
    } catch {
      return;
    }
    if (body === last || !natives.fetch) return;
    last = body;
    natives.fetch(STORAGE_PATH, {
      method: "POST",
      headers: { [OWN_HEADER]: "1", "content-type": "application/json" },
      body,
      keepalive: leaving && body.length < KEEPALIVE_MAX,
      cache: "no-store",
    }).catch(() => { last = ""; });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer === null) timer = natives.setTimeout(() => { timer = null; flush(false); }, FLUSH_DELAY_MS);
  };
  const watch = (area: Storage) => {
    if (area === local || area === session) schedule();
  };

  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    watch(this);
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    watch(this);
  };
  proto.clear = function (this: Storage) {
    clear.call(this);
    watch(this);
  };

  // `localStorage.x = "1"` y `delete localStorage.x` no pasan por los métodos.
  let signature = `${signatureOf(local)}#${signatureOf(session)}`;
  natives.setInterval(() => {
    const now = `${signatureOf(local)}#${signatureOf(session)}`;
    if (now !== signature) {
      signature = now;
      schedule();
    }
  }, POLL_MS);
  window.addEventListener("pagehide", () => flush(true));
  // La primera copia le dice al proxy que esta página ya tiene su storage: desde ahí, en
  // esta ejecución de la app, no se repone nada más.
  schedule();
}

// ── Barras de scroll ────────────────────────────────────────────

/**
 * Una barra visible y que se puede agarrar, en la página y en sus contenedores.
 *
 * Con barras overlay (GNOME, macOS) la página no mostraba ninguna: una raya de dos píxeles
 * que aparecía solo al pasar el mouse por el borde. En Linux la app ya apaga las overlay
 * del motor entero (`src-tauri/src/app/rendering.rs`), que es lo que cubre a las páginas
 * con `scrollbar-width` propio; esto queda para una página sin estilos en un motor con
 * overlay (macOS). Va antes que cualquier CSS de la página, así que la que estiliza o
 * esconde sus barras (con `::-webkit-scrollbar` o con `scrollbar-width: none`) sigue
 * mandando.
 */
export const SCROLLBAR_CSS = [
  "::-webkit-scrollbar{width:12px;height:12px}",
  "::-webkit-scrollbar-track{background:transparent}",
  "::-webkit-scrollbar-thumb{background-color:rgba(128,128,128,.55);border:2px solid transparent;border-radius:8px;background-clip:content-box;min-height:40px;min-width:40px}",
  "::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.75)}",
  "::-webkit-scrollbar-corner{background:transparent}",
].join("");

export function installScrollbars(): void {
  try {
    const style = document.createElement("style");
    style.setAttribute("data-controlcode-scrollbars", "");
    style.textContent = SCROLLBAR_CSS;
    const parent = document.head ?? document.documentElement;
    parent.insertBefore(style, parent.firstChild);
  } catch {
    /* sin DOM todavía: la página se ve con las barras del motor */
  }
}
