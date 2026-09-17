/** El proxy de las tabs de navegador. Ver `src-tauri/src/preview`. */
import { invoke } from "@tauri-apps/api/core";

import type { NetBody, NetErrorKind, NetHeader } from "./protocol";

export interface PreviewTarget {
  /** Lo que va en el `src` del iframe. */
  proxiedUrl: string;
  proxyOrigin: string;
  targetOrigin: string;
}

export const previewResolve = (url: string, picker: string) =>
  invoke<PreviewTarget>("preview_resolve", { url, picker });

/** Servidores escuchando en los puertos típicos de desarrollo de esta máquina. */
export const previewDetectServers = () => invoke<string[]>("preview_detect_servers");

/** La foto del webview de la app entero, en PNG, a la resolución del motor. */
export async function previewCapture(): Promise<ArrayBuffer> {
  const png = await invoke<ArrayBuffer | number[]>("preview_capture");
  // Por el protocolo del IPC llega crudo; si Tauri tuvo que caer a `postMessage`, como lista.
  return png instanceof ArrayBuffer ? png : new Uint8Array(png).buffer;
}

/** Guarda una captura en la carpeta temporal y devuelve su ruta. Va cruda, no como JSON. */
export const previewSaveCapture = (png: Uint8Array, tag?: string) =>
  // `tag` va por cabecera y no en el cuerpo: el cuerpo es el PNG crudo. Termina en el
  // nombre del archivo, para que se vea de quién es la foto sin abrirla.
  invoke<string>("preview_save_capture", png, tag ? { headers: { "x-controlcode-tag": tag } } : undefined);

/** Un archivo del disco, listo para ponerlo en un `<input type=file>` de la página. */
export interface UploadFile {
  name: string;
  mime: string;
  /** base64 */
  data: string;
}

export const previewReadUpload = (path: string) => invoke<UploadFile>("preview_read_upload", { path });

/** Una respuesta simulada del servidor del proyecto (ver `src-tauri/src/preview/mocks.rs`). */
export interface Mock {
  id: string;
  method: string | null;
  /** Parte de la URL, con `*` como comodín. */
  url: string;
  status: number;
  body: string;
  contentType: string | null;
  delayMs: number;
  times: number | null;
  hits: number;
}

export const previewAddMock = (proxyOrigin: string, mock: Partial<Mock> & { url: string }) =>
  invoke<Mock>("preview_add_mock", { proxyOrigin, mock });

export const previewListMocks = (proxyOrigin: string) => invoke<Mock[]>("preview_list_mocks", { proxyOrigin });

export const previewClearMocks = (proxyOrigin: string, id?: string) =>
  invoke<number>("preview_clear_mocks", { proxyOrigin, id: id ?? null });

/** Un pedido que pasó por el proxy (ver `src-tauri/src/preview/log.rs`). */
export interface ProxyRequest {
  seq: number;
  /** Sube cuando la entrada cambia: un pedido pendiente vuelve a llegar al terminar. */
  rev: number;
  at: number;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  contentType: string | null;
  size: number | null;
  ttfbMs: number | null;
  durationMs: number;
  /** Sin esto y sin error, sigue en curso. */
  finished: boolean;
  error: string | null;
  errorKind: NetErrorKind | null;
  websocket: boolean;
}

/** Un pedido del proxy con sus cabeceras y cuerpos. */
export interface ProxyRequestDetail extends ProxyRequest {
  /** Como las recibió el servidor. */
  requestHeaders: NetHeader[];
  /** Como las mandó el servidor. */
  responseHeaders: NetHeader[];
  httpVersion: string | null;
  remoteAddress: string | null;
  requestBody: NetBody | null;
  responseBody: NetBody | null;
}

export interface ProxyNetworkPage {
  entries: ProxyRequest[];
  next: number;
  dropped: boolean;
}

export interface ServerCookie {
  name: string;
  value: string;
  path: string | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  expiresAt: number | null;
  url: string;
  at: number;
}

export interface CookieReport {
  set: ServerCookie[];
  sent: { url: string; at: number; cookies: { name: string; value: string }[] } | null;
}

export const previewNetwork = (proxyOrigin: string, since: number) =>
  invoke<ProxyNetworkPage>("preview_network", { proxyOrigin, since });

/** Cabeceras, cuerpos y tiempos de un pedido. `null` si el log ya no lo tiene. */
export const previewRequest = (proxyOrigin: string, seq: number) =>
  invoke<ProxyRequestDetail | null>("preview_request", { proxyOrigin, seq });

export const previewClearNetwork = (proxyOrigin: string) =>
  invoke<void>("preview_clear_network", { proxyOrigin });

export const previewCookies = (proxyOrigin: string) =>
  invoke<CookieReport>("preview_cookies", { proxyOrigin });
