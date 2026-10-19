/**
 * Qué agentes están trabajando sin que se los vea: las tareas de la flota (que no tienen
 * ventana) y las tabs en modo chat que no están a la vista (otra tab, otra página del
 * canvas, otro workspace) con un turno corriendo.
 *
 * Solo lo que se sabe con certeza. Una tab de terminal no entra: desde afuera solo se ve
 * que su TUI escribe, y Claude Code redibuja la pantalla también esperando al usuario, así
 * que "escribió hace poco" avisaba de agentes que no estaban haciendo nada.
 *
 * Es lo que muestra la pila de la esquina (`BackgroundAgents`). Puro: recibe todo lo que
 * necesita y se prueba en Node.
 */
import type { TabChat } from "@/features/chat/store";
import { isActive } from "@/features/runs/fleetOrder";
import type { PendingApproval, Task } from "@/features/runs/types";
import type { Tab } from "@/features/tabs/types";

export interface BackgroundAgent {
  key: string;
  kind: "tab" | "task";
  id: string;
  agentId: string;
  command?: string;
  title: string;
  /** Qué está haciendo, si se sabe: su última herramienta, o lo último que dijo. */
  detail: string | null;
  /** `waiting` = pidió permiso y espera a alguien. */
  state: "working" | "waiting";
}

export interface BackgroundInput {
  tabs: Tab[];
  /** Las tabs que se ven ahora (sus ids). */
  visibleTabs: Set<string>;
  chats: Record<string, TabChat>;
  tasks: Task[];
  approvals: PendingApproval[];
  /** Las tareas que se ven ahora (en la consola de la flota no hace falta avisar). */
  fleetVisible: boolean;
  taskActivity: Record<string, string[]>;
}

/** La última herramienta del chat de una tab, o `null`. */
function lastTool(chat: TabChat | undefined): string | null {
  const items = chat?.chat.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "tool") return item.label || item.name;
  }
  return null;
}

export function backgroundAgents(input: BackgroundInput): BackgroundAgent[] {
  const out: BackgroundAgent[] = [];
  const tabApprovals = new Set(input.approvals.map((a) => a.tabId).filter((id): id is string => !!id));

  for (const tab of input.tabs) {
    if (input.visibleTabs.has(tab.id)) continue;
    const waiting = tabApprovals.has(tab.id);
    if (tab.mode === "html") {
      const chat = input.chats[tab.id];
      if (!waiting && !(chat?.running || chat?.starting)) continue;
      out.push({
        key: `tab:${tab.id}`, kind: "tab", id: tab.id, agentId: tab.agentId, command: tab.command, title: tab.title,
        detail: lastTool(chat), state: waiting ? "waiting" : "working",
      });
    }
  }

  if (!input.fleetVisible) {
    const blocked = new Set(input.approvals.map((a) => a.taskId).filter((id): id is string => !!id));
    for (const task of input.tasks) {
      if (!isActive(task.status) && !blocked.has(task.id)) continue;
      const lines = input.taskActivity[task.id];
      out.push({
        key: `task:${task.id}`, kind: "task", id: task.id, agentId: task.agentId, title: task.title,
        detail: lines?.[lines.length - 1] ?? null, state: blocked.has(task.id) ? "waiting" : "working",
      });
    }
  }

  // Los que esperan a alguien, primero: son los que no avanzan sin el usuario.
  return out.sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting"));
}
