import type { PrelaunchStep } from "@/features/prelaunch/types";

export const DEFAULT_WORKSPACE_ID = "default";

export type AgentId = string;

export interface AgentInfo {
  id: AgentId;
  label: string;
  command: string;
  available: boolean;
  version?: string;
  isCustom?: boolean;
}

export interface Tab {
  id: string;
  title: string;
  titleIsCustom?: boolean;
  cwd: string;
  agentId: AgentId;
  agentLabel: string;
  command: string;
  ptyId: number | null;
  sessionId?: string;
  scrollback?: string;
  /** Entrada de `session_history` de la que salió esta tab (reabierta desde Sesiones).
   *  Es lo que hace que al volver a cerrarla se ACTUALICE esa entrada del historial en
   *  vez de crear una nueva. */
  historyId?: string;
  /** Cuenta (perfil) de la TUI con la que corre esta tab. Ausente = la del sistema.
   *  Se guarda el id y no las variables ya resueltas: si la cuenta se renombra o se muda
   *  de carpeta, la tab restaurada sigue apuntando a la cuenta correcta. */
  accountId?: string;
  /** Comandos que corren antes del agente (ver el store `prelaunch`). Se guardan las
   *  referencias a los presets y no su texto, así editar uno alcanza a las tabs guardadas. */
  prelaunch?: PrelaunchStep[];
  /** Unix seconds — cuándo se abrió esta tab por primera vez (no se toca en autosaves). */
  openedAt: number;
}
