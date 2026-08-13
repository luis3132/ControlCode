/**
 * Gate para que una tab recién creada no lance su proceso (pty_create) hasta que los
 * symlinks de las skills elegidas en el wizard ya estén en disco — si el agente arranca
 * primero, escanea su cwd sin encontrarlas (algunos solo las leen al boot). Ver
 * NewTabWizard/TabBar (donde se registra) y Terminal.tsx (donde se espera).
 */
/**
 * La promesa resuelve con los errores de montaje (una línea por skill que falló), no con
 * `void`: quien espera este gate es la terminal, y es el único lugar con dónde mostrarlos.
 * Antes se descartaban en un `console.error` y la tab arrancaba sin skills en silencio.
 */
const pending = new Map<string, Promise<string[]>>();

export function registerPendingSkillSetup(tabId: string, setup: Promise<string[]>): void {
  pending.set(tabId, setup);
  setup.finally(() => {
    // Solo se borra si sigue siendo LA MISMA promesa (no pisar un registro más nuevo
    // por si alguna vez se reintenta el setup de la misma tab).
    if (pending.get(tabId) === setup) pending.delete(tabId);
  });
}

export function awaitSkillSetup(tabId: string): Promise<string[]> {
  // Un setup que falló entero (no una skill puntual) tampoco puede tumbar el arranque de
  // la terminal: se reporta como un error más y la tab abre igual.
  return (pending.get(tabId) ?? Promise.resolve([])).catch((e) => [String(e)]);
}
