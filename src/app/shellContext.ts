import { useOutletContext } from "react-router-dom";

import type { RepoGroup } from "@/features/workspaces/workspaceTree";

/**
 * Lo que el `AppShell` ya calculó y les pasa a sus páginas. El árbol de workspaces sale de
 * las tabs más una consulta a git por carpeta: rearmarlo en cada página repetiría esas
 * consultas.
 */
export interface ShellOutletContext {
  groups: RepoGroup[];
}

export function useShellGroups(): RepoGroup[] {
  return useOutletContext<ShellOutletContext | undefined>()?.groups ?? [];
}
