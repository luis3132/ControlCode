/** Control remoto desde el teléfono. Ver `src-tauri/src/remote` y `docs/remote-protocol.md`. */
import { invoke } from "@tauri-apps/api/core";

import type { Pairing, RemoteConfig, RemoteDevice, RemoteStatus } from "./types";

export const getConfig = () => invoke<RemoteConfig>("remote_get_config");
export const saveConfig = (config: RemoteConfig) => invoke<void>("remote_save_config", { config });
export const getStatus = () => invoke<RemoteStatus>("remote_status");
export const startPairing = () => invoke<Pairing>("remote_start_pairing");
export const cancelPairing = () => invoke<void>("remote_cancel_pairing");
export const listDevices = () => invoke<RemoteDevice[]>("remote_devices");
export const removeDevice = (id: string) => invoke<void>("remote_remove_device", { id });
