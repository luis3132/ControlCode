import { create } from "zustand";

import { appendProxy, EMPTY_LOG, type DebugLog } from "./debugLog";
import { previewNetwork } from "./ipc";

interface DebugState {
  /** Por id de tab de navegador. */
  logs: Record<string, DebugLog>;
  apply: (viewId: string, fn: (log: DebugLog) => DebugLog) => void;
  drop: (viewId: string) => void;
}

/**
 * El log de debug de cada tab de navegador. En un store y no en el estado del componente
 * porque lo leen tres lados que no se conocen: el panel, el contador de la barra y el
 * agente que pregunta por el MCP.
 */
export const useDebugStore = create<DebugState>((set) => ({
  logs: {},
  apply: (viewId, fn) =>
    set((s) => {
      const prev = s.logs[viewId] ?? EMPTY_LOG;
      const next = fn(prev);
      return next === prev ? s : { logs: { ...s.logs, [viewId]: next } };
    }),
  drop: (viewId) =>
    set((s) => {
      if (!(viewId in s.logs)) return s;
      const { [viewId]: _dropped, ...rest } = s.logs;
      return { logs: rest };
    }),
}));

export function debugLogOf(viewId: string): DebugLog {
  return useDebugStore.getState().logs[viewId] ?? EMPTY_LOG;
}

/** Trae lo que el proxy anotó desde la última vez. */
export async function refreshProxyLog(viewId: string, proxyOrigin: string): Promise<void> {
  const page = await previewNetwork(proxyOrigin, debugLogOf(viewId).proxyNext);
  useDebugStore.getState().apply(viewId, (log) => appendProxy(log, page));
}
