import { useTranslation } from "react-i18next";
import { CloseIcon, Select } from "neogestify-ui-components";

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

/**
 * La franja de filtros, debajo del buscador.
 *
 * El texto no está acá: se escribe en el buscador grande del encabezado, que es por donde
 * se entra a esta pantalla. Acá quedan los cortes que no se pueden tipear — agente,
 * carpeta, fecha, skill — en una sola fila que no le roba alto a la lista.
 */
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

  const active = hasActiveFilters(value);

  return (
    <div className="flex items-center gap-1.5 shrink-0 px-3 py-1.5
      border-b border-gray-200 dark:border-white/8
      bg-gray-100/40 dark:bg-white/2">

      <Select
        value={value.agentId}
        onChange={(e) => patch({ agentId: e.target.value })}
        options={[
          { value: "", label: t("sessions.filters.allAgents") },
          ...agents.map(([id, label]) => ({ value: id, label })),
        ]}
        variant="minimal"
        size="sm"
        className="min-w-0"
      />

      {cwds.length > 1 && (
        <Select
          value={value.cwd}
          onChange={(e) => patch({ cwd: e.target.value })}
          options={[
            { value: "", label: t("sessions.filters.allFolders") },
            ...cwds.map((c) => ({ value: c, label: shortenPath(c) })),
          ]}
          variant="minimal"
          size="sm"
          className="min-w-0"
        />
      )}

      <Select
        value={value.dateRange}
        onChange={(e) => patch({ dateRange: e.target.value as DateRange })}
        options={[
          { value: "all", label: t("sessions.filters.anyDate") },
          { value: "today", label: t("sessions.filters.today") },
          { value: "week", label: t("sessions.filters.week") },
          { value: "month", label: t("sessions.filters.month") },
        ]}
        variant="minimal"
        size="sm"
        className="min-w-0"
      />

      {skills.length > 0 && (
        <Select
          value={value.skill}
          onChange={(e) => patch({ skill: e.target.value })}
          options={[
            { value: "", label: t("sessions.filters.anySkill") },
            ...skills.map((s) => ({ value: s, label: s })),
          ]}
          variant="minimal"
          size="sm"
          className="min-w-0"
        />
      )}

      <div className="flex-1" />

      {active && (
        <>
          <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-white/35">
            {t("sessions.filters.results", { count: resultCount })}
          </span>
          <button
            onClick={() => onChange(EMPTY_FILTERS)}
            className="cc-t flex items-center gap-1 shrink-0 px-1.5 h-5.5 rounded-md
              text-[10.5px] text-gray-500 dark:text-white/45
              hover:text-gray-800 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <CloseIcon className="w-3 h-3" />
            {t("sessions.filters.clear")}
          </button>
        </>
      )}
    </div>
  );
}
