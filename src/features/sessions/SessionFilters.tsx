import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, CloseIcon, Select } from "neogestify-ui-components";

import type { SessionHistoryEntry } from "@/features/sessions/types";

import {
  EMPTY_FILTERS,
  hasActiveFilters,
  type DateRange,
  type SessionFilterState,
} from "./filters";

interface SessionFiltersProps {
  /** Historial completo — de acá salen las opciones y los conteos. */
  entries: SessionHistoryEntry[];
  value: SessionFilterState;
  onChange: (next: SessionFilterState) => void;
}

/**
 * Los cortes que no se pueden tipear, al lado del buscador.
 *
 * El agente va como pastillas con su conteo porque es el corte más usado y son pocos: a la
 * vista y a un click, sin abrir un desplegable. Fecha y skill sí van en desplegables. La
 * carpeta ya no tiene filtro propio: agrupar por proyecto la resuelve mejor.
 */
export function SessionFilters({ entries, value, onChange }: SessionFiltersProps) {
  const { t } = useTranslation();
  const patch = (p: Partial<SessionFilterState>) => onChange({ ...value, ...p });

  // Las opciones salen de lo que HAY en el historial: no tiene sentido ofrecer filtrar
  // por un agente o una skill sin ninguna sesión.
  const agents = useMemo(() => {
    const byId = new Map<string, { label: string; count: number }>();
    for (const e of entries) {
      const hit = byId.get(e.agentId);
      if (hit) hit.count += 1;
      else byId.set(e.agentId, { label: e.agentLabel, count: 1 });
    }
    return [...byId.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [entries]);
  const skills = useMemo(
    () => Array.from(new Set(entries.flatMap((e) => e.skills.map((s) => s.name)))).sort(),
    [entries]
  );

  const pill = (id: string, label: string, count: number) => {
    const on = value.agentId === id;
    return (
      <Button variant="custom"
        key={id || "all"}
        onClick={() => patch({ agentId: id })}
        aria-pressed={on}
        className={`cc-t flex items-center gap-1.5 h-[30px] px-[11px] rounded-full shrink-0
          text-[12px] font-medium border
          ${on
            ? "border-blue-500/45 bg-blue-500/12 text-blue-700 dark:border-blue-400/45 dark:bg-blue-400/14 dark:text-blue-200"
            : "border-gray-200 dark:border-white/12 text-gray-600 dark:text-white/72 hover:bg-gray-100 dark:hover:bg-white/5"}`}
      >
        {label}
        <span className="text-[11px] opacity-70 tabular-nums">{count}</span>
      </Button>
    );
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
      {/* Las pastillas no envuelven: en un panel angosto se desplazan de costado. Envolviendo
          se comían dos o tres filas de alto que le correspondían a la lista. */}
      {agents.length > 1 && (
        <div className="flex items-center gap-1.5 min-w-0 max-w-full overflow-x-auto
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {pill("", t("sessions.filters.allAgentsShort"), entries.length)}
          {agents.map(([id, a]) => pill(id, a.label, a.count))}
          <span className="w-px h-[18px] mx-1 shrink-0 bg-gray-200 dark:bg-white/10" />
        </div>
      )}

      {/* Ancho fijo: el `Select` de la librería ocupa todo lo que le den, y suelto en una
          fila que envuelve se quedaba con una línea entera para él solo. */}
      <div className="w-[150px] shrink-0">
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
      </div>

      {skills.length > 0 && (
        <div className="w-[150px] shrink-0">
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
        </div>
      )}

      {hasActiveFilters(value) && (
        <Button variant="custom"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="cc-t flex items-center gap-1 shrink-0 px-2 h-[30px] rounded-lg
            text-[11.5px] text-gray-500 dark:text-white/50
            hover:text-gray-800 dark:hover:text-white
            hover:bg-gray-100 dark:hover:bg-white/8"
        >
          <CloseIcon className="w-3 h-3" />
          {t("sessions.filters.clear")}
        </Button>
      )}
    </div>
  );
}
