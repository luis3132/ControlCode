/** Persistencia del estado de la ventana y sus tabs. Ver `database/queries/windows.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { PrelaunchStep } from "@/features/prelaunch/types";

/** Una tab tal como se persiste. Ver `database::TabStatePayload`. */
export interface TabStatePayload {
  id: string;
  title: string;
  titleIsCustom: boolean;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  tabOrder: number;
  sessionId: string | null;
  historyId: string | null;
  accountId: string | null;
  prelaunch: PrelaunchStep[];
  scrollback: string | null;
  openedAt: number;
}

export interface WindowStatePayload {
  label: string;
  workspaceId: string;
  posX: number | null;
  posY: number | null;
  width: number | null;
  height: number | null;
  monitor: string | null;
  tabs: TabStatePayload[];
  /**
   * Si esta foto de tabs es AUTORITATIVA — o sea, si la ventana ya cargó su estado y lo
   * que manda es realmente todo lo que tiene. Solo con `true` el backend interpreta que
   * una tab ausente es una tab cerrada (y la archiva y borra). Ver
   * `WindowStatePayload::authoritative` en Rust.
   */
  authoritative: boolean;
}

export const saveWindowState = (state: WindowStatePayload) =>
  invoke<void>("db_save_window_state", { state });

/** Fila de tab tal como la devuelve el backend al restaurar. Ver `database::TabRow`. */
export interface RestoredTabRow {
  id: string;
  title: string | null;
  titleIsCustom: boolean;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  sessionId: string | null;
  scrollback: string | null;
  historyId: string | null;
  accountId: string | null;
  prelaunch: PrelaunchStep[];
  openedAt: number;
}

export interface RestoredWindowState {
  window: { workspaceId: string };
  tabs: RestoredTabRow[];
}

/** Estado guardado de ESTA ventana, buscado por su label nativo. */
export const loadWindowState = (label: string) =>
  invoke<RestoredWindowState | null>("db_load_window_state", { label });

/**
 * Workspace de una ventana viva. Se consulta antes de aceptar que una tab se arrastre a
 * otra ventana: si no coinciden, el merge se rechaza para no mezclar workspaces.
 */
export const windowWorkspace = (label: string) =>
  invoke<string | null>("db_get_window_workspace", { label });
