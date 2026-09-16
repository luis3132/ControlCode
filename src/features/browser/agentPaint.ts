/**
 * El color con el que se pintan un agente y el navegador que está manejando.
 *
 * El color no decora: es lo único que dice, de un vistazo y sin leer, que esa tab de
 * navegador la está usando un agente y **cuál**. Con dos agentes trabajando sobre el mismo
 * proyecto, "¿de quién es esta ventana?" se contesta mirando, y por eso el mismo color va
 * en las dos tabs: la del agente y la de su navegador.
 *
 * Puro: se prueba en Node y lo usan las dos tiras de tabs.
 */

export interface AgentPaint {
  /** Nombre del color, para los tests y para depurar. */
  name: string;
  /** La barrita del borde izquierdo de la tab. */
  strip: string;
  /** El icono y el texto cuando la tab no está activa. */
  ink: string;
  /** El fondo tenue de la tab. */
  tint: string;
}

/**
 * Seis colores que se distinguen entre sí y del azul de "tab activa". Sin rojo: en esta app
 * el rojo es que algo falló.
 */
export const AGENT_PAINTS: AgentPaint[] = [
  { name: "violeta", strip: "bg-violet-500", ink: "text-violet-600 dark:text-violet-300", tint: "bg-violet-500/8" },
  { name: "esmeralda", strip: "bg-emerald-500", ink: "text-emerald-600 dark:text-emerald-300", tint: "bg-emerald-500/8" },
  { name: "ámbar", strip: "bg-amber-500", ink: "text-amber-600 dark:text-amber-300", tint: "bg-amber-500/8" },
  { name: "fucsia", strip: "bg-fuchsia-500", ink: "text-fuchsia-600 dark:text-fuchsia-300", tint: "bg-fuchsia-500/8" },
  { name: "cian", strip: "bg-cyan-500", ink: "text-cyan-600 dark:text-cyan-300", tint: "bg-cyan-500/8" },
  { name: "lima", strip: "bg-lime-500", ink: "text-lime-600 dark:text-lime-300", tint: "bg-lime-500/8" },
];

/**
 * El color de un agente. Sale de su id, así que es el mismo cada vez que se pregunta —en la
 * tab, en su navegador, después de reabrir la app— sin tener que guardarlo en ningún lado.
 */
export function agentPaint(id: string): AgentPaint {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AGENT_PAINTS[hash % AGENT_PAINTS.length];
}
