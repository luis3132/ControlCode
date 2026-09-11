/**
 * El catálogo estático de TUIs de fábrica, servido por el backend.
 *
 * Es el espejo de `src-tauri/src/agents/registry.rs`, que es la tabla única. El frontend
 * **no** vuelve a declarar nada de esto: antes tenía su propia copia de los flags de
 * reanudación en `sessions/agentResume.ts`, y una tabla duplicada solo se nota cuando ya
 * divergió.
 *
 * ## Por qué se carga antes del primer render y no con `detectAgents`
 *
 * `detect_agents` sondea el `PATH` y corre `--version` por cada TUI: tarda cientos de
 * milisegundos y llega **después** de que las terminales montaron. Sacar de ahí los flags
 * de reanudación tenía una consecuencia cara y silenciosa: una tab restaurada se lanzaba
 * con el comando pelado, o sea **sesión nueva en vez de reanudar la del usuario**, y sin
 * ningún error a la vista.
 *
 * Este catálogo no toca disco ni lanza procesos — es un `const` de Rust serializado — así
 * que se puede pedir antes de renderizar. Eso es lo que deja a `buildResumeCommand` e
 * `isResumable` seguir siendo funciones síncronas, que es como las usan el render de
 * `TerminalPanel` y el efecto de montaje de `Terminal`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AgentRegistryEntry {
  id: string;
  label: string;
  command: string;
  /** Carpeta de skills relativa al cwd. `null` = no gestiona skills. */
  skillsDir: string | null;
  /** Argumentos de reanudación con el placeholder `{session}`. `null` = no sabe. */
  resume: string | null;
  supportsAccounts: boolean;
  sessions: string;
}

let REGISTRY: AgentRegistryEntry[] = [];

/**
 * Trae el catálogo y lo deja disponible para los lectores síncronos.
 *
 * Nunca rechaza: si el backend no responde, el catálogo queda vacío y las TUIs de fábrica
 * se comportan como una custom sin `resumeArgs` — se lanzan igual, sin reanudar. Es la
 * misma degradación que ya existía para una TUI desconocida, y es preferible a no
 * renderizar la app.
 */
export async function loadAgentRegistry(): Promise<void> {
  try {
    REGISTRY = await invoke<AgentRegistryEntry[]>("agent_registry");
  } catch (e) {
    console.error("No se pudo leer el catálogo de agentes:", e);
  }
}

export function agentRegistry(): AgentRegistryEntry[] {
  return REGISTRY;
}

export function agentDef(id: string): AgentRegistryEntry | undefined {
  return REGISTRY.find((a) => a.id === id);
}

/** Semilla directa del catálogo. Para los tests, que no tienen backend detrás. */
export function setAgentRegistry(entries: AgentRegistryEntry[]): void {
  REGISTRY = entries;
}
