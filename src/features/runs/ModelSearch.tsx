import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, CheckIcon, SearchIcon } from "neogestify-ui-components";

import { agentIcon } from "@/features/agents/agentIcons";

import { searchModels } from "./routingView";
import type { RosterAgent } from "./types";

/** Lo que se elige: la TUI y su modelo a la vez. `model` vacío = el suyo por defecto. */
export interface ModelPick {
  agentId: string;
  model: string;
}

const key = (p: ModelPick) => `${p.agentId}\n${p.model}`;

function cost(inOut: [number | null, number | null]): string | null {
  const [i, o] = inOut;
  if (i === null || o === null) return null;
  const n = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  return `$${n(i)} / $${n(o)}`;
}

/**
 * Elegir con qué corre una tarea: un buscador sobre los modelos de todas las TUIs.
 *
 * Con varias TUIs instaladas son decenas de modelos (solo OpenCode lista cincuenta), y
 * elegir primero la TUI y después bajar por un `<select>` obligaba a saber de antemano en
 * cuál estaba el modelo que se quería. Acá se escribe lo que se busca —"sonnet", "codex",
 * "pickle"— y aparece agrupado por TUI; elegir una fila fija las dos cosas.
 *
 * Las flechas recorren la lista y Enter elige, sin sacar el foco del campo.
 */
export function ModelSearch({ agents, value, onChange, exclude = [], allowDefault = true, autoFocus = false, onEscape }: {
  agents: RosterAgent[];
  /** `null` = no hay uno elegido (agregar a un tramo). */
  value: ModelPick | null;
  onChange: (pick: ModelPick) => void;
  /** Los que ya están y no se ofrecen de nuevo. */
  exclude?: ModelPick[];
  /** Ofrecer "el modelo por defecto" de las TUIs cuyos modelos no se conocen. Un tramo de
   *  ruteo necesita un modelo con nombre, así que ahí no. */
  allowDefault?: boolean;
  autoFocus?: boolean;
  onEscape?: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const excluded = useMemo(() => new Set(exclude.map(key)), [exclude]);
  const groups = useMemo(
    () => searchModels(agents, query)
      .map((g) => ({ ...g, models: g.models.filter((m) => !excluded.has(key({ agentId: g.agent.agentId, model: m.id }))) }))
      .filter((g) => (g.byDefault ? allowDefault : g.models.length > 0)),
    [agents, query, excluded, allowDefault]
  );
  const picks = useMemo(
    () => groups.flatMap((g) => (g.byDefault
      ? [{ agentId: g.agent.agentId, model: "" }]
      : g.models.map((m) => ({ agentId: g.agent.agentId, model: m.id })))),
    [groups]
  );

  // Buscar algo nuevo arranca desde la primera coincidencia.
  useEffect(() => setActive(0), [query]);

  // La fila activa a la vista, sin mover la página.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-pick-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (picks.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + picks.length) % picks.length);
    } else if (e.key === "Enter" && picks[active]) {
      e.preventDefault();
      onChange(picks[active]);
    } else if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    }
  };

  const chosen = value ? key(value) : null;
  let index = -1;

  return (
    <div className="flex flex-col w-full rounded-lg overflow-hidden
      border border-gray-200 dark:border-white/10 bg-white dark:bg-white/3">
      <label className="flex items-center gap-2 h-8 px-2.5 border-b border-gray-200 dark:border-white/8">
        <SearchIcon className="w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-white/35" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("fleet.new.searchModel")}
          aria-label={t("fleet.new.searchModel")}
          spellCheck={false}
          autoFocus={autoFocus}
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px]
            text-gray-800 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-white/30"
        />
      </label>

      <div ref={listRef} className="max-h-60 cc-scroll py-1" role="listbox" aria-label={t("fleet.new.fixedModel")}>
        {groups.length === 0 && (
          <p className="px-3 py-4 text-center text-[11.5px] text-gray-400 dark:text-white/35">{t("fleet.new.noModel")}</p>
        )}
        {groups.map((g) => {
          const Icon = agentIcon(g.agent.agentId, g.agent.agentId);
          const rows = g.byDefault
            ? [{ id: "", label: t("fleet.new.defaultModel"), sub: null as string | null, price: null as string | null, local: false }]
            : g.models.map((m) => ({
              id: m.id,
              label: m.label,
              sub: m.label !== m.id ? m.id : null,
              price: cost([m.costIn, m.costOut]),
              local: m.local,
            }));
          return (
            <div key={g.agent.agentId}>
              <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                <Icon className="w-3 h-3 text-gray-400 dark:text-white/35" />
                <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em] text-gray-400 dark:text-white/30">
                  {g.agent.label}
                </span>
              </div>
              {rows.map((row) => {
                index += 1;
                const i = index;
                const pick = { agentId: g.agent.agentId, model: row.id };
                const selected = key(pick) === chosen;
                return (
                  <Button variant="custom"
                    key={row.id || "__default"}
                    data-pick-index={i}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => onChange(pick)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-left rounded-none
                      ${i === active ? "bg-gray-100 dark:bg-white/6" : ""}
                      ${selected ? "text-blue-700 dark:text-blue-300" : "text-gray-700 dark:text-gray-200"}`}
                  >
                    <span className="w-3.5 shrink-0 flex">
                      {selected && <CheckIcon className="w-3.5 h-3.5" />}
                    </span>
                    <span className="flex flex-col flex-1 min-w-0">
                      <span className={`text-[12px] truncate ${row.id ? "" : "italic"}`}>{row.label}</span>
                      {row.sub && (
                        <span className="font-mono text-[10px] truncate text-gray-400 dark:text-white/35">{row.sub}</span>
                      )}
                    </span>
                    {row.local && <Badge variant="neutral" size="sm">{t("fleet.new.local")}</Badge>}
                    {row.price && (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-gray-400 dark:text-white/35">{row.price}</span>
                    )}
                  </Button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
