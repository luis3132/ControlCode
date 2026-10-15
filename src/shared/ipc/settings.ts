/** El key-value genérico de la app (tabla `settings`). Ver `database/queries/settings.rs`. */
import { invoke } from "@tauri-apps/api/core";

export const getSetting = (key: string) => invoke<string | null>("db_get_setting", { key });

export const setSetting = (key: string, value: string) =>
  invoke<void>("db_set_setting", { key, value });

export interface RenderingInfo {
  /** La ventana se compone por GPU. Falso solo si el usuario definió
   *  WEBKIT_DISABLE_COMPOSITING_MODE en Linux. */
  activeNow: boolean;
}

/** Cómo compone el WebView. Ver `app/rendering.rs`. */
export const renderingInfo = () => invoke<RenderingInfo>("rendering_info");
