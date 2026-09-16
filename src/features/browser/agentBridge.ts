/**
 * Lo que un agente le pide al navegador de las tabs, por el MCP (`ccode mcp`) y el puente
 * de la CLI (`browser.run` en `cliBridge.ts`).
 *
 * Cada tab de navegador montada se registra acá con un `BrowserHost`: lo mínimo para que
 * un agente la maneje. Un pedido llega con la carpeta del proyecto y se atiende con el
 * navegador de esa carpeta — el que se está mirando, o el último que usó un agente —, y
 * si no hay ninguno y lo que pide es abrir una URL, se abre uno.
 *
 * Todo lo que devuelve es TEXTO para un modelo: corto, una cosa por línea, y con lo que
 * pasó en la consola y la red durante la acción, que es lo que un agente probando una
 * página necesita ver sin tener que preguntarlo aparte.
 */
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath, type BrowserView, type ViewOwner } from "@/features/tabs/viewTabs";

import {
  consoleForAgent, isFailed, mergeCookies, networkForAgent, requestRows, type CookieRow,
} from "./debugLog";
import { debugLogOf, refreshProxyLog } from "./debugStore";
import {
  previewAddMock, previewClearMocks, previewCookies, previewListMocks, previewReadUpload, previewRequest, type Mock,
} from "./ipc";
import { detailForAgent, detailFromPage, detailFromProxy } from "./networkDetail";
import type { AnnotatedCapture } from "./composeMessage";
import { formatElement, formatMarked, type DescribedElement, type MarkedEntry } from "./markedView";
import type { PageChannel } from "./pageChannel";
import type { PageCommand, PickedElement, StorageArea } from "./protocol";
import { clampViewport, presetById, VIEWPORT_PRESETS, type Viewport } from "./viewport";

export interface BrowserHost {
  viewId: string;
  cwd: string;
  channel: PageChannel;
  /** Carga una URL. Resuelve cuando se pidió, no cuando terminó de cargar. */
  navigate: (url: string) => Promise<void>;
  history: (action: "back" | "forward" | "reload") => void;
  /** `null` = ocupar todo el espacio (sin emular un tamaño). */
  setViewport: (viewport: Viewport | null) => void;
  viewport: () => Viewport | null;
  proxyOrigin: () => string | null;
  /** El origen del servidor de verdad (`http://localhost:5173`). */
  targetOrigin: () => string | null;
  /** La URL que muestra la barra (la del servidor, no la del proxy). */
  currentUrl: () => string;
  /** Cuántas veces cargó un documento con el runtime. Sirve de marca para `waitForLoad`. */
  loadCount: () => number;
  /** Espera a que cargue un documento posterior a `after`. `false` si venció el tope. */
  waitForLoad: (after: number, timeoutMs: number) => Promise<boolean>;
  /** Lo que la persona dejó señalado y todavía no mandó a nadie. */
  marks: () => { picks: PickedElement[]; captures: AnnotatedCapture[]; note: string };
  /** Prende el selector y espera a que la persona marque algo. `null` = canceló o venció. */
  requestPick: (timeoutMs: number) => Promise<PickedElement | null>;
  /** Una foto de la página como se ve ahora, guardada en disco. Devuelve la ruta. */
  screenshot: () => Promise<string>;
}

export type BrowserRequest = { op: string } & Record<string, unknown>;

const hosts = new Map<string, BrowserHost>();
/** El último navegador que usó un agente, por carpeta: si hay dos abiertos, sigue en el mismo. */
const lastUsed = new Map<string, string>();
/** En qué página lo dejó. Si el usuario cierra la tab del agente, es con lo que vuelve a
 *  abrirla donde estaba en vez de contestarle "no tenés ningún navegador". */
const lastUrl = new Map<string, string>();
const hostWaiters = new Set<() => void>();

export function registerBrowserHost(host: BrowserHost): () => void {
  hosts.set(host.viewId, host);
  for (const wake of hostWaiters) wake();
  return () => {
    if (hosts.get(host.viewId) === host) hosts.delete(host.viewId);
  };
}

function waitForHost(viewId: string, timeoutMs: number): Promise<BrowserHost> {
  const ready = hosts.get(viewId);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const wake = () => {
      const host = hosts.get(viewId);
      if (!host) return;
      cleanup();
      resolve(host);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("La tab del navegador no terminó de montarse."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      hostWaiters.delete(wake);
    };
    hostWaiters.add(wake);
  });
}

const sameFolder = (a: string, b: string) =>
  comparablePath(a).replace(/\/+$/, "") === comparablePath(b).replace(/\/+$/, "");

/**
 * El navegador de este agente, abriéndole uno propio si todavía no tiene.
 *
 * Cada agente trabaja en SU tab y no en la que el usuario está mirando: dos agentes sobre
 * el mismo proyecto se pisarían la página, y el usuario perdería lo que tenía abierto cada
 * vez que uno navegara. La tab del agente se pinta de su color (ver `agentPaint`), igual
 * que la suya, para que se vea de quién es sin abrirla.
 */
async function hostFor(
  cwd: string,
  request: BrowserRequest,
  owner: ViewOwner | null
): Promise<{ host: BrowserHost; opened: boolean }> {
  const store = useViewTabsStore.getState();
  const inFolder = store.views.filter((v): v is BrowserView => v.kind === "browser" && sameFolder(v.cwd, cwd));
  // `pick` y `marked` no son sobre la página del agente sino sobre la ATENCIÓN del usuario:
  // lo que marcó lo marcó en la tab que estaba mirando, que es la suya. Mandarlos a la del
  // agente devolvería siempre "no marcaste nada".
  const ofUser = request.op === "pick" || request.op === "marked";
  // Sin saber quién pide (un agente viejo, sin el dato), se sigue usando el de siempre.
  const browsers = owner && !ofUser ? inFolder.filter((v) => v.owner?.id === owner.id) : inFolder;
  const slot = `${owner && !ofUser ? owner.id : "user"}\u0000${comparablePath(cwd)}`;

  if (browsers.length === 0) {
    // La tab del agente es suya y no se cierra sola; pero el usuario puede cerrarla, y
    // entonces se vuelve a abrir donde estaba. Su trabajo no se pierde por eso.
    const asked = typeof request.url === "string" ? request.url : "";
    const url = request.op === "navigate" ? asked : lastUrl.get(slot) ?? "";
    if (!url) {
      throw new Error(
        owner && !ofUser
          ? "Todavía no tenés un navegador abierto en este proyecto. Abrí uno con browser_navigate y la URL del proyecto."
          : `No hay ningún navegador abierto para ${cwd}. Usá browser_navigate con la URL del proyecto para abrir uno.`
      );
    }
    // Sin robarle el foco a quien está escribiendo en la terminal: la tab aparece en la
    // barra y el agente la usa igual.
    const id = store.openBrowser(cwd, url, { activate: false, owner: owner ?? undefined });
    lastUsed.set(slot, id);
    lastUrl.set(slot, url);
    // `opened` solo si el pedido ERA navegar: si se reabrió para otra cosa, la página
    // todavía tiene que cargar y `runBrowserRequest` la espera.
    return { host: await waitForHost(id, 10_000), opened: request.op === "navigate" };
  }

  const active = browsers.find((v) => v.id === store.activeViewId);
  const remembered = browsers.find((v) => v.id === lastUsed.get(slot));
  // Para el agente manda LO SUYO, no lo que el usuario tenga activo: si el usuario abre su
  // propia tab del proyecto, el agente no debería empezar a escribir ahí.
  const view = (owner && !ofUser ? remembered ?? active : active ?? remembered) ?? browsers[browsers.length - 1];
  lastUsed.set(slot, view.id);
  // Lo que tenga cargado AHORA, haya navegado el agente o el usuario: los dos usan esta
  // página, y al reabrirla tiene que volver a la última.
  if (view.url) lastUrl.set(slot, view.url);
  // Una tab restaurada que nadie miró todavía no está montada: no tiene página.
  store.keepMounted(view.id);
  return { host: await waitForHost(view.id, 10_000), opened: false };
}

const str = (r: BrowserRequest, key: string) => (typeof r[key] === "string" ? (r[key] as string) : undefined);
const num = (r: BrowserRequest, key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : undefined);
const bool = (r: BrowserRequest, key: string) => r[key] === true;

function required(r: BrowserRequest, key: string): string {
  const value = str(r, key);
  if (value === undefined || value === "") throw new Error(`Falta '${key}'.`);
  return value;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Lo que la página logueó como error o aviso y lo que falló en la red mientras duraba una
 * acción. Es lo que convierte "hice click" en "hice click y la API devolvió 500".
 */
async function sideEffects(host: BrowserHost, firstId: number, startedAt: number): Promise<string> {
  // El runtime manda la tanda enseguida después de contestar; se le da un momento para
  // que llegue, y al proxy para anotar lo que la acción disparó.
  await sleep(150);
  const origin = host.proxyOrigin();
  if (origin) await refreshProxyLog(host.viewId, origin).catch(() => undefined);
  const log = debugLogOf(host.viewId);
  const logged = log.console
    .filter((e) => e.id >= firstId && (e.level === "error" || e.level === "warn"))
    .slice(-10)
    .map((e) => `  ${e.level.toUpperCase()} ${e.kind === "exception" ? "Uncaught " : ""}${e.text}${e.source ? `  (${e.source})` : ""}`);
  const failed = requestRows(log)
    // Sin margen hacia atrás: un pedido que disparó la acción empezó (y el proxy lo anotó)
    // después de que empezara; uno de la carga anterior, aunque sea de 20 ms antes, no es suyo.
    .filter((r) => r.at >= startedAt && isFailed(r))
    .slice(-10)
    .map((r) => `  ${r.method} ${r.error ? "ERR" : r.status} ${r.url}${r.error ? ` — ${r.error}` : ""}`);
  const parts: string[] = [];
  if (logged.length) parts.push(`Consola durante la acción:\n${logged.join("\n")}`);
  if (failed.length) parts.push(`Pedidos que fallaron durante la acción:\n${failed.join("\n")}`);
  return parts.length ? inServerTerms(host, `\n\n${parts.join("\n\n")}`) : "";
}

function cookieTable(rows: CookieRow[]): string {
  if (rows.length === 0) return "(sin cookies)";
  return rows.map((c) => {
    const flags = [
      c.httpOnly === true ? "HttpOnly" : null,
      c.secure ? "Secure" : null,
      c.sameSite ? `SameSite=${c.sameSite}` : null,
      c.path ? `Path=${c.path}` : null,
      c.expiresAt ? `vence ${new Date(c.expiresAt * 1000).toISOString()}` : "de sesión",
      c.sent ? "se manda al servidor" : "NO se mandó en el último pedido",
      c.visibleToPage ? null : "invisible para JS",
    ].filter(Boolean).join(" · ");
    const value = c.value.length > 120 ? `${c.value.slice(0, 120)}…` : c.value;
    return `${c.name}=${value}\n  ${flags}`;
  }).join("\n");
}

/** Los tiempos de cada orden de página. `wait` y `eval` pueden tardar lo que pidan. */
function timeoutFor(command: PageCommand): number {
  if (command.op === "wait") return Math.min(command.timeoutMs ?? 5000, 15_000) + 3000;
  if (command.op === "eval") return 30_000;
  return 12_000;
}

/** Lo que viene de la página habla en URLs del proxy (`localhost:41234`); el agente las
 *  busca y las escribe en términos del servidor que conoce (`localhost:5173`). */
/** El detalle de un pedido por su id del listado (`p12` si pasó por el proxy, `g5` si lo vio la página). */
async function requestDetailText(host: BrowserHost, id: string): Promise<string> {
  const log = debugLogOf(host.viewId);
  if (id.startsWith("g")) {
    const entry = log.requests.find((e) => `g${e.id}` === id);
    if (!entry) throw new Error(`No hay ningún pedido ${id}: pedí el listado de nuevo.`);
    return detailForAgent(detailFromPage(entry));
  }
  const origin = host.proxyOrigin();
  const seq = Number(id.replace(/^p/, ""));
  if (!origin || !Number.isInteger(seq)) throw new Error(`'${id}' no es un id del listado (son como p12 o g5).`);
  const detail = await previewRequest(origin, seq);
  if (!detail) throw new Error(`El pedido ${id} ya no está en el registro del proxy.`);
  return detailForAgent(detailFromProxy(detail));
}

function inServerTerms(host: BrowserHost, text: string): string {
  const proxy = host.proxyOrigin();
  const target = host.targetOrigin();
  return proxy && target ? text.split(proxy).join(target) : text;
}

async function inPage(host: BrowserHost, command: PageCommand, withEffects: boolean): Promise<string> {
  const firstId = debugLogOf(host.viewId).nextId;
  const startedAt = Date.now();
  const result = await host.channel.run(command, timeoutFor(command));
  return inServerTerms(host, asText(result)) + (withEffects ? await sideEffects(host, firstId, startedAt) : "");
}

/**
 * Lo señalado, descrito como está AHORA en la página.
 *
 * Se vuelve a describir en vez de mandar lo que se guardó al marcarlo: entre que la
 * persona lo marcó y el agente lo lee pudo cambiar de estado, taparse o desaparecer, y eso
 * es justamente lo que el agente necesita saber.
 */
async function marksText(
  host: BrowserHost,
  picks: PickedElement[],
  captures: AnnotatedCapture[],
  note: string,
  /** Con qué apuntarle al runtime. `pick` = lo que la persona acaba de marcar, que se
   *  resuelve por identidad; el resto se busca por su selector. */
  pointer?: string
): Promise<string> {
  const entries: MarkedEntry[] = [];
  for (const pick of picks) {
    try {
      const described = await host.channel.run({ op: "describe", target: pointer ?? pick.selector }, 12_000) as DescribedElement;
      entries.push({ live: true, element: described });
    } catch {
      entries.push({ live: false, element: pick });
    }
  }
  const proxy = host.proxyOrigin();
  const target = host.targetOrigin();
  const display = (url: string) => (proxy && target && url.startsWith(proxy) ? target + url.slice(proxy.length) : url);
  return inServerTerms(host, formatMarked(entries, captures, note, display));
}

/** Las reglas simuladas, para que el agente sepa qué está fingiendo la página. */
function mocksText(mocks: Mock[]): string {
  if (mocks.length === 0) return "No hay ninguna respuesta simulada: el servidor del proyecto contesta todo.";
  const lines = mocks.map((m) => {
    const parts = [`${m.method ?? "cualquier método"} ${m.url} → ${m.status}`];
    if (m.delayMs > 0) parts.push(`${m.delayMs} ms de demora`);
    if (m.times !== null) parts.push(`${m.hits}/${m.times} usos`);
    else if (m.hits > 0) parts.push(`${m.hits} uso(s)`);
    return `- ${parts.join(" · ")}  [id=${m.id.slice(0, 8)}]`;
  });
  return `Respuestas simuladas activas:\n${lines.join("\n")}`;
}

async function execute(host: BrowserHost, request: BrowserRequest, opened: boolean): Promise<string> {
  const op = request.op;
  switch (op) {
    case "navigate": {
      const url = required(request, "url");
      const firstId = debugLogOf(host.viewId).nextId;
      const startedAt = Date.now();
      // Recién abierta, la tab ya está cargando esta misma URL: pedirla otra vez sería
      // cargarla dos veces.
      const mark = opened ? 0 : host.loadCount();
      if (!opened) await host.navigate(url);
      const loaded = await host.waitForLoad(mark, 20_000);
      const head = loaded
        ? `Cargó ${host.currentUrl()}`
        : `La página no avisó que cargó en 20 s (${host.currentUrl()}). Puede seguir cargando, o no pasar por el proxy de Control Code.`;
      return head + await sideEffects(host, firstId, startedAt);
    }
    case "history": {
      const action = required(request, "action");
      if (action !== "back" && action !== "forward" && action !== "reload") throw new Error("action es back, forward o reload.");
      const mark = host.loadCount();
      const before = host.currentUrl();
      host.history(action);
      // Atrás en una SPA no recarga el documento: se espera un poco y se informa dónde quedó.
      const loaded = await host.waitForLoad(mark, action === "reload" ? 20_000 : 1500);
      const url = host.currentUrl();
      return loaded || url !== before ? `Ahora en ${url}` : `Sigue en ${url} (no había a dónde ir, o la página no cambió).`;
    }
    case "resize": {
      if (bool(request, "reset")) {
        host.setViewport(null);
      } else {
        const preset = str(request, "preset");
        const fromPreset = preset ? presetById(preset) : undefined;
        if (preset && !fromPreset) {
          throw new Error(`No hay ningún preset '${preset}'. Hay: ${VIEWPORT_PRESETS.map((p) => `${p.id} (${p.width}×${p.height})`).join(", ")}`);
        }
        const width = num(request, "width") ?? fromPreset?.width;
        const height = num(request, "height") ?? fromPreset?.height ?? host.viewport()?.height ?? 900;
        if (width === undefined) throw new Error("Pasá width (y height), un preset, o reset.");
        host.setViewport(clampViewport({ width, height }));
      }
      // Que la página reciba el `resize` y reacomode antes de medirla.
      await sleep(400);
      return inPage(host, { op: "layout" }, false);
    }
    case "console": {
      const level = str(request, "level");
      const { text, next } = consoleForAgent(debugLogOf(host.viewId), {
        since: num(request, "since"),
        level: level === "errors" || level === "warnings" ? level : "all",
        limit: num(request, "limit"),
      });
      return `${inServerTerms(host, text)}\n\n[cursor: ${next} — pasá since=${next} para ver solo lo que llegue después]`;
    }
    case "network": {
      const origin = host.proxyOrigin();
      if (origin) await refreshProxyLog(host.viewId, origin);
      const wanted = str(request, "request");
      if (wanted) return inServerTerms(host, await requestDetailText(host, wanted.replace(/^\[|\]$/g, "")));
      const { text, next } = networkForAgent(requestRows(debugLogOf(host.viewId)), {
        since: num(request, "since"),
        failedOnly: bool(request, "failed_only"),
        limit: num(request, "limit"),
      });
      return `${inServerTerms(host, text)}\n\n[cursor: ${next} — pasá since=${next} para ver solo lo que llegue después; `
        + `request=<id entre corchetes> para ver cabeceras, cuerpos y tiempos de uno]`;
    }
    case "cookies": {
      const action = str(request, "action") ?? "list";
      if (action === "set") {
        await host.channel.run({
          op: "cookies", action: "set", name: required(request, "name"), value: str(request, "value") ?? "",
          path: str(request, "path"), maxAge: num(request, "max_age"),
        });
      } else if (action === "delete") {
        await host.channel.run({ op: "cookies", action: "delete", name: required(request, "name"), path: str(request, "path") });
      } else if (action !== "list") {
        throw new Error("action es list, set o delete.");
      }
      const page = await host.channel.run({ op: "cookies", action: "list" }) as { cookies: { name: string; value: string }[] };
      const origin = host.proxyOrigin();
      const report = origin ? await previewCookies(origin).catch(() => null) : null;
      return cookieTable(mergeCookies(page.cookies, report));
    }
    case "storage": {
      const action = str(request, "action") ?? "list";
      const area = str(request, "area");
      const storageArea = (): StorageArea => {
        if (area !== "local" && area !== "session") throw new Error("area es local o session.");
        return area;
      };
      if (action === "list") return inPage(host, { op: "storage", action: "list" }, false);
      if (action === "set") return inPage(host, { op: "storage", action: "set", area: storageArea(), key: required(request, "key"), value: str(request, "value") ?? "" }, true);
      if (action === "remove") return inPage(host, { op: "storage", action: "remove", area: storageArea(), key: required(request, "key") }, true);
      if (action === "clear") return inPage(host, { op: "storage", action: "clear", area: storageArea() }, true);
      throw new Error("action es list, set, remove o clear.");
    }
    case "pick": {
      const seconds = Math.min(Math.max(num(request, "timeout_s") ?? 120, 10), 600);
      const picked = await host.requestPick(seconds * 1000);
      if (!picked) {
        throw new Error("El usuario no marcó nada: canceló con Escape, o pasaron los segundos de espera.");
      }
      return marksText(host, [picked], [], "", "pick");
    }
    case "marked": {
      const { picks, captures, note } = host.marks();
      if (picks.length === 0 && captures.length === 0 && !note.trim()) {
        throw new Error(
          "El usuario todavía no marcó nada en el navegador. Pedíselo con browser_pick, o esperá a que use el botón Marcar."
        );
      }
      return marksText(host, picks, captures, note);
    }
    case "mock": {
      const origin = host.proxyOrigin();
      if (!origin) throw new Error("Todavía no hay ninguna página cargada, así que no hay servidor al que simularle respuestas.");
      const action = str(request, "action") ?? "add";
      if (action === "clear") {
        const gone = await previewClearMocks(origin, str(request, "id"));
        return gone > 0 ? `Borradas ${gone} regla(s).` : "No había reglas que borrar.";
      }
      if (action === "add") {
        await previewAddMock(origin, {
          url: required(request, "url"),
          method: str(request, "method")?.toUpperCase() ?? null,
          status: num(request, "status") ?? 200,
          body: str(request, "body") ?? "",
          contentType: str(request, "content_type") ?? null,
          delayMs: num(request, "delay_ms") ?? 0,
          times: num(request, "times") ?? null,
        });
      } else if (action !== "list") {
        throw new Error("action es add, list o clear.");
      }
      return mocksText(await previewListMocks(origin));
    }
    case "describe": {
      // Con el mismo formato que lo que marca la persona: un modelo lee mejor seis líneas
      // rotuladas que el JSON entero con sus llaves.
      const described = await host.channel.run(
        { op: "describe", target: required(request, "target") }, 12_000
      ) as DescribedElement;
      return inServerTerms(host, formatElement({ live: true, element: described }, 1, (url) => url));
    }
    case "screenshot": {
      const path = await host.screenshot();
      return `La página quedó fotografiada en:\n${path}\n\nAbrila con tus herramientas de archivos. Es lo que se ve ahora en la tab, no el documento entero.`;
    }
    case "drag":
      return inPage(host, { op: "drag", from: required(request, "from"), to: required(request, "to") }, true);
    case "upload": {
      const file = await previewReadUpload(required(request, "path"));
      return inPage(host, {
        op: "upload", target: required(request, "target"), name: file.name, mime: file.mime, data: file.data,
      }, true);
    }
    case "dialogs": {
      const action = str(request, "action");
      if (action && action !== "accept" && action !== "dismiss") throw new Error("action es accept o dismiss.");
      return inPage(host, {
        op: "dialogs",
        accept: action ? action === "accept" : undefined,
        text: str(request, "prompt_text"),
      }, false);
    }
    case "snapshot": return inPage(host, { op: "snapshot", all: bool(request, "full") }, false);
    case "layout": return inPage(host, { op: "layout" }, false);
    case "performance": return inPage(host, { op: "performance" }, false);
    case "click": return inPage(host, { op: "click", target: required(request, "target") }, true);
    case "hover": return inPage(host, { op: "hover", target: required(request, "target") }, true);
    case "type":
      return inPage(host, {
        op: "type", target: required(request, "target"), text: str(request, "text") ?? "",
        clear: bool(request, "clear"), submit: bool(request, "submit"),
      }, true);
    case "press": return inPage(host, { op: "press", key: required(request, "key"), target: str(request, "target") }, true);
    case "select": return inPage(host, { op: "select", target: required(request, "target"), value: required(request, "value") }, true);
    case "scroll":
      return inPage(host, {
        op: "scroll", target: str(request, "target"), dy: num(request, "dy"),
        to: str(request, "to") === "top" ? "top" : str(request, "to") === "bottom" ? "bottom" : undefined,
      }, false);
    case "wait":
      return inPage(host, {
        op: "wait", text: str(request, "text"), selector: str(request, "selector"),
        gone: bool(request, "gone"), idle: bool(request, "idle"), timeoutMs: num(request, "timeout_ms"),
      }, false);
    case "eval": return inPage(host, { op: "eval", code: required(request, "code") }, true);
    default:
      throw new Error(`El navegador no sabe hacer '${op}'.`);
  }
}

/** Atiende un pedido de un agente sobre su navegador del proyecto `cwd`. */
export async function runBrowserRequest(
  cwd: string,
  request: BrowserRequest,
  owner: ViewOwner | null = null
): Promise<string> {
  const { host, opened } = await hostFor(cwd, request, owner);
  // Una tab que se acaba de montar (restaurada, nunca mirada) todavía está cargando su
  // página: leerla ya diría "no hay página" cuando en un segundo la hay.
  if (request.op !== "navigate" && host.loadCount() === 0 && !(await host.waitForLoad(0, 15_000))) {
    throw new Error("El navegador de este proyecto no tiene ninguna página cargada. Usá browser_navigate con la URL del proyecto.");
  }
  return execute(host, request, opened);
}
