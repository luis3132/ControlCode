/** Un subproceso, como lo devuelve `procs_list` (ver `src-tauri/src/procs/mod.rs`). */
export type ProcStatus = "running" | "exited" | "stopped";

export interface Subprocess {
  /** Corto y estable (`p3`): sobrevive a los reinicios. */
  id: string;
  name: string;
  command: string;
  cwd: string;
  /** La carpeta del workspace al que pertenece. */
  workspace: string;
  /** Quién lo lanzó: la tab de un agente, una tarea de la flota, o nadie (la persona). */
  owner: { tabId: string | null; taskId: string | null };
  status: ProcStatus;
  exitCode: number | null;
  /** El PTY donde corre ahora: cambia al reiniciar. */
  ptyId: number;
  startedAt: number;
  endedAt: number | null;
  restarts: number;
}

export interface ProcUsage {
  id: string;
  /** Porcentaje de un núcleo, como `top`. */
  cpu: number;
  /** Bytes. */
  memory: number;
  /** Procesos del árbol. */
  processes: number;
}

/** Dos rutas de carpeta que son la misma, aunque una tenga barra final (como en Rust). */
export function sameFolder(a: string, b: string): boolean {
  const trim = (s: string) => s.replace(/[/\\]+$/, "");
  return trim(a) === trim(b);
}

/** Los de un workspace, o todos. Los vivos primero, y de ahí los más nuevos. */
export function visibleProcesses(procs: Subprocess[], workspace: string | null, all: boolean): Subprocess[] {
  return procs
    .filter((p) => all || (workspace !== null && sameFolder(p.workspace, workspace)))
    .sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || b.startedAt - a.startedAt);
}

/** Agrupados por workspace, en el orden en que aparecen. */
export function byWorkspace(procs: Subprocess[]): [string, Subprocess[]][] {
  const groups = new Map<string, Subprocess[]>();
  for (const p of procs) {
    const key = p.workspace.replace(/[/\\]+$/, "");
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups];
}

/** "42s", "3m 05s", "2h 10m". */
export function formatUptime(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** "312 MB", "1.4 GB". */
export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
