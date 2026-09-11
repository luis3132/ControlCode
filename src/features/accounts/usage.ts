import { invoke } from "@tauri-apps/api/core";

import type { AgentAccount } from "./types";

export interface UsageWindow {
  /** `5h`, `today` o `7d`. */
  key: string;
  inputTokens: number;
  outputTokens: number;
  /** Escritos a la caché de prompt: se cobran distinto que los de entrada. */
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messages: number;
  sessions: number;
}

export interface AccountUsage {
  agentId: string;
  /** `false` = esta TUI no deja el dato en disco; se dice, no se muestran ceros. */
  available: boolean;
  windows: UsageWindow[];
  lastActivity: number | null;
  scannedFiles: number;
}

/**
 * La cuenta PRINCIPAL de cada TUI instalada: la que se usa cuando no hay ningún perfil de
 * por medio. No tiene fila en la base — existía antes que esta app.
 */
export const systemAccounts = () => invoke<AgentAccount[]>("system_accounts");

/**
 * Consumo REAL, sumado de los transcripts que escribe la propia TUI.
 *
 * `accountId` en `null` = la cuenta principal. Es una lectura de disco que puede recorrer
 * bastantes archivos, así que se pide al abrir el panel y no al dibujar la barra.
 */
export const agentAccountUsage = (agentId: string, accountId: string | null) =>
  invoke<AccountUsage>("agent_account_usage", { agentId, accountId });

/** Todo lo que entró y salió, sin distinguir de dónde. */
export function totalOf(w: UsageWindow): number {
  return w.inputTokens + w.outputTokens + w.cacheWriteTokens + w.cacheReadTokens;
}

/** `1.2M`, `124k`, `840`. Para números que solo importan en orden de magnitud. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
