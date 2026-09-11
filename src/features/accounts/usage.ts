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

/** Lo que la cuenta dice de sí misma, leído de su propia configuración. */
export interface PlanInfo {
  /** Identificador crudo del plan (`default_claude_max_20x`). */
  tier: string | null;
  email: string | null;
  extraUsageEnabled: boolean;
}

export interface AccountUsage {
  agentId: string;
  /** `false` = esta TUI no deja el dato en disco; se dice, no se muestran ceros. */
  available: boolean;
  windows: UsageWindow[];
  lastActivity: number | null;
  scannedFiles: number;
  plan: PlanInfo;
  /** Arranque de la ventana de 5 h en curso. `null` = no hay ninguna abierta. */
  windowStartedAt: number | null;
  windowResetsAt: number | null;
  /** Lo último que dijo el SERVIDOR sobre el reinicio, con la fecha en que lo dijo. */
  serverResetsAt: number | null;
  serverSeenAt: number | null;
}

/** Cuánto dura la ventana de límite de Claude, en segundos. */
export const WINDOW_SECS = 5 * 3600;

/**
 * El nombre del plan.
 *
 * Solo traduce los identificadores conocidos. Uno nuevo se muestra tal cual en vez de
 * caer en "desconocido": el identificador crudo dice más que una etiqueta vacía.
 */
export function planLabel(tier: string | null): string | null {
  if (!tier) return null;
  const known: Record<string, string> = {
    default_claude_max_20x: "Max 20×",
    default_claude_max_5x: "Max 5×",
    default_claude_pro: "Pro",
    default_claude_free: "Free",
    default_claude_team: "Team",
  };
  return known[tier] ?? tier;
}

/** `2 h 14 min`, `18 min`, `ahora`. Lo que falta para que se reabra la ventana. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "0 min";
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
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
