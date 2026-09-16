/**
 * Lo que se dicen la tab del navegador y el selector que vive adentro de la página.
 *
 * Son dos orígenes distintos (la app y el proxy del proyecto), así que no hay otra forma
 * de hablar que `postMessage`. Los tipos viven acá y los usan las dos puntas: el selector
 * los importa como `import type`, que desaparece al compilarlo, así que sigue siendo un
 * script autocontenido.
 */

/** Firma de los mensajes que manda la página. Cualquier otro `postMessage` se ignora. */
export type PageSource = "controlcode-preview";
/** Firma de los mensajes que manda la app. */
export type AppSource = "controlcode";

export interface PickedComponent {
  framework: "React" | "Vue" | "Svelte";
  name: string;
  /** `src/components/Login.tsx:42`, cuando el framework lo deja ver en desarrollo. */
  source?: string;
}

/** Un elemento marcado, con lo que un agente necesita para encontrarlo en el código. */
export interface PickedElement {
  /** URL de la página tal como la ve el iframe (la del proxy). */
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  component: PickedComponent | null;
}

export type PageMessage =
  | { source: PageSource; type: "nav"; payload: { url: string; title: string } }
  | { source: PageSource; type: "pick:selected"; payload: { element: PickedElement; keepPicking: boolean } }
  | { source: PageSource; type: "pick:cancel"; payload?: undefined }
  /** El runtime acaba de arrancar en un documento nuevo. Va antes de saber el origen de la
   *  app, así que no lleva nada más que el id: la app contesta `connect` y recién ahí la
   *  página empieza a mandar lo que capturó. */
  | { source: PageSource; type: "page:ready"; payload: { doc: string; url: string } }
  | { source: PageSource; type: "page:reply"; payload: PageReply }
  | { source: PageSource; type: "debug:batch"; payload: DebugBatch };

/** Lo que la app le pide a la página por su cuenta (el selector, la historia). */
export type SimpleAppMessage = {
  source: AppSource;
  type: "pick:on" | "pick:off" | "history:back" | "history:forward" | "hello" | "connect";
};

export type AppMessage =
  | SimpleAppMessage
  | { source: AppSource; type: "page:run"; id: string; command: PageCommand };

// ── Órdenes que se ejecutan adentro de la página ─────────────────

/**
 * Algo que hay que hacer o leer ADENTRO de la página, ejecutado por `page/runtime.ts`.
 *
 * Lo mandan tanto un agente (por el MCP) como el panel de debug: es el mismo canal a
 * propósito, así lo que ve el agente es exactamente lo que ve el usuario en el panel.
 *
 * `target` es un ref de `snapshot` (`e12`) o un selector CSS. Los refs son lo que conviene:
 * salen del último snapshot, así que el agente apunta a lo mismo que leyó.
 */
export type PageCommand =
  | { op: "snapshot"; all?: boolean }
  | { op: "click"; target: string }
  | { op: "hover"; target: string }
  | { op: "type"; target: string; text: string; clear?: boolean; submit?: boolean }
  | { op: "press"; key: string; target?: string }
  | { op: "select"; target: string; value: string }
  | { op: "scroll"; target?: string; dy?: number; to?: "top" | "bottom" }
  | { op: "wait"; text?: string; selector?: string; gone?: boolean; timeoutMs?: number }
  | { op: "eval"; code: string }
  | { op: "layout" }
  | { op: "storage"; action: "list" }
  | { op: "storage"; action: "set"; area: StorageArea; key: string; value: string }
  | { op: "storage"; action: "remove"; area: StorageArea; key: string }
  | { op: "storage"; action: "clear"; area: StorageArea }
  | { op: "cookies"; action: "list" }
  | { op: "cookies"; action: "set"; name: string; value: string; path?: string; maxAge?: number }
  | { op: "cookies"; action: "delete"; name: string; path?: string }
  | { op: "performance" }
  /** Todo lo que se sabe de un elemento: rol, nombre, componente que lo dibujó, dónde está
   *  y con qué estilos. Le asigna un ref (`u1`) que sobrevive a los snapshots. */
  | { op: "describe"; target: string };

export type PageOp = PageCommand["op"];

export type StorageArea = "local" | "session";

export type PageReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// ── Lo que la página va registrando para el panel de debug ───────

/**
 * Lo que se capturó desde la última tanda. Se manda agrupado y no de a uno: una página
 * que loguea en un bucle generaría miles de `postMessage` por segundo.
 */
export interface DebugBatch {
  /** Id de esta carga del documento. Cambia al navegar: es lo que separa una página de la
   *  siguiente en el log, que sobrevive a las recargas. */
  doc: string;
  url: string;
  console: ConsoleEntry[];
  network: PageNetworkEntry[];
}

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export interface ConsoleEntry {
  at: number;
  level: ConsoleLevel;
  /**
   * `console`: lo que la página logueó. `exception`/`rejection`: un error que nadie atrapó.
   * `resource`: un `<script>`, `<img>` o `<link>` que no cargó. `input`/`result`: lo que
   * alguien evaluó desde el panel y lo que devolvió.
   */
  kind: "console" | "exception" | "rejection" | "resource" | "input" | "result";
  text: string;
  /** `archivo:línea:columna`, si se sabe. */
  source?: string;
  stack?: string;
}

/**
 * Por qué falló un pedido. Los del proxy saben la causa (`connectionRefused`, `dns`…); la
 * página solo ve que no hubo respuesta (`network`), que puede ser la red, el servidor
 * apagado o CORS: el navegador no le deja distinguirlo a propósito.
 */
export type NetErrorKind =
  | "connectionRefused" | "connectionReset" | "timeout" | "dns" | "tls" | "protocol" | "body" | "aborted"
  | "network" | "other";

/** Una cabecera. `note`: lo que la vista previa le hizo en el camino (solo las del proxy). */
export interface NetHeader {
  name: string;
  value: string;
  note?: "rewritten" | "removed" | null;
}

/** Un cuerpo guardado para mostrar. */
export interface NetBody {
  /** Bytes en total, si se saben: lo guardado puede ser menos. */
  size: number | null;
  /** El contenido, si es texto. */
  text?: string | null;
  /** El contenido si es binario (una imagen). */
  base64?: string | null;
  /** Se guardó solo el principio. */
  truncated: boolean;
  /** Se soltó para hacerle lugar a pedidos más nuevos. */
  evicted?: boolean;
  contentType?: string | null;
  /** `Content-Encoding` de un cuerpo comprimido, que no se puede leer tal cual. */
  encoding?: string | null;
  /** Lo que no es contenido que se pueda mostrar: un FormData con archivos, un stream. */
  summary?: string | null;
}

/**
 * Un pedido que vio la PÁGINA. Solo los de otro origen: los del propio servidor pasan por
 * el proxy, que los ve mejor (status exacto, el documento mismo, las cookies HttpOnly).
 */
export interface PageNetworkEntry {
  at: number;
  method: string;
  url: string;
  /** `null` = no llegó a haber respuesta (red caída, CORS) o el motor no la informa. */
  status: number | null;
  /** `fetch`, `xhr`, o el `initiatorType` del Resource Timing (`img`, `script`, `css`…). */
  type: string;
  durationMs: number | null;
  size: number | null;
  error?: string;
  errorKind?: NetErrorKind;
  statusText?: string | null;
  /** Hasta que llegaron las cabeceras de la respuesta. */
  ttfbMs?: number | null;
  requestHeaders?: NetHeader[];
  /** Solo las que el navegador le deja ver a la página: para otro origen, las que permite
   *  CORS (`Access-Control-Expose-Headers`). */
  responseHeaders?: NetHeader[];
  requestBody?: NetBody | null;
  responseBody?: NetBody | null;
  /** `basic`, `cors`, `opaque`… de un `fetch`. */
  responseType?: string | null;
  redirected?: boolean;
  /** Adónde terminó, si hubo redirecciones. */
  finalUrl?: string | null;
}

export function isPageMessage(data: unknown): data is PageMessage {
  return typeof data === "object" && data !== null
    && (data as { source?: unknown }).source === ("controlcode-preview" satisfies PageSource);
}
