import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, TextArea } from "neogestify-ui-components";

import { ViewModal } from "@/shared/ui/ViewModal";

import { useTabsStore } from "@/features/tabs/store";
import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";

/** Encabezado de columna. Mismo tratamiento que el sidebar del Marketplace. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[11px] font-semibold uppercase tracking-wide
        text-gray-500 dark:text-gray-400"
    >
      {children}
    </span>
  );
}

/**
 * Constructor de skills.
 *
 * ## Por qué dos columnas
 *
 * Un SKILL.md son dos cosas de naturaleza distinta: una ficha de campos cortos (nombre,
 * descripción, categorías) y un documento con las instrucciones que lee el agente. En una
 * sola columna a todo el ancho de la vista, los campos quedaban estirados a 1400px —un
 * input de texto tan ancho es incómodo de leer y de completar— y el editor, que es lo
 * único que sí aprovecha el espacio, quedaba aplastado al final.
 *
 * Así el ancho se lo lleva quien lo necesita: la ficha queda en un riel de ancho fijo y
 * legible, y el editor ocupa todo lo demás. En pantallas angostas se apilan.
 *
 * La metadata va en campos y no en el YAML crudo porque son formatos con reglas: una coma
 * de más y el archivo deja de parsear. Quien quiera editarlo a mano igual puede — la skill
 * creada se abre en el detalle, que muestra el SKILL.md entero.
 */
export function SkillBuilderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (skill: SkillSummary) => void;
}) {
  const { t } = useTranslation();
  const createSkill = useSkillsStore((s) => s.createSkill);
  const detectedAgents = useTabsStore((s) => s.detectedAgents);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [agents, setAgents] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggleAgent = (id: string) =>
    setAgents((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));

  const canCreate = name.trim() !== "" && !saving;

  const create = async () => {
    setSaving(true);
    setError("");
    try {
      const skill = await createSkill({
        meta: {
          name: name.trim(),
          description: description.trim() || null,
          version: "0.1.0",
          categories: categories
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          // Sin agentes elegidos la skill aplica a TODOS: es lo que espera quien no se
          // puso a pensar en compatibilidad, y restringirla por omisión la escondería.
          compatibleAgents: agents,
          compatibleVersions: {},
          author: null,
          license: null,
          homepage: null,
        },
        body,
      });
      onCreated(skill);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ViewModal
      title={t("skills.builder.title")}
      onClose={onClose}
      // Ocupa la vista entera: es un editor, no una confirmación de dos líneas.
      fill
      footer={
        <>
          {/* El error vive en el pie, al lado del botón que lo produjo, en vez de al final
              de una columna que puede estar scrolleada fuera de vista. */}
          {error && (
            <p className="flex-1 text-sm text-red-500 dark:text-red-400 self-center truncate" title={error}>
              {error}
            </p>
          )}
          <Button variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!canCreate}
            onClick={create}
            leftIcon={saving ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {t("skills.builder.create")}
          </Button>
        </>
      }
    >
      <div className="h-full flex flex-col lg:flex-row gap-6">
        {/* ── La ficha ─────────────────────────────────────────
            Ancho fijo y legible: son campos cortos, y estirarlos no los mejora. */}
        <section
          className="w-full lg:w-[21rem] xl:w-[23rem] shrink-0
            flex flex-col gap-4 lg:overflow-y-auto lg:pr-1"
        >
          <div className="flex flex-col gap-1">
            <SectionLabel>{t("skills.builder.section.details")}</SectionLabel>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {t("skills.builder.subtitle")}
            </p>
          </div>

          {/* `required` marca el campo con un asterisco: es el único obligatorio, y sin
              él el botón de crear queda deshabilitado sin decir por qué. */}
          <Input
            label={t("skills.builder.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("skills.builder.namePlaceholder")}
            variant="outline"
            required
            helperText={t("skills.builder.nameHelper")}
          />

          {/* Área y no input de una línea: una descripción útil son una o dos frases, y es
              el campo del que depende que el agente la use. */}
          <TextArea
            label={t("skills.builder.description")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("skills.builder.descriptionPlaceholder")}
            variant="outline"
            rows={3}
            resize="none"
            helperText={t("skills.builder.descriptionHelper")}
          />

          <Input
            label={t("skills.builder.categories")}
            value={categories}
            onChange={(e) => setCategories(e.target.value)}
            placeholder="git, testing"
            variant="outline"
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t("skills.builder.agents")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {detectedAgents
                .filter((a) => a.id !== "bash")
                .map((a) => (
                  <Button
                    key={a.id}
                    variant={agents.includes(a.id) ? "primary" : "outline"}
                    onClick={() => toggleAgent(a.id)}
                    className="!text-xs"
                  >
                    {a.label}
                  </Button>
                ))}
            </div>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {t("skills.builder.agentsHelper")}
            </span>
          </div>
        </section>

        {/* ── El documento ─────────────────────────────────────
            Se queda con todo el ancho y el alto que sobran: es lo que el usuario vino a
            escribir, y lo único acá que mejora cuanto más espacio tiene. */}
        <section className="flex-1 min-h-0 flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <SectionLabel>{t("skills.builder.body")}</SectionLabel>
            <span className="text-xs text-gray-400 dark:text-gray-500 truncate">
              {t("skills.builder.bodyHint")}
            </span>
          </div>
          {/* `TextArea` envuelve el campo en un div propio, así que estirarlo hasta el
              fondo pide alcanzar ESE div: por eso el variante `[&>div]`. Sin esto el
              editor mide lo que diga `rows` y deja el resto de la vista vacío. */}
          <div className="flex-1 min-h-0 [&>div]:h-full [&>div]:flex [&>div]:flex-col">
            <TextArea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("skills.builder.bodyPlaceholder")}
              variant="outline"
              resize="none"
              className="font-mono text-sm flex-1 min-h-0 leading-relaxed"
            />
          </div>
        </section>
      </div>
    </ViewModal>
  );
}
