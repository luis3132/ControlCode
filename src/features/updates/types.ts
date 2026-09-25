/** Actualizaciones desde las releases de GitHub. Ver `src-tauri/src/updates`. */

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  notes: string | null;
  pageUrl: string;
  publishedAt: string | null;
  /**
   * - `auto`: se baja, se verifica la firma y se instala desde la app.
   * - `download`: se ofrece el instalador de este sistema para bajarlo a mano.
   */
  install: "auto" | "download";
  /** El instalador para este sistema y arquitectura (para `download`). */
  downloadUrl: string | null;
  assetName: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}
