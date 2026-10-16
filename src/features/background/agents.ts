/**
 * Qué agentes están trabajando sin que se los vea: las tareas de la flota (que no tienen
 * ventana) y los agentes de las tabs que no están a la vista (otra tab, otra página del
 * canvas, otro workspace) pero siguen ocupados.
 *
 * Es lo que muestra la pila de la esquina (`BackgroundAgents`). Puro: recibe todo lo que
 * necesita y se prueba en Node.
 */
import type { TabChat } from "@/features/chat/store";
import { isActive } from "@/features/runs/fleetOrder";
import type { PendingApproval, Task } from "@/features/runs/types";
import type { Tab } from "@/features/tabs/types";
import type { PtyActivity } from "@/features/terminal/ipc";

/** Una terminal que escribió hace menos que esto está trabajando: una TUI ocupada redibuja
 *  su spinner sin parar, y esperando al usuario se queda quieta. */
export const BUSY_WITHIN_MS = 4000;

export interface BackgroundAgent {
  key: string;
  kind: "tab" | "task";
  id: string;
  agentId: string;
  command?: string;
  title: string;
  /** Qué está haciendo, si se sabe: el título de su TUI, su última herramienta. */
  detail: string | null;
  /** `waiting` = pidió permiso y espera a alguien. */
  state: "working" | "waiting";
}

export interface BackgroundInput {
  tabs: Tab[];
  /** Las tabs que se ven ahora (sus ids). */
  visibleTabs: Set<string>;
  activity: Record<number, PtyActivity>;
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
      continue;
    }
    // La terminal pelada no es un agente: que un `npm run dev` escriba no es que esté trabajando.
    if (tab.agentId === "bash" || tab.ptyId == null) continue;
    const act = input.activity[tab.ptyId];
    if (!act?.running || act.idleMs > BUSY_WITHIN_MS) continue;
    out.push({
      key: `tab:${tab.id}`, kind: "tab", id: tab.id, agentId: tab.agentId, command: tab.command, title: tab.title,
      detail: act.title && act.title !== tab.title ? act.title : null, state: "working",
    });
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
