/** Agentes para los que se sabe construir un comando de "resume por session id". */
const RESUME_BUILDERS: Record<string, (cmd: string, sessionId: string) => string> = {
  "claude-code": (cmd, id) => `${cmd} --resume ${id}`,
  "gemini-cli": (cmd, id) => `${cmd} --resume ${id}`,
  codex: (cmd, id) => `${cmd} resume ${id}`,
  opencode: (cmd, id) => `${cmd} --session ${id}`,
};

export const RESUMABLE_AGENT_IDS = Object.keys(RESUME_BUILDERS);

/** Construye el comando efectivo a lanzar en el PTY: relanza la sesión real si se conoce su id. */
export function buildResumeCommand(agentId: string, command: string, sessionId?: string): string {
  if (!sessionId) return command;
  const build = RESUME_BUILDERS[agentId];
  return build ? build(command, sessionId) : command;
}
