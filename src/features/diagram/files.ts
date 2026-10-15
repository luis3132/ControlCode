/** Escribir archivos nuevos o binarios (un diagrama recién creado, un PNG, un PDF), creando
 *  las carpetas que falten. Ver `explorer_write_bytes`. */
import { invoke } from "@tauri-apps/api/core";

export const writeNewFile = (path: string, content: { text: string } | { base64: string }) =>
  invoke<number>("explorer_write_bytes", { path, text: "text" in content ? content.text : null, base64: "base64" in content ? content.base64 : null });

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
