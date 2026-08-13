/** El key-value genérico de la app (tabla `settings`). Ver `database/queries/settings.rs`. */
import { invoke } from "@tauri-apps/api/core";

export const getSetting = (key: string) => invoke<string | null>("db_get_setting", { key });

export const setSetting = (key: string, value: string) =>
  invoke<void>("db_set_setting", { key, value });
