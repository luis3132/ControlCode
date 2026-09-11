import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, CheckIcon, Input, SearchIcon, StackIcon } from "neogestify-ui-components";
import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";

interface SkillPickerStepProps {
  /** `null` = sin filtrar por TUI. Es el caso del workspace, que no tiene una sola: sus
   *  skills valen para todos los agentes que se abran en esa carpeta. */
  agentId: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
}

/** El encabezado de un grupo, igual que en Skills y en la paleta de adjuntar. */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-2 pb-1">
      <span className="text-[9.5px] font-extrabold uppercase tracking-[0.11em]
        text-gray-400 dark:text-white/30">
        {label}
      </span>
      <span className="flex-1 h-px bg-gray-200 dark:bg-white/6" />
      <span className="text-[9.5px] tabular-nums text-gray-400 dark:text-white/25">
        {count}
      </span>
    </div>
  );
}

/** Una skill de la lista. Misma fila que en Skills y en la paleta: chip con el ícono,
 *  nombre y descripción — lo que cambia es que acá el chip marca lo ELEGIDO en vez de lo
 *  ya adjunto. La casilla de tildar quedó afuera a propósito: la fila entera es el
 *  control, y el estado se lee del chip verde sin tener que apuntarle a un cuadradito. */
function SkillRow({ skill, checked, onToggle }: {
  skill: SkillSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className={`cc-t flex items-center gap-3 w-full h-[42px] px-2.5 rounded-lg text-left
        ${checked
          ? "bg-blue-500/12 dark:bg-blue-400/13 shadow-[inset_0_0_0_1px_rgba(88,166,255,0.24)]"
          : "hover:bg-gray-100 dark:hover:bg-white/5"}`}
    >
      <span className={`flex items-center justify-center w-6 h-6 rounded-md shrink-0
        ${checked
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-violet-500/12 text-violet-500 dark:text-violet-400"}`}>
        {checked ? <CheckIcon className="w-3.5 h-3.5" /> : <StackIcon className="w-3.5 h-3.5" />}
      </span>

      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="truncate text-[12.5px] font-semibold text-gray-800 dark:text-gray-100">
          {skill.name}
        </span>
        <span className="truncate text-[10.5px] text-gray-400 dark:text-white/35">
          {skill.description ?? t("skills.list.noDescription")}
        </span>
      </span>

      {checked && (
        <Badge variant="success" size="sm" className="shrink-0">
          {t("wizard.step3.chosen")}
        </Badge>
      )}
    </button>
  );
}

/** Elegir qué skills adjuntar a ESTA tab antes de lanzar el agente — a propósito es un
 * paso previo (no algo que se hace después desde Skills) porque los symlinks tienen que
 * existir en el cwd ANTES de que el proceso arranque: algunos agentes solo escanean su
 * carpeta de skills al boot, así que adjuntar después de lanzado no sirve.
 *
 * La lista habla el mismo idioma que Skills y que la paleta de "agregar más skills": las
 * mismas filas, los mismos encabezados de grupo. Elegir una skill acá y adjuntarla allá
 * son la misma acción en dos momentos distintos, así que no tiene sentido que se vean
 * como dos cosas distintas.
 */
export function SkillPickerStep({ agentId, selected, onChange }: SkillPickerStepProps) {
  const { t } = useTranslation();
  const skills = useSkillsStore((s) => s.skills);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const compatible = agentId === null
    ? skills
    : skills.filter((s) => s.compatibleAgents.length === 0 || s.compatibleAgents.includes(agentId));

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQuery = (s: SkillSummary) => {
    if (!trimmedQuery) return true;
    const haystack = `${s.name} ${s.description ?? ""} ${s.categories.join(" ")}`.toLowerCase();
    return haystack.includes(trimmedQuery);
  };

  // Las elegidas van primero: son las que el usuario necesita poder repasar de un vistazo
  // antes de confirmar, y en un catálogo grande quedaban desparramadas entre el resto.
  const chosen = compatible.filter((s) => selected.includes(s.id));
  const rest = compatible.filter((s) => !selected.includes(s.id));

  // Se listan TODAS las instaladas. Hubo una versión que, pasadas diez, escondía el resto
  // hasta que escribieras algo: ahorraba scroll y a cambio dejaba el catálogo en una caja
  // negra — no se podía ver qué había sin adivinar el nombre. Si son muchas, se scrollea o
  // se filtra con el buscador, pero la lista está entera.
  const visibleChosen = chosen.filter(matchesQuery);
  const visibleRest = rest.filter(matchesQuery);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  if (skills.length === 0) {
    return <p className="text-xs italic text-gray-400 dark:text-white/30">{t("wizard.step3.empty")}</p>;
  }

  if (compatible.length === 0) {
    return <p className="text-xs italic text-gray-400 dark:text-white/30">{t("wizard.step3.noneCompatible")}</p>;
  }

  // Sin nada elegido hay una sola lista, y encabezarla sería ponerle título a lo obvio.
  const grouped = visibleChosen.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400 dark:text-white/40">{t("wizard.step3.helper")}</p>

      {/* Buscador — filtra por nombre, descripción o categoría. Es un atajo para llegar a
          una skill que ya sabés cómo se llama, no un portero: la lista está entera abajo. */}
      {compatible.length > 5 && (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("wizard.step3.searchPlaceholder")}
          variant="outline"
          size="sm"
          icon={<SearchIcon className="w-3.5 h-3.5" />}
          clearable
          onClear={() => setQuery("")}
        />
      )}

      <div className="cc-scroll flex flex-col max-h-64 pr-1">
        {visibleChosen.length === 0 && visibleRest.length === 0 ? (
          <p className="py-2 text-xs italic text-gray-400 dark:text-white/30">
            {t("wizard.step3.searchEmpty")}
          </p>
        ) : (
          <>
            {grouped && (
              <GroupHeader label={t("wizard.step3.groupChosen")} count={visibleChosen.length} />
            )}
            {visibleChosen.map((skill) => (
              <SkillRow key={skill.id} skill={skill} checked onToggle={() => toggle(skill.id)} />
            ))}

            {grouped && visibleRest.length > 0 && (
              <GroupHeader label={t("wizard.step3.groupAvailable")} count={visibleRest.length} />
            )}
            {visibleRest.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                checked={false}
                onToggle={() => toggle(skill.id)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
