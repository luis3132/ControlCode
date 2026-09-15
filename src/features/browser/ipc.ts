/** El proxy de las tabs de navegador. Ver `src-tauri/src/preview`. */
import { invoke } from "@tauri-apps/api/core";

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

/** Un pedido que pasó por el proxy (ver `src-tauri/src/preview/log.rs`). */
export interface ProxyRequest {
  seq: number;
  at: number;
  method: string;
  url: string;
  status: number | null;
  contentType: string | null;
  size: number | null;
  durationMs: number;
  error: string | null;
  websocket: boolean;
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

export const previewClearNetwork = (proxyOrigin: string) =>
  invoke<void>("preview_clear_network", { proxyOrigin });

export const previewCookies = (proxyOrigin: string) =>
  invoke<CookieReport>("preview_cookies", { proxyOrigin });
