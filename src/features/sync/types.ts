/** La sincronización por repo privado. Ver `src-tauri/src/sync`. */

export interface SyncReport {
  at: number;
  /** Si se subió algo al repo. */
  pushed: boolean;
  /** Lo que cambió en esta máquina. */
  changes: string[];
  /** Lo que cambiaron dos máquinas a la vez; quedó la versión que ganó. */
  conflicts: string[];
  /** Lo que no se pudo aplicar acá: queda pendiente para la próxima. */
  failures: string[];
  /** Primera sincronización de esta máquina con ese repo. */
  first: boolean;
}

export interface SyncStatus {
  configured: boolean;
  accountId: string | null;
  repo: string | null;
  webUrl: string | null;
  auto: boolean;
  last: SyncReport | null;
}

export interface SyncResult {
  report: SyncReport;
  /** Las preferencias del webview ya mezcladas, para aplicar acá. */
  prefs: Record<string, string>;
}
