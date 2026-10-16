import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentsOf } from "@/features/canvas/actions";

import { exportDocPdf } from "./export";
import { useDocsStore, watchDoc } from "./store";

const MarkdownPreview = lazy(() => import("@/features/editor/MarkdownPreview"));

/**
 * Un documento Markdown en vivo, dentro de un nodo del canvas: lo que escribe un agente
 * aparece a medida que lo escribe, y si lo agregó al final la vista lo acompaña.
 *
 * `interactive: false` (el canvas con zoom) se ve igual pero no se desplaza: la rueda es del
 * canvas.
 */
export function DocView({ path, workspace, interactive }: { path: string; workspace: string; interactive: boolean }) {
  const { t } = useTranslation();
  const doc = useDocsStore((s) => s.texts[path]);
  const lastEdit = useDocsStore((s) => s.lastEdit[path]);
  const scroller = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const cwd = agentsOf(workspace)[0]?.cwd ?? workspace;

  useEffect(() => watchDoc(path), [path]);

  // Lo que un agente agrega al final se sigue, como una terminal.
  const text = doc && "text" in doc ? doc.text : null;
  useEffect(() => {
    if (!lastEdit || lastEdit.mode !== "append" || Date.now() - lastEdit.at > 5000) return;
    // La vista previa trae su propio scroll: es el primer hijo.
    const el = scroller.current?.firstElementChild;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  }, [text, lastEdit]);

  const exportPdf = async () => {
    setStatus(t("doc.exporting"));
    try {
      const out = await exportDocPdf(path, cwd);
      setStatus(t("doc.exported", { file: out.split(/[\\/]/).pop() }));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setStatus(null), 5000);
  };

  if (doc && "error" in doc) {
    return <div className="flex items-center justify-center h-full p-6 text-center text-xs text-red-600">{doc.error}</div>;
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-white dark:bg-surface">
      <div
        ref={scroller}
        className={`relative flex-1 min-h-0 ${interactive ? "nowheel" : "pointer-events-none"}`}
      >
        {text !== null && (
          <Suspense fallback={null}>
            <MarkdownPreview source={text} path={path} cwd={cwd} />
          </Suspense>
        )}
      </div>
      {interactive && (
        <div className="nodrag flex items-center gap-2 h-7 px-2 shrink-0 border-t border-gray-100 dark:border-white/8 text-[11px] text-gray-500 dark:text-white/45">
          <span className="flex-1 truncate">
            {status ?? (lastEdit ? t("doc.lastEdit", { who: lastEdit.by }) : "")}
          </span>
          <button
            onClick={() => void exportPdf()}
            className="px-2 h-5 rounded hover:bg-gray-100 dark:hover:bg-white/8 hover:text-gray-900 dark:hover:text-white"
          >
            {t("doc.exportPdf")}
          </button>
        </div>
      )}
    </div>
  );
}
