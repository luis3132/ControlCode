import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "neogestify-ui-components";
import { SearchIcon } from "neogestify-ui-components";
import { useSkillsStore } from "@/features/skills/store";

/** A partir de cuántas skills SIN seleccionar el listado deja de mostrarse entero y pasa a
 *  revelarse solo por búsqueda. Con un catálogo grande, scrollear un listado eterno para
 *  encontrar una skill es peor que escribir dos letras — y las ya elegidas siguen a la
 *  vista igual, que es lo único que hay que poder revisar de un vistazo. */
const SEARCH_ONLY_THRESHOLD = 10;

interface SkillPickerStepProps {
  agentId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}

/** Elegir qué skills adjuntar a ESTA tab antes de lanzar el agente — a propósito es un
 * paso del wizard (no algo que se hace después desde Skills) porque los symlinks tienen
 * que existir en el cwd ANTES de que el proceso arranque: algunos agentes solo escanean
 * su carpeta de skills al boot, así que adjuntar después de lanzado no sirve. */
export function SkillPickerStep({ agentId, selected, onChange }: SkillPickerStepProps) {
  const { t } = useTranslation();
  const { skills, loadSkills } = useSkillsStore();
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const compatible = skills.filter(
    (s) => s.compatibleAgents.length === 0 || s.compatibleAgents.includes(agentId)
  );

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQuery = (s: (typeof compatible)[number]) => {
    if (!trimmedQuery) return true;
    const haystack = `${s.name} ${s.description ?? ""} ${s.categories.join(" ")}`.toLowerCase();
    return haystack.includes(trimmedQuery);
  };

  // Las elegidas van primero: son las que el usuario necesita poder repasar de un vistazo
  // antes de confirmar, y en un catálogo grande quedaban desparramadas entre el resto.
  const chosen = compatible.filter((s) => selected.includes(s.id));
  const rest = compatible.filter((s) => !selected.includes(s.id));

  // Con muchas sin elegir, el resto no se lista hasta que haya búsqueda. Las elegidas se
  // muestran siempre: esconderlas convertiría el selector en una caja negra.
  const searchOnly = rest.length > SEARCH_ONLY_THRESHOLD;
  const hiddenCount = searchOnly && !trimmedQuery ? rest.length : 0;

  const visible = [
    ...chosen.filter(matchesQuery),
    ...(hiddenCount > 0 ? [] : rest.filter(matchesQuery)),
  ];

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  if (skills.length === 0) {
    return <p className="text-xs text-gray-400 dark:text-white/30 italic">{t("wizard.step3.empty")}</p>;
  }

  if (compatible.length === 0) {
    return <p className="text-xs text-gray-400 dark:text-white/30 italic">{t("wizard.step3.noneCompatible")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400 dark:text-white/40">{t("wizard.step3.helper")}</p>

      {/* Buscador — con muchas skills instaladas, listarlas todas satura la UI del
          wizard/Home; filtrar por nombre/descripción/categoría lo mantiene manejable. */}
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

      {selected.length > 0 && (
        <p className="text-[11px] text-violet-500 dark:text-violet-400">
          {t("wizard.step3.selectedCount", { count: selected.length })}
        </p>
      )}

      {/* Sin este aviso, un catálogo grande se vería como "solo tengo estas": hay que
          decir cuántas quedaron fuera y cómo llegar a ellas. */}
      {hiddenCount > 0 && (
        <p className="text-[11px] text-gray-400 dark:text-white/40">
          {t("wizard.step3.searchToReveal", { count: hiddenCount })}
        </p>
      )}

      <div className="cc-scroll flex flex-col gap-1 max-h-56 pr-1">
        {visible.length === 0 && hiddenCount === 0 ? (
          <p className="text-xs text-gray-400 dark:text-white/30 italic py-2">
            {t("wizard.step3.searchEmpty")}
          </p>
        ) : visible.map((skill) => {
          const checked = selected.includes(skill.id);
          return (
            <label
              key={skill.id}
              className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors
                ${checked
                  ? "border-violet-500 bg-violet-50 dark:bg-violet-500/10"
                  : "border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/25"}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(skill.id)}
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm text-gray-800 dark:text-white/90 truncate">{skill.name}</span>
                {skill.description && (
                  <span className="block text-xs text-gray-400 dark:text-white/40 truncate">{skill.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
