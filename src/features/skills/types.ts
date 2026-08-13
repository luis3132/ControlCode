export interface SkillUsageEntry {
  workspaceId: string;
  workspaceName: string;
  scope: "workspace" | "tab";
  tabId?: string | null;
  tabTitle?: string | null;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string | null;
  version: string;
  categories: string[];
  compatibleAgents: string[];
  compatibleVersions: Record<string, string>;
  author: string | null;
  license: string | null;
  homepage: string | null;
  sourcePath: string;
  /** Repo del que salió. `null` = instalada a mano desde un archivo local. */
  registryId: string | null;
  /** Entrada del repositorio de la que salió. Con `registryId` identifica el origen de
   *  forma exacta: el NOMBRE no identifica nada — dos skills homónimas pueden ser de
   *  autores distintos, incluso dentro del mismo repositorio. */
  originSkillId: string | null;
  /** Nombre del repo al momento de instalar — se guarda desnormalizado, así el badge
   *  sigue diciendo de dónde vino aunque después borres ese repositorio. */
  registryName: string | null;
  installedAt: number;
  updatedAt: number;
  usedBy: SkillUsageEntry[];
}

export interface SymlinkHealthEntry {
  /** Qué skill exactamente: el nombre no alcanza para volver a encontrarla. */
  skillId: string;
  skillName: string;
  tabId: string;
  tabTitle: string | null;
  linkPath: string;
  issue: "missing" | "broken" | "stale_target";
}

/** Metadata editable de un SKILL.md, tal como cruza el límite de Tauri (camelCase). */
export interface SkillFrontmatterInput {
  name: string | null;
  description: string | null;
  version: string | null;
  categories: string[];
  compatibleAgents: string[];
  compatibleVersions: Record<string, string>;
  author: string | null;
  license: string | null;
  homepage: string | null;
}

export interface SkillPreview {
  meta: SkillFrontmatterInput;
  folderName: string;
  /** Campos sugeridos que no vinieron en el frontmatter — completarlos es opcional. */
  missing: string[];
}
