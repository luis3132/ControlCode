import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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

const LEGACY_KEY = "controlcode-settings";

interface SettingsState {
  customAgents: CustomAgent[];
  loaded: boolean;

  loadCustomAgents: () => Promise<void>;
  saveCustomAgent: (agent: CustomAgentDraft) => Promise<void>;
  removeCustomAgent: (id: string) => Promise<void>;
}

/**
 * Las TUIs custom vivían en `localStorage` (zustand/persist) cuando solo tenían
 * nombre + comando. Ahora las necesita también el backend — la reconciliación de symlinks
 * de skills corre al cerrar una ventana, sin frontend de por medio — así que la fuente de
 * verdad pasó a SQLite. Esto sube lo que hubiera quedado guardado y borra la clave vieja;
 * el import de Rust ignora ids ya presentes, así que correrlo de más no duplica nada.
 */
async function migrateLegacyAgents(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const legacy = parsed?.state?.customAgents;
    if (Array.isArray(legacy) && legacy.length > 0) {
      await invoke("import_legacy_custom_agents", { agents: legacy });
    }
  } catch {
    // Un localStorage corrupto no debe impedir que la app arranque: se descarta igual.
  }
  localStorage.removeItem(LEGACY_KEY);
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  customAgents: [],
  loaded: false,

  loadCustomAgents: async () => {
    if (!get().loaded) await migrateLegacyAgents();
    const customAgents = await invoke<CustomAgent[]>("list_custom_agents");
    set({ customAgents, loaded: true });
  },

  saveCustomAgent: async (agent) => {
    await invoke("upsert_custom_agent", {
      id: agent.id ?? null,
      label: agent.label,
      command: agent.command,
      resumeArgs: agent.resumeArgs || null,
      skillsDir: agent.skillsDir || null,
      sessionsDir: agent.sessionsDir || null,
      sessionIdFrom: agent.sessionIdFrom || "filename",
      env: agent.env ?? {},
    });
    await get().loadCustomAgents();
  },

  removeCustomAgent: async (id) => {
    await invoke("delete_custom_agent", { id });
    await get().loadCustomAgents();
  },
}));

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
