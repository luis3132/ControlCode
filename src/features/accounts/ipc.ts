/**
 * Comandos de cuentas. Ver `accounts/commands.rs`.
 *
 * Como el resto de los `ipc.ts`, es el ÚNICO archivo de esta feature que habla con Tauri:
 * el nombre del comando y la forma de sus argumentos viven acá y en ningún otro lado. Un
 * `invoke("...")` suelto en un componente es un contrato con el backend escrito en un
 * string que nada verifica — y renombrar el comando en Rust no rompe nada hasta que el
 * usuario aprieta el botón.
 */
import { invoke } from "@tauri-apps/api/core";

import type { AccountCapableAgent, AgentAccount, CodexUsage } from "./types";

export const listAccounts = () => invoke<AgentAccount[]>("list_agent_accounts");

export const listCapableAgents = () => invoke<AccountCapableAgent[]>("account_capable_agents");

export const createAccount = (agentId: string, name: string) =>
  invoke<AgentAccount>("create_agent_account", { agentId, name });

export const deleteAccount = (id: string, deleteFiles: boolean) =>
  invoke<void>("delete_agent_account", { id, deleteFiles });

/** Variables con las que hay que lanzar un proceso para que corra con esta cuenta. */
export const accountEnv = (accountId: string) =>
  invoke<Record<string, string>>("agent_account_env", { accountId });

/**
 * El cupo de una cuenta de Codex. Sin `force` devuelve lo guardado (o uno vacío, con
 * `fetchedAt` 0); con `force` le pregunta al `app-server` de Codex, que no gasta cupo.
 */
export const codexAccountUsage = (accountId: string, force = true) =>
  invoke<CodexUsage>("codex_account_usage", { accountId, force });
