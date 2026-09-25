/** Comandos de la sincronización. Ver `src-tauri/src/sync/commands.rs`. */
import { invoke } from "@tauri-apps/api/core";

import type { SyncResult, SyncStatus } from "./types";

export const syncStatus = () => invoke<SyncStatus>("sync_status");
/** Usa `nombre` en la cuenta si ya existe (privado) o lo crea privado. */
export const syncSetup = (accountId: string, name: string) => invoke<SyncStatus>("sync_setup", { accountId, name });
export const syncNow = (prefs: Record<string, string>) => invoke<SyncResult>("sync_now", { prefs });
export const syncDisconnect = () => invoke<void>("sync_disconnect");
export const syncSetAuto = (auto: boolean) => invoke<void>("sync_set_auto", { auto });
