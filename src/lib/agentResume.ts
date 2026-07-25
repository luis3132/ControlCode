import { useSettingsStore } from "../store/settings";

/** Agentes para los que se sabe construir un comando de "resume por session id".
 * Verificado contra la documentación real de cada CLI (no asumido):
 * - claude-code: code.claude.com/docs/en/sessions — `--resume <id>` apunta a una sesión
 *   puntual sin importar el cwd (distinto de `--continue`, que retoma la más reciente
 *   DEL directorio actual — no es lo que queremos acá, nosotros ya sabemos el id exacto).
 * - gemini-cli: github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
 *   — mismo flag `--resume <id>` (además de aceptar índice numérico o vacío).
 * - codex: learn.chatgpt.com/docs/build-skills / Inventive HQ — `resume <id>` es
 *   subcomando, no flag.
 * - opencode: opencode.ai docs — `--session <id>` (alias `-s`) apunta a una sesión
 *   puntual; `--continue`/`-c` (sin id) retoma la más reciente, no aplica acá.
 * - kimi-code: moonshotai.github.io/kimi-code/en/reference/kimi-command.html —
 *   `--session <id>` (alias `-S`, mayúscula — distinta de `-s`/`--continue` corta). */
const RESUME_BUILDERS: Record<string, (cmd: string, sessionId: string) => string> = {
  "claude-code": (cmd, id) => `${cmd} --resume ${id}`,
  "gemini-cli": (cmd, id) => `${cmd} --resume ${id}`,
  codex: (cmd, id) => `${cmd} resume ${id}`,
  opencode: (cmd, id) => `${cmd} --session ${id}`,
  "kimi-code": (cmd, id) => `${cmd} --session ${id}`,
};

export const RESUMABLE_AGENT_IDS = Object.keys(RESUME_BUILDERS);

/** ¿Esta TUI sabe reanudar una sesión puntual? Incluye las custom que lo declararon. */
export function isResumable(agentId: string): boolean {
  if (agentId in RESUME_BUILDERS) return true;
  const custom = useSettingsStore.getState().customAgents.find((a) => a.id === agentId);
  return Boolean(custom?.resumeArgs);
}

/** Construye el comando efectivo a lanzar en el PTY: relanza la sesión real si se conoce su id. */
export function buildResumeCommand(agentId: string, command: string, sessionId?: string): string {
  if (!sessionId) return command;

  const build = RESUME_BUILDERS[agentId];
  if (build) return build(command, sessionId);

  // TUI custom: el usuario declaró los argumentos de reanudación con el placeholder
  // {session} (el backend rechaza guardarlos sin él, así que acá siempre está).
  const custom = useSettingsStore.getState().customAgents.find((a) => a.id === agentId);
  if (custom?.resumeArgs) {
    return `${command} ${custom.resumeArgs.split("{session}").join(sessionId)}`;
  }
  return command;
}
