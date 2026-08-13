/** `skillssh` es el directorio abierto de skills.sh, consultado por su CLI (`npx skills`). */
export type RegistrySourceType = "local" | "github" | "skillssh";

export interface RegistrySummary {
  id: string;
  name: string;
  sourceType: RegistrySourceType;
  location: string;
  priority: number;
  enabled: boolean;
  lastFetched: number | null;
  skillCount: number;
  error: string | null;
}

export interface MarketplaceSkillEntry {
  id: string;
  registryId: string;
  registryName: string;
  name: string;
  description: string | null;
  categories: string[];
  compatibleAgents: string[];
  folderPath: string;
  files: string[];
  /** Instalaciones acumuladas ya formateadas (`"3.3K"`); solo lo informa skills.sh. */
  installs: string | null;
}

/** Payload del evento `cc-registry-progress` (ver `marketplace/mod.rs`). */
export interface RegistryProgress {
  registryId: string;
  phase: "connecting" | "listing" | "scanning" | "saving" | "done" | "error";
  current: number;
  /** `null` mientras la fase no sea contable — la UI muestra spinner en vez de barra. */
  total: number | null;
  detail: string | null;
}
