/**
 * El estado de la flota en el frontend.
 *
 * Las filas son un reflejo de SQLite, al revés que las tabs: acá la fuente de verdad es la
 * base, porque el proceso lo lanza y lo espera Rust. Lo único que vive solo acá es la
 * **actividad viva** de cada tarjeta, que llega por evento y no se persiste: son las
 * últimas líneas de lo que el agente está haciendo, y el detalle completo ya quedó en el
 * `.jsonl` de la tarea.
 */
import { create } from "zustand";

import * as ipc from "./ipc";
import type { AgentEvent, PendingApproval, Task, TaskEventPayload } from "./types";

/** Cuántas líneas de actividad conserva una tarjeta. Lo de más atrás está en el `.jsonl`. */
export const CARD_LINES = 5;

interface RunsState {
  tasks: Task[];
  /** Los permisos que hay esperando, por tarea. */
  approvals: PendingApproval[];
  /** Por tarea, las últimas líneas de actividad. */
  activity: Record<string, string[]>;
  loaded: boolean;
  loadTasks: (workspaceId: string) => Promise<void>;
  startTask: (input: ipc.StartTaskInput) => Promise<Task>;
  cancelTask: (taskId: string) => Promise<void>;
  /** Un evento en vivo del backend. */
  applyEvent: (payload: TaskEventPayload) => void;
  /** Una fila cambió de estado: se relee. */
  refreshTask: (workspaceId: string, taskId: string) => Promise<void>;
  setApprovals: (approvals: PendingApproval[]) => void;
  loadApprovals: () => Promise<void>;
  decideApproval: (approvalId: string, allow: boolean) => Promise<void>;
}

/** La línea que se muestra para un evento. `null` = no aporta nada a la tarjeta. */
export function lineOf(event: AgentEvent): string | null {
  switch (event.kind) {
    case "text":
      return event.text;
    case "tool":
      return event.label;
    default:
      // `started` y `finished` ya se ven en el estado de la tarjeta; repetirlos como línea
      // gastaría uno de los cinco renglones en algo que no dice nada nuevo.
      return null;
  }
}

export const useRunsStore = create<RunsState>((set) => ({
  tasks: [],
  approvals: [],
  activity: {},
  loaded: false,

  loadTasks: async (workspaceId) => {
    const tasks = await ipc.listTasks(workspaceId);
    set({ tasks, loaded: true });
  },

  startTask: async (input) => {
    const task = await ipc.startTask(input);
    set((s) => ({ tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)] }));
    return task;
  },

  cancelTask: async (taskId) => {
    await ipc.cancelTask(taskId);
  },

  applyEvent: (payload) => {
    const line = lineOf(payload);
    if (line === null) return;
    set((s) => {
      const prev = s.activity[payload.taskId] ?? [];
      const next = [...prev, line].slice(-CARD_LINES);
      return { activity: { ...s.activity, [payload.taskId]: next } };
    });
  },

  setApprovals: (approvals) => set({ approvals }),

  loadApprovals: async () => {
    set({ approvals: await ipc.listApprovals() });
  },

  decideApproval: async (approvalId, allow) => {
    // Se saca de la lista en el acto: el backend avisa igual por evento, pero esperar ese
    // viaje deja el botón apretado mostrando algo que ya se decidió.
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approvalId) }));
    await ipc.decideApproval(approvalId, allow);
  },

  refreshTask: async (workspaceId, taskId) => {
    // Se relee la lista entera y no la fila: no hay comando de "una tarea" y pedirlo por
    // un cambio de estado (que pasa dos o tres veces por tarea, no por segundo) no
    // justifica otro comando más.
    const tasks = await ipc.listTasks(workspaceId);
    set({ tasks });
    if (!tasks.some((t) => t.id === taskId)) {
      // La tarea ya no está (se borró su run): su actividad tampoco tiene dueño.
      set((s) => {
        const { [taskId]: _gone, ...rest } = s.activity;
        return { activity: rest };
      });
    }
  },
}));
