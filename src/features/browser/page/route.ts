/**
 * Adónde tiene que ir de verdad un pedido o un enlace de la página.
 *
 * La página corre en el origen del proxy, no en el suyo (ver `src-tauri/src/preview/cors.rs`).
 * Sin esto, todo lo que no fuera una ruta relativa se salía del proxy: un `fetch` a su API
 * en otro puerto chocaba con CORS y perdía las cookies, y hasta uno a su propio servidor
 * por URL absoluta (`http://localhost:5173/api`) era, para el navegador, otro origen.
 *
 * - Al servidor de la página por URL absoluta → la misma ruta en el proxy.
 * - A cualquier otro origen http(s) → `FWD_PATH?url=…`, que el proxy reenvía como lo haría
 *   un navegador corriendo la página en su origen real, CORS y cookies incluidos.
 * - Lo demás (relativo, `data:`, `blob:`) → tal cual.
 */

/** Tiene que coincidir con `FWD_PATH` en `src-tauri/src/preview/cors.rs`. */
export const FWD_PATH = "/__controlcode__/fwd";
/** El modo de credenciales del pedido original. Coincide con `CRED_HEADER`. */
export const CRED_HEADER = "x-controlcode-cred";
/** Los nombres de las cabeceras que puso la página. Coincide con `HEADERS_HEADER`: lo que
 *  el motor agregue por su cuenta (la caché desactivada) no pide preflight. */
export const HEADERS_HEADER = "x-controlcode-headers";
/** En una respuesta que CORS no dejó pasar, el motivo. Coincide con `CORS_HEADER`. */
export const CORS_HEADER = "x-controlcode-cors";

export interface Routed {
  /** Adónde se manda. */
  url: string;
  /** Va por `FWD_PATH`: otro origen, con CORS. */
  forwarded: boolean;
  /** La URL que pidió la página, absoluta. */
  original: string;
}

/**
 * `null` = se deja como está. `pageHref` es la URL actual del documento (en el proxy),
 * `targetOrigin` el origen real de la página (`http://localhost:5173`).
 */
export function routeRequest(raw: string, pageHref: string, targetOrigin: string | null): Routed | null {
  let url: URL;
  try {
    url = new URL(raw, pageHref);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const proxyOrigin = new URL(pageHref).origin;
  if (url.origin === proxyOrigin) return null;
  if (targetOrigin && url.origin === targetOrigin) {
    return { url: `${proxyOrigin}${url.pathname}${url.search}${url.hash}`, forwarded: false, original: url.href };
  }
  // El fragmento no viaja al servidor.
  const bare = new URL(url.href);
  bare.hash = "";
  return {
    url: `${proxyOrigin}${FWD_PATH}?url=${encodeURIComponent(bare.href)}`,
    forwarded: true,
    original: url.href,
  };
}

/** El mensaje que un navegador pondría en la consola al bloquear un pedido por CORS. */
export function corsMessage(original: string, targetOrigin: string | null, reason: string): string {
  return `Access to ${original} from origin '${targetOrigin ?? "?"}' has been blocked by CORS policy: ${reason}`;
}
