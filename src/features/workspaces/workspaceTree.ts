/**
 * El árbol del panel izquierdo: repos → workspaces → agentes.
 *
 * No hay tabla nueva. Un workspace es una carpeta de trabajo con agentes adentro, y eso
 * ya se puede leer de las tabs abiertas más lo que git diga de cada `cwd`. Agrupar por
 * root de repo es lo que hace que dos worktrees del mismo proyecto queden juntos en vez
 * de aparecer como dos cosas sin relación.
 */
import type { Tab } from "@/features/tabs/types";
import type { RepoInfo } from "@/features/explorer/types";

export type AgentStatus = "starting" | "running";

export interface WorkspaceAgent {
  tabId: string;
  title: string;
  agentId: string;
  agentLabel: string;
  status: AgentStatus;
  isActive: boolean;
  openedAt: number;
}

export interface WorkspaceNode {
  /** El `cwd`: dos tabs en la misma carpeta son el mismo workspace. */
  key: string;
  cwd: string;
  /** La rama, que es lo que de verdad distingue dos copias del mismo repo. Sin repo,
   *  el nombre de la carpeta. */
  title: string;
  subtitle: string;
  /** El checkout principal del repo, no un worktree enlazado. */
  isPrimary: boolean;
  isWorktree: boolean;
  changedCount: number;
  agents: WorkspaceAgent[];
}

export interface RepoGroup {
  /** El root del repo, o el `cwd` cuando la carpeta no está en ninguno. */
  key: string;
  name: string;
  isRepo: boolean;
  workspaces: WorkspaceNode[];
  agentCount: number;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function agentOf(tab: Tab, activeTabId: string | null): WorkspaceAgent {
  return {
    tabId: tab.id,
    title: tab.title,
    agentId: tab.agentId,
    agentLabel: tab.agentLabel,
    // Sin PTY todavía = arrancando. Es lo único que se puede afirmar: si el agente está
    // esperando una respuesta no lo sabemos, y pintar "corriendo" cuando está bloqueado
    // sería peor que no decir nada.
    status: tab.ptyId == null ? "starting" : "running",
    isActive: tab.id === activeTabId,
    openedAt: tab.openedAt,
  };
}

/**
 * Arma el árbol.
 *
 * `repos` puede venir incompleto: resolver un `cwd` cuesta una llamada a git, y el panel
 * tiene que dibujarse antes de que todas vuelvan. Una carpeta sin resolver se muestra
 * como su propio grupo y se reacomoda sola cuando llega la respuesta.
 */
export function buildWorkspaceTree(
  tabs: Tab[],
  repos: Map<string, RepoInfo>,
  activeTabId: string | null
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();

  for (const tab of tabs) {
    const info = repos.get(tab.cwd);
    const root = info?.root ?? null;
    const groupKey = root ?? tab.cwd;

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        name: baseName(groupKey),
        isRepo: root !== null,
        workspaces: [],
        agentCount: 0,
      };
      groups.set(groupKey, group);
    }

    let ws = group.workspaces.find((w) => w.key === tab.cwd);
    if (!ws) {
      const folder = baseName(tab.cwd);
      const isWorktree = info?.isWorktree ?? false;
      ws = {
        key: tab.cwd,
        cwd: tab.cwd,
        title: info?.branch ?? folder,
        subtitle: isWorktree ? `worktree · ${folder}` : folder,
        isPrimary: root !== null && !isWorktree && tab.cwd === root,
        isWorktree,
        changedCount: info?.changedCount ?? 0,
        agents: [],
      };
      group.workspaces.push(ws);
    }

    ws.agents.push(agentOf(tab, activeTabId));
    group.agentCount += 1;
  }

  for (const group of groups.values()) {
    // El checkout principal primero: es donde se trabaja por defecto, y dejarlo mezclado
    // alfabéticamente entre worktrees lo esconde.
    group.workspaces.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    for (const ws of group.workspaces) {
      ws.agents.sort((a, b) => a.openedAt - b.openedAt);
    }
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Los `cwd` distintos que hay que resolver contra git. */
export function cwdsToResolve(tabs: Tab[], resolved: Map<string, RepoInfo>): string[] {
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!resolved.has(tab.cwd)) seen.add(tab.cwd);
  }
  return [...seen];
}

/** Cuántos agentes hay corriendo y cuántos arrancando, para el resumen del encabezado. */
export function fleetCounts(groups: RepoGroup[]): { running: number; starting: number } {
  let running = 0;
  let starting = 0;
  for (const g of groups) {
    for (const w of g.workspaces) {
      for (const a of w.agents) {
        if (a.status === "running") running += 1;
        else starting += 1;
      }
    }
  }
  return { running, starting };
}
