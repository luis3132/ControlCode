import { useTranslation } from "react-i18next";
import { Input, Select } from "neogestify-ui-components";
import { SearchIcon, CloseIcon } from "neogestify-ui-components";
import { SessionHistoryEntry } from "../../store/sessions";

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

interface SessionFiltersProps {
  /** Historial completo — de acá salen las opciones de cada desplegable. */
  entries: SessionHistoryEntry[];
  value: SessionFilterState;
  onChange: (next: SessionFilterState) => void;
  /** Cuántas entradas quedan tras filtrar, para el contador. */
  resultCount: number;
}

export function SessionFilters({ entries, value, onChange, resultCount }: SessionFiltersProps) {
  const { t } = useTranslation();
  const patch = (p: Partial<SessionFilterState>) => onChange({ ...value, ...p });

  // Las opciones salen de lo que HAY en el historial: no tiene sentido ofrecer filtrar
  // por un agente o una carpeta sin ninguna sesión.
  const agents = Array.from(
    new Map(entries.map((e) => [e.agentId, e.agentLabel])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const cwds = Array.from(new Set(entries.map((e) => e.cwd))).sort();
  const skills = Array.from(
    new Set(entries.flatMap((e) => e.skills.map((s) => s.name)))
  ).sort();

  return (
    <div className="flex flex-col gap-2 mb-4">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4
          text-gray-400 dark:text-gray-500 pointer-events-none z-10" />
        <Input
          value={value.query}
          onChange={(e) => patch({ query: e.target.value })}
          placeholder={t("sessions.filters.search")}
          variant="outline"
          className="pl-9!"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="min-w-[9rem] flex-1">
          <Select
            value={value.agentId}
            onChange={(e) => patch({ agentId: e.target.value })}
            options={[
              { value: "", label: t("sessions.filters.allAgents") },
              ...agents.map(([id, label]) => ({ value: id, label })),
            ]}
            variant="outline"
          />
        </div>

        <div className="min-w-[9rem] flex-1">
          <Select
            value={value.cwd}
            onChange={(e) => patch({ cwd: e.target.value })}
            options={[
              { value: "", label: t("sessions.filters.allFolders") },
              ...cwds.map((c) => ({ value: c, label: shortenPath(c) })),
            ]}
            variant="outline"
          />
        </div>

        <div className="min-w-[9rem] flex-1">
          <Select
            value={value.dateRange}
            onChange={(e) => patch({ dateRange: e.target.value as DateRange })}
            options={[
              { value: "all", label: t("sessions.filters.anyDate") },
              { value: "today", label: t("sessions.filters.today") },
              { value: "week", label: t("sessions.filters.week") },
              { value: "month", label: t("sessions.filters.month") },
            ]}
            variant="outline"
          />
        </div>

        {skills.length > 0 && (
          <div className="min-w-[9rem] flex-1">
            <Select
              value={value.skill}
              onChange={(e) => patch({ skill: e.target.value })}
              options={[
                { value: "", label: t("sessions.filters.anySkill") },
                ...skills.map((s) => ({ value: s, label: s })),
              ]}
              variant="outline"
            />
          </div>
        )}
      </div>

      {hasActiveFilters(value) && (
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>{t("sessions.filters.results", { count: resultCount })}</span>
          <button
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex items-center gap-1 text-blue-500 dark:text-blue-400 hover:underline"
          >
            <CloseIcon className="w-3 h-3" />
            {t("sessions.filters.clear")}
          </button>
        </div>
      )}
    </div>
  );
}

/** `/home/luis/proyectos/api` → `…/proyectos/api`, para que entre en el desplegable. */
export function shortenPath(path: string, keep = 2): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
