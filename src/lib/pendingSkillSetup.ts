/**
 * Gate para que una tab recién creada no lance su proceso (pty_create) hasta que los
 * symlinks de las skills elegidas en el wizard ya estén en disco — si el agente arranca
 * primero, escanea su cwd sin encontrarlas (algunos solo las leen al boot). Ver
 * NewTabWizard/TabBar (donde se registra) y Terminal.tsx (donde se espera).
 */
const pending = new Map<string, Promise<void>>();

export function registerPendingSkillSetup(tabId: string, setup: Promise<void>): void {
  pending.set(tabId, setup);
  setup.finally(() => {
    // Solo se borra si sigue siendo LA MISMA promesa (no pisar un registro más nuevo
    // por si alguna vez se reintenta el setup de la misma tab).
    if (pending.get(tabId) === setup) pending.delete(tabId);
  });
}

export function awaitSkillSetup(tabId: string): Promise<void> {
  return pending.get(tabId) ?? Promise.resolve();
}
