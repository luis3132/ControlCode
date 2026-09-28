/** Lo que manda Control Code. Ver la tabla de métodos de `docs/remote-protocol.md`. */

export interface Tab {
  id: string;
  title: string;
  agentId: string;
  agentLabel: string;
  cwd: string;
}

/** Un agente de la flota esperando permiso (`runs::PendingApproval`). */
export interface Approval {
  id: string;
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  askedAt: number;
  suggestedRule?: string | null;
}

/** Un agente preguntando algo (`ask_user`). */
export interface Ask {
  id: string;
  question: string;
  options: string[];
  placeholder?: string | null;
  taskId?: string | null;
  tabId?: string | null;
  cwd?: string | null;
}

export interface DesktopState {
  name: string;
  version: string;
  tabs: Tab[];
  approvals: Approval[];
  asks: Ask[];
}

export interface Attached {
  scrollback: string;
  running: boolean;
  cols: number;
  rows: number;
}

export type TabEvent =
  | { kind: "data"; data: string }
  | { kind: "exit"; code: number }
  | { kind: "resize"; cols: number; rows: number }
  /** La conexión se rehízo: hay que volver a engancharse a la tab. */
  | { kind: "reattach" };

export interface LaunchOptions {
  agents: { id: string; label: string }[];
  folders: string[];
}

/** Un PC emparejado, como lo guarda el teléfono. */
export interface Desktop {
  /** Su clave pública: con eso se le cifra y se lo encuentra en el relay. */
  id: string;
  name: string;
  relay: string;
  token?: string;
  pairedAt: number;
}

/** El último pedazo de una ruta, para mostrar una carpeta sin la ruta entera. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Lo que un permiso quiere hacer, en una línea: el comando, el archivo… */
export function describeApproval(a: Approval): string {
  const input = a.input ?? {};
  const pick = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  return pick("command") ?? pick("file_path") ?? pick("path") ?? pick("url") ?? pick("pattern") ?? JSON.stringify(input).slice(0, 200);
}
