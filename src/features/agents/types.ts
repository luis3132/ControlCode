/**
 * TUI agregada a mano por el usuario. Más allá de nombre + comando, declara cómo se
 * integra con la app: las TUIs de fábrica tienen esa integración hardcodeada (verificada
 * contra la doc de cada CLI), pero para una arbitraria no hay forma de adivinarla.
 *
 * Todo lo que no sea `label`/`command` es opcional: una TUI sin nada de esto sigue
 * andando, simplemente no participa de reanudación / skills / historial de sesiones.
 */
export interface CustomAgent {
  id: string;
  label: string;
  /** Comando de invocación, tal cual se lanza (puede traer flags: `mitui --foo`). */
  command: string;
  /** Argumentos de reanudación con el placeholder `{session}`, ej. `--resume {session}`. */
  resumeArgs: string | null;
  /** Carpeta de skills RELATIVA al cwd del proyecto, ej. `.agents/skills`. */
  skillsDir: string | null;
  /** Carpeta donde la TUI guarda sus sesiones, ej. `~/.mitui/sessions`. */
  sessionsDir: string | null;
  /** `filename` (el nombre del archivo es el id) o `field:<clave>`. */
  sessionIdFrom: string;
  /** Variables de entorno extra al lanzar el proceso. */
  env: Record<string, string>;
}

export type CustomAgentDraft = Omit<CustomAgent, "id"> & { id?: string };

/** Draft vacío para el formulario de "agregar TUI". */
export function emptyCustomAgent(): CustomAgentDraft {
  return {
    label: "",
    command: "",
    resumeArgs: "",
    skillsDir: "",
    sessionsDir: "",
    sessionIdFrom: "filename",
    env: {},
  };
}
