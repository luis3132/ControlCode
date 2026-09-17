import { create } from "zustand";

/**
 * Qué agente se está señalando desde otra parte de la app, para que su tab lo muestre.
 *
 * Con tres agentes del mismo tipo en la misma carpeta, la barra dice «Claude Code» tres
 * veces: elegir a cuál mandarle lo que marcaste es adivinar. En vez de inventar un nombre,
 * se usa lo que ya existe —el color de cada agente (ver `agentPaint`)— y se le prende al
 * que está elegido: la fila del selector y la tab de arriba se ven del mismo color, así que
 * la pregunta «¿cuál es este?» se contesta mirando.
 */
interface AgentHighlight {
  /** La tab del agente señalado, o `null`. */
  id: string | null;
}

export const useAgentHighlight = create<AgentHighlight>(() => ({ id: null }));

export const highlightAgent = (id: string | null) => useAgentHighlight.setState({ id });
