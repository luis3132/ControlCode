import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Alert, Button, DocumentIcon, EmptyState, FolderIcon, SaveIcon, SegmentedControl, Skeleton, Tooltip,
} from "neogestify-ui-components";

import { useViewTabsStore } from "@/features/tabs/viewStore";
import { relativeTo, type FileView } from "@/features/tabs/viewTabs";

import { CodeEditor, type EditorHandle } from "./CodeEditor";
import { fileStat, readFile, writeFile, type FileContent } from "./ipc";
import { isMarkdownPath, rememberMarkdownPreview } from "./markdown";

// Diferida: el render de Markdown (con su parser de HTML) solo se baja la primera vez que
// alguien pide una vista previa, no en el arranque de la app.
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

/** Cada cuánto se mira si otro cambió el archivo. Solo en la tab visible. */
const WATCH_MS = 2000;

type Banner = "changed" | "conflict" | "deleted" | null;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Un archivo abierto como tab.
 *
 * El disco manda: los agentes escriben ahí todo el tiempo. Mientras la tab está a la vista
 * se vigila el archivo; si cambió y no hay nada sin guardar, se recarga solo. Si hay
 * cambios sin guardar no se pisa nada — se avisa, y guardar pide confirmación explícita
 * para sobrescribir lo que escribió otro.
 */
export function FileTab({ view, active }: { view: FileView; active: boolean }) {
  const { t } = useTranslation();
  const updateView = useViewTabsStore((s) => s.updateView);
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorHandle | null>(null);
  const mtime = useRef<number | null>(null);
  const dirty = useRef(false);
  /** Un cambio en disco que el usuario ya decidió ignorar: no se vuelve a avisar. */
  const ignoredMtime = useRef<number | null>(null);

  const markdown = isMarkdownPath(view.path);
  const preview = markdown && !!view.preview && content?.kind === "text";
  const previewRef = useRef(preview);
  previewRef.current = preview;
  /** El texto que muestra la vista previa: el del editor, con lo que no se guardó. */
  const [previewSource, setPreviewSource] = useState<string | null>(null);

  const setDirty = useCallback((next: boolean) => {
    if (dirty.current === next) return;
    dirty.current = next;
    updateView(view.id, { dirty: next });
  }, [updateView, view.id]);

  const load = useCallback(async (intoEditor: boolean) => {
    const next = await readFile(view.path);
    if (next.kind === "text") {
      mtime.current = next.mtime;
      if (intoEditor && editor.current) editor.current.setDoc(next.content);
      else setContent(next);
      // Un agente reescribió el documento mientras se lee: la vista previa lo acompaña.
      if (previewRef.current) setPreviewSource(next.content);
    } else {
      setContent(next);
    }
    setDirty(false);
    setBanner(null);
    setError(null);
  }, [view.path, setDirty]);

  useEffect(() => {
    load(false).catch((e) => setError(String(e)));
  }, [load]);

  const save = useCallback(async (overwrite = false) => {
    if (!editor.current || saving) return;
    setSaving(true);
    try {
      const outcome = await writeFile(view.path, editor.current.getDoc(), overwrite ? null : mtime.current);
      if (outcome.kind === "conflict") {
        setBanner("conflict");
      } else {
        mtime.current = outcome.mtime;
        ignoredMtime.current = null;
        setDirty(false);
        setBanner(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [saving, view.path, setDirty]);

  useEffect(() => {
    if (!active || content?.kind !== "text") return;
    const id = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const stat = await fileStat(view.path).catch(() => undefined);
      if (stat === undefined) return;
      if (stat === null) {
        setBanner("deleted");
        return;
      }
      if (mtime.current === null || stat.mtime === mtime.current || stat.mtime === ignoredMtime.current) return;
      if (dirty.current) setBanner((b) => (b === "conflict" ? b : "changed"));
      else load(true).catch((e) => setError(String(e)));
    }, WATCH_MS);
    return () => clearInterval(id);
  }, [active, content?.kind, view.path, load]);

  // Volver a la tab es para escribir en ella. En vista previa no: el editor está debajo, y
  // lo que se tipeara iría a un documento que no se ve.
  useEffect(() => {
    if (!active || preview) return;
    const frame = requestAnimationFrame(() => editor.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [active, preview]);

  // Al pasar a la vista previa se toma lo que hay en el editor en ese momento.
  useEffect(() => {
    if (!preview) return;
    setPreviewSource(editor.current?.getDoc() ?? (content?.kind === "text" ? content.content : ""));
    // `content` queda afuera: solo importa al entrar; los cambios de disco llegan por `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // Un salto a una línea (desde el buscador) es para ver el código.
  useEffect(() => {
    if (view.reveal && view.preview) updateView(view.id, { preview: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.reveal?.nonce]);

  const setMode = (mode: string) => {
    const next = mode === "preview";
    rememberMarkdownPreview(next);
    updateView(view.id, { preview: next });
    if (!next) requestAnimationFrame(() => editor.current?.focus());
  };

  const rel = relativeTo(view.path, view.cwd);

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-[#0d1117]">
      <div className="flex items-center gap-2 h-8 shrink-0 pl-4 pr-2 border-b border-gray-200 dark:border-white/7">
        <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-white/40" title={view.path}>
          {rel}
        </span>
        {markdown && content?.kind === "text" && (
          <SegmentedControl
            size="sm"
            aria-label={t("editor.view.label")}
            value={preview ? "preview" : "code"}
            onChange={setMode}
            options={[
              { value: "code", label: t("editor.view.code") },
              { value: "preview", label: t("editor.view.preview") },
            ]}
          />
        )}
        {view.dirty && (
          <Button size="sm" variant="primary" onClick={() => save()} disabled={saving}>
            <SaveIcon className="w-3.5 h-3.5" />
            {t("editor.save")}
          </Button>
        )}
        <Tooltip content={t("explorer.reveal")} placement="bottom">
          <button
            onClick={() => revealItemInDir(view.path).catch(console.error)}
            aria-label={t("explorer.reveal")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white
              hover:bg-gray-200 dark:hover:bg-white/10"
          >
            <FolderIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      {banner && (
        <div className="flex items-center gap-2 shrink-0 px-4 py-1.5 text-[11.5px]
          bg-amber-50 text-amber-800 border-b border-amber-200
          dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/20">
          <span className="flex-1 min-w-0">{t(`editor.banner.${banner}`)}</span>
          {banner !== "deleted" && (
            <Button size="sm" variant="outline" onClick={() => load(true).catch((e) => setError(String(e)))}>
              {t("editor.reload")}
            </Button>
          )}
          {banner === "conflict" && (
            <Button size="sm" variant="danger" onClick={() => save(true)}>{t("editor.overwrite")}</Button>
          )}
          {banner === "changed" && (
            <Button size="sm" variant="ghost" onClick={async () => {
              const stat = await fileStat(view.path).catch(() => null);
              ignoredMtime.current = stat?.mtime ?? null;
              setBanner(null);
            }}>
              {t("editor.keepMine")}
            </Button>
          )}
        </div>
      )}

      {error && <div className="shrink-0 px-4 pt-3"><Alert variant="danger">{error}</Alert></div>}

      <div className="relative flex-1 min-h-0">
        {content === null ? (
          !error && (
            <div className="flex flex-col gap-2 p-5">
              {[40, 65, 55, 70, 30].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
            </div>
          )
        ) : content.kind === "text" ? (
          <CodeEditor
            path={view.path}
            doc={content.content}
            onDirty={() => setDirty(true)}
            onSave={() => save()}
            reveal={view.reveal}
            handleRef={editor}
          />
        ) : content.kind === "image" ? (
          <div className="flex items-center justify-center h-full p-6 overflow-auto
            bg-[length:20px_20px] bg-[repeating-conic-gradient(rgba(127,127,127,0.12)_0_25%,transparent_0_50%)]">
            <img src={content.dataUrl} alt={view.title} className="max-w-full max-h-full object-contain shadow-lg" />
          </div>
        ) : (
          <EmptyState
            className="m-auto pt-16"
            icon={<DocumentIcon className="w-8 h-8" />}
            title={t(content.kind === "binary" ? "editor.binary" : "editor.tooLarge")}
            description={formatBytes(content.size)}
            action={
              <Button size="sm" variant="outline" onClick={() => openPath(view.path).catch(console.error)}>
                {t("editor.openExternal")}
              </Button>
            }
          />
        )}
        {/* Encima del editor, que sigue montado debajo: al volver a Código están el deshacer,
            el cursor y el scroll como se dejaron. */}
        {preview && (
          <div className="absolute inset-0">
            <Suspense fallback={<PreviewSkeleton />}>
              <MarkdownPreview source={previewSource ?? content.content} path={view.path} cwd={view.cwd} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="flex flex-col gap-2 h-full p-8 bg-white dark:bg-[#0d1117]">
      {[35, 80, 70, 75, 45].map((w, i) => <Skeleton key={i} variant="text" height={12} width={`${w}%`} />)}
    </div>
  );
}
