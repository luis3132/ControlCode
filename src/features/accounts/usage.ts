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

/**
 * Cuánto vale una consulta del cupo antes de volver a preguntar.
 *
 * Preguntar cuesta levantar la TUI entera: son segundos. Cinco minutos es corto para que
 * el número siga siendo representativo y largo para que abrir el panel tres veces seguidas
 * no levante tres procesos. La decisión vive acá y no en el backend porque el backend
 * devuelve lo guardado SIEMPRE —para que al abrir la app se vea al instante— y quien mira
 * la antigüedad para decidir si refrescar es la pantalla.
 */
export const USAGE_TTL = 5 * 60;

/**
 * ¿Sigue sirviendo lo que se guardó?
 *
 * Una diferencia negativa cuenta como vencida: un reloj corrido hacia atrás (NTP, volver de
 * suspensión) dejaría la entrada viva para siempre si solo se comparara contra el plazo.
 */
export function isUsageFresh(fetchedAt: number, now: number, ttl = USAGE_TTL): boolean {
  const age = now - fetchedAt;
  return age >= 0 && age < ttl;
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

/** Una de las barras del panel de `/usage`. */
export interface Meter {
  percent: number;
  /** Cuándo se reinicia, con el texto que muestra la TUI (incluye su zona horaria). */
  resets: string | null;
}

/** La semana de un modelo concreto, cuando el plan lo mide aparte. */
export interface ModelMeter {
  model: string;
  meter: Meter;
}

export interface LiveUsage {
  /** `false` = no se pudo preguntar; `problem` dice por qué. */
  available: boolean;
  session: Meter | null;
  week: Meter | null;
  weekModels: ModelMeter[];
  /** Cuándo se preguntó de verdad (epoch en segundos). */
  fetchedAt: number;
  /** `true` = salió de la caché, no se volvió a levantar la TUI. */
  cached: boolean;
  problem: string | null;
}

/**
 * El consumo del PLAN, preguntado en vivo a la propia TUI.
 *
 * Abre `claude` en una PTY y le manda `/usage`. Ese comando lo resuelve el cliente, no el
 * modelo, así que no gasta tokens — y evita adivinar endpoints internos, que es la otra
 * forma de conseguir el dato y la mala.
 *
 * En qué carpeta se abre no se decide desde acá: el backend usa siempre una carpeta vacía
 * de la app y la deja pre-aprobada en la configuración de esa cuenta, porque si la TUI
 * pregunta "¿confiás en esta carpeta?" nadie puede contestarle desde una PTY sin pantalla.
 */
export const claudeLiveUsage = (
  accountKey: string,
  env: Record<string, string>,
  force = false
) => invoke<LiveUsage>("claude_live_usage", { accountKey, env, force });

/**
 * La antigüedad de lo que se está mostrando, en piezas.
 *
 * Devuelve unidad y número en vez de texto armado: el texto lo pone i18n. Una función que
 * devuelve "hace 2 min" está escribiendo español a mano dentro de la lógica, y en inglés
 * se ve exactamente igual de mal.
 */
export function formatAgo(seconds: number): { unit: "now" | "min" | "h"; value: number } {
  if (seconds < 45) return { unit: "now", value: 0 };
  const mins = Math.round(seconds / 60);
  if (mins < 60) return { unit: "min", value: mins };
  return { unit: "h", value: Math.round(mins / 60) };
}
