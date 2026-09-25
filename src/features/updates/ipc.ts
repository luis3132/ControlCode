/** Comandos de actualización. Ver `src-tauri/src/updates.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { UpdateInfo } from "./types";

export const updateCheck = () => invoke<UpdateInfo>("update_check");
/** Baja, verifica e instala. El progreso llega por el evento `cc-update-progress`. */
export const updateInstall = () => invoke<void>("update_install");
