import { useTranslation } from "react-i18next";
import { Input, Select } from "neogestify-ui-components";
import { SearchIcon, CloseIcon } from "neogestify-ui-components";
import type { SessionHistoryEntry } from "@/features/sessions/types";

import {
  EMPTY_FILTERS,
  hasActiveFilters,
  shortenPath,
  type DateRange,
  type SessionFilterState,
} from "./filters";

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
