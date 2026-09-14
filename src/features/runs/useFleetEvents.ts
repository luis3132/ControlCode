import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import { useTabsStore } from "@/features/tabs/store";

import { useRunsStore } from "./store";
import type { PendingApproval, TaskEventPayload } from "./types";

/** Los eventos que emite el supervisor. Deben coincidir con `runs/supervisor.rs`. */
const TASK_EVENT = "cc-task-event";
const TASK_CHANGED = "cc-task-changed";
const APPROVALS_CHANGED = "cc-task-approvals";

/**
 * Mantiene la flota al día. Se monta UNA vez por ventana, en `AppShell`.
 *
 * Antes esto vivía en la consola, y la consola es una ruta: al salir de `/fleet` se
 * desmonta. Eso tenía dos consecuencias, las dos silenciosas:
 *
 * - **Un permiso pedido con la consola cerrada no lo veía nadie.** El agente quedaba
 *   parado esperando y en la pantalla no había nada que lo dijera — justo el caso que la
 *   consola existe para evitar.
 * - **La actividad de mientras tanto se perdía.** Al volver, las tarjetas de los agentes
 *   que habían seguido trabajando aparecían vacías.
 *
 * Tampoco puede montarse en dos lugares: los eventos de actividad se AGREGAN a la
 * tarjeta, así que dos suscripciones escribirían cada línea dos veces.
 */
export function useFleetEvents() {
  const workspaceId = useTabsStore((s) => s.workspaceId);
  const loadTasks = useRunsStore((s) => s.loadTasks);
  const loadApprovals = useRunsStore((s) => s.loadApprovals);
  const applyEvent = useRunsStore((s) => s.applyEvent);
  const refreshTask = useRunsStore((s) => s.refreshTask);
  const setApprovals = useRunsStore((s) => s.setApprovals);

  useEffect(() => {
    if (workspaceId) loadTasks(workspaceId).catch(console.error);
    // La cola no es por workspace, y puede haber pedidos de antes de montar esta ventana.
    loadApprovals().catch(console.error);
  }, [workspaceId, loadTasks, loadApprovals]);

  useEffect(() => {
    if (!workspaceId) return;
    const unlisten = [
      listen<TaskEventPayload>(TASK_EVENT, (e) => applyEvent(e.payload)),
      listen<string>(TASK_CHANGED, (e) => refreshTask(workspaceId, e.payload)),
      listen<PendingApproval[]>(APPROVALS_CHANGED, (e) => setApprovals(e.payload)),
    ];
    return () => {
      unlisten.forEach((p) => p.then((off) => off()).catch(() => {}));
    };
  }, [workspaceId, applyEvent, refreshTask, setApprovals]);
}
