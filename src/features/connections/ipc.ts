/** Conexiones SSH a otras computadoras. Ver `src-tauri/src/ssh`. */
import { invoke } from "@tauri-apps/api/core";

import type { ConnectionCheck, SshConnection, SshConnectionDraft, TerminalLaunch } from "./types";

export const listConnections = () => invoke<SshConnection[]>("list_ssh_connections");

export const saveConnection = (draft: SshConnectionDraft) =>
  invoke<SshConnection>("save_ssh_connection", { draft });

export const deleteConnection = (id: string) => invoke<void>("delete_ssh_connection", { id });

/** Prueba lo que está escrito, guardado o no, igual que la van a usar los agentes. */
export const testConnection = (draft: SshConnectionDraft) =>
  invoke<ConnectionCheck>("test_ssh_connection", { draft });

/** El comando de una tab de terminal conectada a esa computadora. */
export const terminalCommand = (id: string) => invoke<TerminalLaunch>("ssh_terminal_command", { id });
