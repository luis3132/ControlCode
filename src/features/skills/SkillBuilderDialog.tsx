import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, TextArea } from "neogestify-ui-components";

import { ViewModal } from "@/shared/ui/ViewModal";

import { useTabsStore } from "@/features/tabs/store";
import { useSkillsStore } from "@/features/skills/store";
import type { SkillSummary } from "@/features/skills/types";

/**
 * Constructor de skills: un formulario para escribir la propia sin pelearse con el YAML.
 *
 * La metadata va en campos y el cuerpo en un editor porque son dos cosas distintas: el
 * frontmatter es un formato con reglas (una coma de más y el archivo deja de parsear) y el
 * cuerpo es prosa para el agente. Quien quiera editar el YAML a mano igual puede: la skill
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
      <div className="flex flex-col gap-4 h-full">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t("skills.builder.subtitle")}</p>

        <Input
          label={t("skills.builder.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("skills.builder.namePlaceholder")}
          variant="outline"
          helperText={t("skills.builder.nameHelper")}
        />

        <Input
          label={t("skills.builder.description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("skills.builder.descriptionPlaceholder")}
          variant="outline"
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

        {/* El editor se queda con el alto que sobra: es lo que el usuario vino a
            escribir, y un alto fijo desperdiciaría la vista entera que ahora ocupa. */}
        <div className="flex flex-col gap-1.5 flex-1 min-h-0">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {t("skills.builder.body")}
          </span>
          <TextArea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("skills.builder.bodyPlaceholder")}
            variant="outline"
            className="font-mono text-sm h-full min-h-[12rem]"
          />
        </div>

        {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </ViewModal>
  );
}
