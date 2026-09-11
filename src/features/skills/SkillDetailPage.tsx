import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AnimateSpin,
  ArrowLeftIcon,
  Badge,
  Button,
  CloudIcon,
  FolderIcon,
  InfoIcon,
  Loading,
  StackIcon,
  Tooltip,
} from "neogestify-ui-components";

import { useSkillsStore } from "@/features/skills/store";

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
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  /** Vino de un repositorio: guardarle encima sería escribir en algo que la app pisa al
   *  reinstalar, así que acá solo se puede guardar una copia propia. */
  const fromRegistry = meta?.registryName != null;
  const dirty = content !== savedContent || name !== savedName;

  const load = (skillId: string) =>
    getSkillDetail(skillId).then((detail) => {
      setSavedName(detail.name);
      setName(detail.name);
      setContent(detail.content);
      setSavedContent(detail.content);
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
      <div className="flex h-full items-center justify-center">
        <Loading />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ══ encabezado: volver + el nombre, editable en su sitio ══════════ */}
      <div className="flex items-center gap-3 h-[54px] shrink-0 pl-4 pr-14
        border-b border-gray-200 dark:border-white/8">
        <Tooltip content={t("skills.detail.back")} placement="bottom">
          <button
            onClick={() => navigate("/skills")}
            aria-label={t("skills.detail.back")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md shrink-0
              text-gray-400 dark:text-white/35
              hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <ArrowLeftIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <StackIcon className="w-[15px] h-[15px] shrink-0 text-violet-500 dark:text-violet-400" />
        {/* El nombre se edita donde se lee: un campo aparte repetiría el título dos veces
            en la misma pantalla. */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("skills.detail.name")}
          className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] font-bold
            text-gray-900 dark:text-white
            border-b border-transparent focus:border-blue-400"
        />
        {dirty && (
          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">
            {t("skills.detail.unsaved")}
          </span>
        )}
      </div>

      {/* ══ la ficha ══════════════════════════════════════════════════════ */}
      {meta && (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 px-4 py-1.5
          border-b border-gray-200 dark:border-white/8
          bg-gray-100/40 dark:bg-white/2">
          <span className="font-mono text-[10px] text-gray-400 dark:text-white/35">
            v{meta.version}
          </span>
          <span className={`flex items-center gap-1 shrink-0 px-1.5 rounded-full text-[9.5px]
            ${meta.registryName
              ? "bg-violet-500/12 text-violet-600 dark:text-violet-400"
              : "bg-gray-200/70 dark:bg-white/10 text-gray-500 dark:text-white/40"}`}>
            {meta.registryName
              ? <CloudIcon className="w-2.5 h-2.5" />
              : <FolderIcon className="w-2.5 h-2.5" />}
            {meta.registryName ?? t("skills.list.localOrigin")}
          </span>
          {meta.author && <Badge variant="info" size="sm">{meta.author}</Badge>}
          {meta.categories.map((c) => (
            <Badge key={c} variant="neutral" size="sm">{c}</Badge>
          ))}
          {meta.compatibleAgents.map((a) => (
            <Badge key={a} variant="success" size="sm">{a}</Badge>
          ))}
          <div className="flex-1" />
          {meta.license && (
            <span className="text-[10px] text-gray-400 dark:text-white/30">{meta.license}</span>
          )}
          {meta.homepage && (
            <a
              href={meta.homepage}
              target="_blank"
              rel="noreferrer"
              className="max-w-[14rem] truncate text-[10px] text-blue-500 dark:text-blue-400 hover:underline"
            >
              {meta.homepage}
            </a>
          )}
        </div>
      )}

      {/* Se dice ANTES de escribir, no al guardar: enterarte de que tus cambios van a
          otra skill recién cuando apretás el botón es enterarte tarde. */}
      {fromRegistry && (
        <div className="flex items-start gap-2 shrink-0 px-4 py-2
          border-b border-amber-200/70 dark:border-amber-500/15
          bg-amber-50 dark:bg-amber-500/8
          text-[11px] text-amber-700 dark:text-amber-300/90">
          <InfoIcon className="w-3.5 h-3.5 mt-px shrink-0" />
          <p>{t("skills.detail.fromRegistryNote", { registry: meta?.registryName })}</p>
        </div>
      )}

      {/* ══ el SKILL.md ═══════════════════════════════════════════════════ */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        className="flex-1 min-h-0 w-full resize-none cc-scroll px-4 py-3
          bg-transparent outline-none
          font-mono text-[12.5px] leading-relaxed
          text-gray-800 dark:text-gray-200"
      />

      {error && <div className="shrink-0 px-4 pb-2"><Alert variant="danger">{error}</Alert></div>}

      <div className="flex items-center gap-2 h-[42px] shrink-0 px-4
        border-t border-gray-200 dark:border-white/8
        bg-gray-100/60 dark:bg-black/20">
        <span className="flex-1 min-w-0 truncate text-[10.5px] tabular-nums
          text-gray-400 dark:text-white/35">
          {t("skills.detail.chars", { n: content.length })}
        </span>
        {/* Para una skill propia el usuario elige: guardar encima o sacar una copia y
            seguir por ahí. Para una de repositorio solo existe la copia. */}
        {!fromRegistry && (
          <Button
            variant="primary"
            size="sm"
            disabled={saving}
            onClick={save}
            leftIcon={saving ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
          >
            {t("skills.detail.save")}
          </Button>
        )}
        <Button
          variant={fromRegistry ? "primary" : "outline"}
          size="sm"
          disabled={saving}
          onClick={saveAsCopy}
          leftIcon={saving ? <AnimateSpin className="w-3.5 h-3.5" /> : undefined}
        >
          {t("skills.detail.saveAsCopy")}
        </Button>
      </div>
    </div>
  );
}
