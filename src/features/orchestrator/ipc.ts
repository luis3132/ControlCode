/** Comandos del modo orquestador. Ver `orchestrator/usage.rs` y `ipc/bridge.rs`. */
import { invoke } from "@tauri-apps/api/core";

/** Ver `orchestrator::Stats`. */
export interface OrchestratorStats {
  requests: number;
  responseBytes: number;
  estimatedTokens: number;
  lastCommand: string | null;
  lastAt: number | null;
  /** Tabs bajo observación ahora mismo. */
  watched: number;
  watchLimit: number;
}

export const orchestratorStats = () => invoke<OrchestratorStats>("orchestrator_stats");

export const resetOrchestratorUsage = () => invoke<void>("orchestrator_reset_usage");

/** Devuelve al backend el resultado de un comando de la CLI que solo el frontend sabe. */
export const respondToCli = (requestId: string, data: unknown, error: string | null) =>
  invoke<void>("cli_respond", { requestId, data, error });
