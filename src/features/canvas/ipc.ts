/** Las páginas del canvas en la base. Ver `database/queries/canvas.rs`. */
import { invoke } from "@tauri-apps/api/core";

export interface CanvasPageRow {
  id: string;
  workspace: string;
  name: string;
  position: number;
  /** JSON de sus nodos y su viewport (ver `pageData`). */
  data: string;
}

export const loadCanvasPages = (workspace: string) => invoke<CanvasPageRow[]>("canvas_pages_load", { workspace });

export const saveCanvasPage = (page: CanvasPageRow) => invoke<void>("canvas_page_save", { page });

export const deleteCanvasPage = (id: string) => invoke<void>("canvas_page_delete", { id });
