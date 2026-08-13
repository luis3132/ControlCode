import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimateSpin, Button, Input, Loading, TextArea } from "neogestify-ui-components";
import { CloudIcon, FolderIcon, InfoIcon, StackIcon } from "neogestify-ui-components";

import { useSkillsStore } from "@/features/skills/store";
import { PageHeader } from "@/shared/ui/PageHeader";

import { applyName } from "./frontmatter";

interface DetailMeta {
  version: string;
  categories: string[];
  compatibleAgents: string[];
  author: string | null;
  license: string | null;
  homepage: string | null;
  registryName: string | null;
}

export function SkillDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const getSkillDetail = useSkillsStore((s) => s.getSkillDetail);
  const updateSkillContent = useSkillsStore((s) => s.updateSkillContent);
  const forkSkill = useSkillsStore((s) => s.forkSkill);

  const [loading, setLoading] = useState(true);
  /** El nombre guardado, para saber si el usuario lo cambió. */
  const [savedName, setSavedName] = useState("");
  const [name, setName] = useState("");
  const [meta, setMeta] = useState<DetailMeta | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** Vino de un repositorio: guardarle encima sería escribir en algo que la app pisa al
   *  reinstalar, así que acá solo se puede guardar una copia propia. */
  const fromRegistry = meta?.registryName != null;

  const load = (skillId: string) =>
    getSkillDetail(skillId).then((detail) => {
      setSavedName(detail.name);
      setName(detail.name);
      setContent(detail.content);
      setMeta({
        version: detail.version,
        categories: detail.categories,
        compatibleAgents: detail.compatibleAgents,
        author: detail.author,
        license: detail.license,
        homepage: detail.homepage,
        registryName: detail.registryName,
      });
    });

  useEffect(() => {
    if (!id) return;
    load(id)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** Guarda encima. Solo para skills propias. */
  const save = async () => {
    if (!id) return;
    setSaving(true);
    setError("");
    try {
      // El nombre vive DENTRO del SKILL.md: si el usuario lo cambió en el campo, hay que
      // llevarlo al frontmatter, o al releer el archivo volvería el viejo.
      await updateSkillContent(id, applyName(content, name));
      await load(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Guarda como copia propia. Es el único camino para una skill de repositorio. */
  const saveAsCopy = async () => {
    if (!id) return;
    setSaving(true);
    setError("");
    try {
      // Sin nombre elegido va `null` y el backend le pone el sufijo — así el default vive
      // en un solo lado en vez de que cada llamador invente el suyo.
      const copy = await forkSkill(id, name !== savedName ? name : undefined, content);
      navigate(`/skills/${copy.id}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-full flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <Loading />
      </main>
    );
  }

  return (
    <main className="min-h-full px-6 py-10 bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto">
        <PageHeader icon={<StackIcon className="w-5 h-5" />} title={savedName} />

        {meta && (
          <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
            <span className="px-2 py-1 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-mono">
              v{meta.version}
            </span>
            <span
              className={`flex items-center gap-1 px-2 py-1 rounded-full
              ${
                meta.registryName
                  ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                  : "bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400"
              }`}
            >
              {meta.registryName ? (
                <CloudIcon className="w-3 h-3" />
              ) : (
                <FolderIcon className="w-3 h-3" />
              )}
              {meta.registryName ?? t("skills.list.localOrigin")}
            </span>
            {meta.author && (
              <span className="px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                {meta.author}
              </span>
            )}
            {meta.categories.map((c) => (
              <span
                key={c}
                className="px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
              >
                {c}
              </span>
            ))}
            {meta.compatibleAgents.map((a) => (
              <span
                key={a}
                className="px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                {a}
              </span>
            ))}
            {meta.license && (
              <span className="text-gray-400 dark:text-gray-500">{meta.license}</span>
            )}
            {meta.homepage && (
              <a
                href={meta.homepage}
                target="_blank"
                rel="noreferrer"
                className="text-blue-500 hover:underline truncate"
              >
                {meta.homepage}
              </a>
            )}
          </div>
        )}

        {/* Se dice ANTES de escribir, no al guardar: enterarte de que tus cambios van a
            otra skill recién cuando apretás el botón es enterarte tarde. */}
        {fromRegistry && (
          <div
            className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg text-xs
              bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            <InfoIcon className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{t("skills.detail.fromRegistryNote", { registry: meta?.registryName })}</p>
          </div>
        )}

        <div className="mb-3">
          <Input
            label={t("skills.detail.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            variant="outline"
          />
        </div>

        <TextArea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          variant="outline"
          autoResize
          showCount
          className="font-mono text-sm min-h-[50vh]"
        />

        {error && <p className="text-sm text-red-500 dark:text-red-400 mt-3">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          {/* Para una skill propia el usuario elige: guardar encima o sacar una copia y
              seguir por ahí. Para una de repositorio solo existe la copia. */}
          {!fromRegistry && (
            <Button
              variant="primary"
              disabled={saving}
              onClick={save}
              leftIcon={saving ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
            >
              {t("skills.detail.save")}
            </Button>
          )}
          <Button
            variant={fromRegistry ? "primary" : "outline"}
            disabled={saving}
            onClick={saveAsCopy}
            leftIcon={saving ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {t("skills.detail.saveAsCopy")}
          </Button>
        </div>
      </div>
    </main>
  );
}
