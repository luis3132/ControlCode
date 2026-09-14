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
