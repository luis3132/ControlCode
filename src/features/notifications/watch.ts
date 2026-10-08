import i18n from "@/i18n";
import { useChatStore } from "@/features/chat/store";
import { useProcessesStore } from "@/features/processes/store";
import { useRunsStore } from "@/features/runs/store";
import { currentLayout, useLayoutStore } from "@/features/tabs/layout/layoutStore";
import { agentKey, allGroups } from "@/features/tabs/layout/layoutTree";
import { useTabsStore } from "@/features/tabs/store";

import { busyMap, failedProcesses, finishedTurns, newApprovals } from "./diff";
import { useNotificationsStore } from "./store";

/**
 * De dónde salen los avisos. No toca a nadie: escucha los stores que ya existen (el chat,
 * los permisos, los subprocesos) y compara cada estado con el anterior.
 */

/**
 * La tab se está viendo: es la visible de algún grupo, la pantalla es la del workspace y la
 * ventana tiene el foco. Una ventana de fondo no cuenta como mirar: es justo cuando sirve
 * enterarse de que algo terminó.
 */
export function onScreen(tabId: string): boolean {
  if (document.hidden || !document.hasFocus()) return false;
  if (!window.location.hash.startsWith("#/workspace")) return false;
  const layout = currentLayout();
  return !!layout && allGroups(layout.root).some((g) => g.active === agentKey(tabId));
}

const titleOf = (tabId: string) => useTabsStore.getState().tabs.find((t) => t.id === tabId)?.title ?? "";

/** Las tabs con el punto de "terminó" que ya están a la vista lo pierden. */
export function sweepSeen(): void {
  const { finished, markSeen } = useNotificationsStore.getState();
  for (const tabId of Object.keys(finished)) if (onScreen(tabId)) markSeen(tabId);
}

/** Engancha las fuentes de avisos. Devuelve cómo soltarlas. */
export function initNotifications(): () => void {
  const notify = useNotificationsStore.getState();
  const t = i18n.t.bind(i18n);

  let busy = busyMap(useChatStore.getState().chats);
  const offChat = useChatStore.subscribe((s) => {
    const next = busyMap(s.chats);
    for (const tabId of finishedTurns(busy, next)) {
      if (onScreen(tabId)) continue;
      const at = Date.now();
      notify.markFinished(tabId, at);
      notify.push({ kind: "finished", text: t("notifications.finished", { agent: titleOf(tabId) }), at, target: { tabId } });
    }
    busy = next;
  });

  let approvals = useRunsStore.getState().approvals;
  const offRuns = useRunsStore.subscribe((s) => {
    if (s.approvals === approvals) return;
    for (const a of newApprovals(approvals, s.approvals)) {
      // El de una tab que se está mirando ya está en su chat, con sus botones.
      if (a.tabId && onScreen(a.tabId)) continue;
      const tasks = useRunsStore.getState().tasks;
      const who = a.tabId ? titleOf(a.tabId) : tasks.find((task) => task.id === a.taskId)?.title ?? t("sidebar.fleet");
      notify.push({
        kind: "approval",
        text: t("notifications.approval", { agent: who, tool: a.toolName }),
        at: Date.now(),
        target: a.tabId ? { tabId: a.tabId } : { path: "/fleet" },
      });
    }
    approvals = s.approvals;
  });

  let procs = useProcessesStore.getState().procs;
  const offProcs = useProcessesStore.subscribe((s) => {
    if (s.procs === procs) return;
    for (const p of failedProcesses(procs, s.procs)) {
      notify.push({
        kind: "processFailed",
        text: t("notifications.processFailed", { name: p.name, code: p.exitCode }),
        at: Date.now(),
        target: { path: "/processes" },
      });
    }
    procs = s.procs;
  });

  // Las tabs cerradas se llevan su punto; y cambiar lo que se ve puede estar mostrándolas.
  const offTabs = useTabsStore.subscribe((s) => {
    const ids = new Set(s.tabs.map((tab) => tab.id));
    for (const tabId of Object.keys(useNotificationsStore.getState().finished)) {
      if (!ids.has(tabId)) useNotificationsStore.getState().markSeen(tabId);
    }
    sweepSeen();
  });
  const offLayout = useLayoutStore.subscribe(sweepSeen);
  window.addEventListener("focus", sweepSeen);
  window.addEventListener("hashchange", sweepSeen);
  document.addEventListener("visibilitychange", sweepSeen);

  return () => {
    offChat();
    offRuns();
    offProcs();
    offTabs();
    offLayout();
    window.removeEventListener("focus", sweepSeen);
    window.removeEventListener("hashchange", sweepSeen);
    document.removeEventListener("visibilitychange", sweepSeen);
  };
}
