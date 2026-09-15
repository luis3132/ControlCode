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
export const previewSaveCapture = (png: Uint8Array) => invoke<string>("preview_save_capture", png);

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
