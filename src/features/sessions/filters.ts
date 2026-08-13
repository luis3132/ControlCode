import type { SessionHistoryEntry } from "./types";

/** Ventana de tiempo relativa al ahora. `all` = sin límite. */
export type DateRange = "all" | "today" | "week" | "month";

export interface SessionFilterState {
  query: string;
  agentId: string;
  cwd: string;
  skill: string;
  dateRange: DateRange;
}

export const EMPTY_FILTERS: SessionFilterState = {
  query: "",
  agentId: "",
  cwd: "",
  skill: "",
  dateRange: "all",
};

export function hasActiveFilters(f: SessionFilterState): boolean {
  return (
    f.query.trim() !== "" ||
    f.agentId !== "" ||
    f.cwd !== "" ||
    f.skill !== "" ||
    f.dateRange !== "all"
  );
}

const RANGE_SECONDS: Record<Exclude<DateRange, "all">, number> = {
  today: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
};

/**
 * Aplica los filtros a la lista ya cargada. Se filtra en el frontend a propósito: el
 * historial es de un solo workspace, así que son decenas de entradas, y hacerlo acá da
 * respuesta inmediata al tipear sin un round-trip por tecla.
 */
export function filterSessions(
  entries: SessionHistoryEntry[],
  f: SessionFilterState
): SessionHistoryEntry[] {
  const query = f.query.trim().toLowerCase();
  const cutoff =
    f.dateRange === "all" ? null : Math.floor(Date.now() / 1000) - RANGE_SECONDS[f.dateRange];

  return entries.filter((e) => {
    if (f.agentId && e.agentId !== f.agentId) return false;
    if (f.cwd && e.cwd !== f.cwd) return false;
    if (f.skill && !e.skills.some((s) => s.name === f.skill)) return false;
    if (cutoff !== null && e.closedAt < cutoff) return false;
    if (query) {
      const haystack = `${e.title ?? ""} ${e.agentLabel} ${e.cwd}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** `/home/luis/proyectos/api` → `…/proyectos/api`, para que entre en el desplegable. */
export function shortenPath(path: string, keep = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
