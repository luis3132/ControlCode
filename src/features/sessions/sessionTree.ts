/**
 * El árbol de Sesiones: repos → workspaces → sesiones cerradas.
 *
 * Es deliberadamente la misma forma que `workspaceTree.ts`, porque es la misma cosa vista
 * en otro momento: el panel muestra las carpetas con agentes VIVOS, y esto muestra las
 * carpetas con agentes que ya se cerraron. Que las dos se lean igual es el punto — si
 * Sesiones agrupara de otra manera, el usuario tendría que aprender dos mapas del mismo
 * territorio.
 *
 * La diferencia está en el ORDEN. El panel ordena alfabéticamente, porque ahí se busca una
 * carpeta que sabés que está abierta. Acá se ordena por lo más reciente: al volver a
 * Sesiones lo que se busca casi siempre es lo último que cerraste.
 */
import type { RepoInfo } from "@/features/explorer/types";
import { baseName } from "@/features/workspaces/workspaceTree";

import type { SessionHistoryEntry } from "./types";

export interface SessionWorkspaceNode {
  /** El `cwd`: dos sesiones de la misma carpeta son el mismo workspace. */
  key: string;
  cwd: string;
  /** La rama, que es lo que de verdad distingue dos copias del mismo repo. Sin repo, el
   *  nombre de la carpeta. */
  title: string;
  subtitle: string;
  /** El checkout principal del repo, no un worktree enlazado. */
  isPrimary: boolean;
  isWorktree: boolean;
  sessions: SessionHistoryEntry[];
  /** El cierre más reciente del grupo, que es por lo que se ordena. */
  lastClosedAt: number;
}

export interface SessionRepoGroup {
  /** El root del repo, o el `cwd` cuando la carpeta no está en ninguno. */
  key: string;
  name: string;
  isRepo: boolean;
  workspaces: SessionWorkspaceNode[];
  sessionCount: number;
  lastClosedAt: number;
}

/**
 * Arma el árbol.
 *
 * `repos` puede venir incompleto: resolver un `cwd` cuesta una llamada a git y la página
 * tiene que dibujarse antes de que todas vuelvan. Una carpeta sin resolver se muestra como
 * su propio grupo y se reacomoda sola cuando llega la respuesta — igual que el panel.
 */
export function buildSessionTree(
  entries: SessionHistoryEntry[],
  repos: Map<string, RepoInfo>
): SessionRepoGroup[] {
  const groups = new Map<string, SessionRepoGroup>();

  for (const entry of entries) {
    const info = repos.get(entry.cwd);
    const root = info?.root ?? null;
    const groupKey = root ?? entry.cwd;

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        name: baseName(groupKey),
        isRepo: root !== null,
        workspaces: [],
        sessionCount: 0,
        lastClosedAt: 0,
      };
      groups.set(groupKey, group);
    }

    let ws = group.workspaces.find((w) => w.key === entry.cwd);
    if (!ws) {
      const folder = baseName(entry.cwd);
      const isWorktree = info?.isWorktree ?? false;
      ws = {
        key: entry.cwd,
        cwd: entry.cwd,
        title: info?.branch ?? folder,
        subtitle: isWorktree ? `worktree · ${folder}` : folder,
        isPrimary: root !== null && !isWorktree && entry.cwd === root,
        isWorktree,
        sessions: [],
        lastClosedAt: 0,
      };
      group.workspaces.push(ws);
    }

    ws.sessions.push(entry);
    ws.lastClosedAt = Math.max(ws.lastClosedAt, entry.closedAt);
    group.sessionCount += 1;
    group.lastClosedAt = Math.max(group.lastClosedAt, entry.closedAt);
  }

  for (const group of groups.values()) {
    for (const ws of group.workspaces) {
      ws.sessions.sort((a, b) => b.closedAt - a.closedAt);
    }
    // Dentro del repo manda la actividad, no el checkout principal: en el panel el
    // principal va primero porque es donde vas a trabajar, pero un historial se lee por
    // cuándo pasaron las cosas.
    group.workspaces.sort((a, b) => b.lastClosedAt - a.lastClosedAt);
  }

  return [...groups.values()].sort((a, b) => b.lastClosedAt - a.lastClosedAt);
}

/** El orden en el que se recorren las sesiones con las flechas: el mismo en el que se
 *  dibujan, saltando los encabezados de repo y de carpeta. */
export function flatSessionOrder(groups: SessionRepoGroup[]): SessionHistoryEntry[] {
  return groups.flatMap((g) => g.workspaces.flatMap((w) => w.sessions));
}
