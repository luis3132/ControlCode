/** El key-value genérico de la app (tabla `settings`). Ver `database/queries/settings.rs`. */
import { invoke } from "@tauri-apps/api/core";

export const getSetting = (key: string) => invoke<string | null>("db_get_setting", { key });

export const setSetting = (key: string, value: string) =>
  invoke<void>("db_set_setting", { key, value });

export interface RenderingInfo {
  /** La opción existe solo en Linux. */
  applies: boolean;
  /** Lo guardado: vale desde el próximo arranque. */
  gpuCompositing: boolean;
  /** Lo que vale en esta ejecución. */
  activeNow: boolean;
  /** El usuario definió WEBKIT_DISABLE_COMPOSITING_MODE por su cuenta, y eso manda. */
  forcedByEnv: boolean;
}

/** Cómo compone el WebView. Ver `app/rendering.rs`. */
export const renderingInfo = () => invoke<RenderingInfo>("rendering_info");

/** La clave que lee el arranque en Rust (`GPU_COMPOSITING_KEY`). */
export const GPU_COMPOSITING_KEY = "render.gpu_compositing";
