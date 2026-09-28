/** Ver `ssh::SshConnection` en Rust. */
export interface SshConnection {
  id: string;
  /** Lo que escriben los agentes (`ssh_run { host: "servidor" }`). Único. */
  name: string;
  /** IP, nombre de red o alias de `~/.ssh/config`. */
  host: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  /** Carpeta donde arrancan las terminales y los comandos. */
  remoteDir: string | null;
  /** Si los agentes pueden verla y usarla. */
  agentAccess: boolean;
  createdAt: number;
}

/** Lo que manda el formulario. Sin `id` = alta. */
export interface SshConnectionDraft {
  id?: string;
  name: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
  remoteDir?: string | null;
  agentAccess: boolean;
}

/** Ver `ssh::ConnectionCheck`. */
export interface ConnectionCheck {
  ok: boolean;
  detail: string;
  hint: string | null;
  elapsedMs: number;
}

/** Ver `ssh::TerminalLaunch`. */
export interface TerminalLaunch {
  command: string;
  cwd: string;
}

/** `usuario@equipo:puerto`, como se muestra en la lista. */
export function describeConnection(c: Pick<SshConnection, "host" | "user" | "port">): string {
  const dest = c.user ? `${c.user}@${c.host}` : c.host;
  return c.port && c.port !== 22 ? `${dest}:${c.port}` : dest;
}

/** Un puerto escrito a mano: vacío = el de siempre; cualquier otra cosa tiene que ser válida. */
export function parsePort(raw: string): number | null | "invalid" {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return "invalid";
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : "invalid";
}
