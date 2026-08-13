import type { PrelaunchStep } from "@/features/prelaunch/types";

/** Skill tal como estaba activa en la tab al cerrarla (se congela en el historial). */
export interface ArchivedSkill {
  id: string;
  name: string;
  scope: "tab" | "workspace";
}

/** Dónde volver a bajar una skill que ya no está instalada. */
export interface SkillSource {
  registryId: string;
  registryName: string;
  marketplaceSkillId: string;
}

/** Estado actual de una de las skills que tenía una sesión archivada. */
export interface SessionSkillStatus {
  name: string;
  scope: "tab" | "workspace";
  /** `null` = ya no está instalada. */
  installedSkillId: string | null;
  /** Presente solo si falta Y algún repo habilitado la ofrece. */
  availableFrom: SkillSource | null;
}

/** Otra tab que estaba abierta en el workspace cuando esta sesión se cerró. */
export interface SiblingTab {
  title: string | null;
  agentLabel: string;
  cwd: string;
}

export interface SessionHistoryEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  agentLabel: string;
  command: string;
  cwd: string;
  title: string | null;
  sessionId: string | null;
  skills: ArchivedSkill[];
  siblingTabs: SiblingTab[];
  /** Cuenta de la TUI con la que corría; `null` = la principal (la del sistema). */
  accountId: string | null;
  /** Cadena de pre-lanzamiento con la que se abrió (ver el store `prelaunch`). */
  prelaunch: PrelaunchStep[];
  openedAt: number;
  closedAt: number;
}
