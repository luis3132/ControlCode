import { useAgentsStore } from "@/features/agents/store";
import { agentDef } from "@/features/agents/registry";

/**
 * Cómo se relanza una sesión puntual de cada TUI.
 *
 * La tabla de flags **ya no vive acá**: era la cuarta copia de la definición de un agente
 * (las otras tres estaban en Rust) y la única en otro lenguaje, así que agregar una TUI
 * obligaba a acordarse de este archivo y olvidarse no rompía nada al compilar. Ahora sale
 * del catálogo de `agents/registry.ts`, espejo de `src-tauri/src/agents/registry.rs`.
 *
 * De paso quedó un solo camino en vez de dos: las TUIs de fábrica y las custom usan la
 * misma convención de placeholder (`{session}`), así que se resuelven con el mismo código.
 */

/** Los argumentos de reanudación de una TUI, sea de fábrica o custom. `null` = no sabe. */
function resumeArgsOf(agentId: string): string | null {
  const builtin = agentDef(agentId);
  if (builtin) return builtin.resume;
  // TUI custom: el usuario declaró los argumentos con el mismo placeholder (el backend
  // rechaza guardarlos sin él).
  const custom = useAgentsStore.getState().customAgents.find((a) => a.id === agentId);
  return custom?.resumeArgs ?? null;
}

/** ¿Esta TUI sabe reanudar una sesión puntual? Incluye las custom que lo declararon. */
export function isResumable(agentId: string): boolean {
  return resumeArgsOf(agentId) !== null;
}

/** Construye el comando efectivo a lanzar en el PTY: relanza la sesión real si se conoce su id. */
export function buildResumeCommand(agentId: string, command: string, sessionId?: string): string {
  if (!sessionId) return command;
  const args = resumeArgsOf(agentId);
  if (!args) return command;
  return `${command} ${args.split("{session}").join(sessionId)}`;
}
