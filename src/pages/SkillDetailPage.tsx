import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, TextArea, Loading } from "neogestify-ui-components";
import { BackIcon } from "neogestify-ui-components";
import { useSkillsStore } from "../store/skills";

export function SkillDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { getSkillDetail, updateSkillContent } = useSkillsStore();
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [meta, setMeta] = useState<{
    version: string; categories: string[]; compatibleAgents: string[];
    author: string | null; license: string | null; homepage: string | null;
  } | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getSkillDetail(id).then((detail) => {
      setName(detail.name);
      setContent(detail.content);
      setMeta({
        version: detail.version,
        categories: detail.categories,
        compatibleAgents: detail.compatibleAgents,
        author: detail.author,
        license: detail.license,
        homepage: detail.homepage,
      });
    }).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, [id, getSkillDetail]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setError("");
    try {
      await updateSkillContent(id, content);
      const detail = await getSkillDetail(id);
      setName(detail.name);
      setMeta({
        version: detail.version,
        categories: detail.categories,
        compatibleAgents: detail.compatibleAgents,
        author: detail.author,
        license: detail.license,
        homepage: detail.homepage,
      });
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
        <div className="flex items-center gap-3 mb-6">
          <Button variant="icon" onClick={() => navigate("/skills")} title={t("btn.back")}>
            <BackIcon className="w-4 h-4" />
          </Button>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white truncate">{name}</h2>
        </div>

        {meta && (
          <div className="flex flex-wrap items-center gap-2 mb-6 text-xs">
            <span className="px-2 py-1 rounded bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 font-mono">
              v{meta.version}
            </span>
            {meta.categories.map((c) => (
              <span key={c} className="px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                {c}
              </span>
            ))}
            {meta.compatibleAgents.map((a) => (
              <span key={a} className="px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                {a}
              </span>
            ))}
            {meta.author && <span className="text-gray-400 dark:text-gray-500">{t("skills.detail.author")}: {meta.author}</span>}
            {meta.license && <span className="text-gray-400 dark:text-gray-500">{meta.license}</span>}
            {meta.homepage && (
              <a href={meta.homepage} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline truncate">
                {meta.homepage}
              </a>
            )}
          </div>
        )}

        <TextArea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          variant="outline"
          autoResize
          showCount
          className="font-mono text-sm min-h-[50vh]"
        />

        {error && <p className="text-sm text-red-500 dark:text-red-400 mt-3">{error}</p>}

        <div className="flex justify-end mt-4">
          <Button variant="primary" disabled={saving} onClick={handleSave}>
            {t("skills.detail.save")}
          </Button>
        </div>
      </div>
    </main>
  );
}
