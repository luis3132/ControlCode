import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { agentsOf } from "@/features/canvas/actions";
import { CodeEditor, type EditorHandle } from "@/features/editor/CodeEditor";
import { writeFile } from "@/features/editor/ipc";

import { exportDocPdf } from "./export";
import { setDocText, useDocsStore, watchDoc } from "./store";

const MarkdownPreview = lazy(() => import("@/features/editor/MarkdownPreview"));

type Mode = "view" | "edit" | "split";

/** Cuánto se espera sin escribir antes de guardar. */
const SAVE_MS = 700;

/**
 * Un documento Markdown dentro de un nodo del canvas: se lee, se edita o las dos cosas lado
 * a lado. Lo que escribe un agente aparece a medida que lo escribe (y si lo agregó al final
 * la vista lo acompaña); lo que escribe el usuario se guarda solo, al dejar de escribir.
 *
 * Si los dos escriben a la vez gana nadie en silencio: guardar con el archivo cambiado por
 * otro avisa, y el usuario elige recargar o pisarlo.
 *
 * `interactive: false` (el canvas con zoom) solo lo muestra: la rueda es del canvas.
 */
export function DocView({ path, workspace, interactive }: { path: string; workspace: string; interactive: boolean }) {
  const { t } = useTranslation();
  const doc = useDocsStore((s) => s.texts[path]);
  const lastEdit = useDocsStore((s) => s.lastEdit[path]);
  const scroller = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const editing = interactive && mode !== "view";
  const cwd = agentsOf(workspace)[0]?.cwd ?? workspace;

  const editor = useRef<EditorHandle | null>(null);
  /** El texto con el que se abrió el editor (se pasa una sola vez, al montarlo). */
  const [editorDoc, setEditorDoc] = useState<string | null>(null);
  /** Lo que muestra la vista previa al lado del editor: lo que se está escribiendo. */
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  const mtime = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => watchDoc(path), [path]);

  const text = doc && "text" in doc ? doc.text : null;
  const diskMtime = doc && "mtime" in doc ? doc.mtime : null;

  // Al entrar a editar, el editor arranca con lo que hay en disco.
  useEffect(() => {
    if (!editing) {
      setEditorDoc(null);
      setDraft(null);
      return;
    }
    if (editorDoc === null && text !== null) {
      setEditorDoc(text);
      mtime.current = diskMtime;
    }
  }, [editing, editorDoc, text, diskMtime]);

  // Lo que cambia en disco (un agente) entra al editor si no hay nada sin guardar.
  useEffect(() => {
    if (!editing || text === null || diskMtime === null || diskMtime === mtime.current) return;
    if (dirty.current) {
      setConflict(true);
      return;
    }
    editor.current?.setDoc(text);
    mtime.current = diskMtime;
    setDraft(null);
  }, [editing, text, diskMtime]);

  const save = useCallback(async (overwrite = false) => {
    const current = editor.current?.getDoc();
    if (current === undefined) return;
    const outcome = await writeFile(path, current, overwrite ? null : mtime.current);
    if (outcome.kind === "conflict") {
      setConflict(true);
      return;
    }
    mtime.current = outcome.mtime;
    dirty.current = false;
    setConflict(false);
    setDocText(path, current, outcome.mtime);
  }, [path]);

  const onChange = useCallback(() => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDraft(editor.current?.getDoc() ?? null);
      save().catch((e) => setStatus(String(e)));
    }, SAVE_MS);
  }, [save]);

  // Al salir de editar (o desmontar) se guarda lo pendiente.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (dirty.current) save().catch(console.error);
  }, [editing, save]);

  // Lo que un agente agrega al final se sigue, como una terminal.
  useEffect(() => {
    if (!lastEdit || lastEdit.mode !== "append" || Date.now() - lastEdit.at > 5000) return;
    const el = scroller.current?.firstElementChild;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
  }, [text, lastEdit]);

  const exportPdf = async () => {
    setStatus(t("doc.exporting"));
    try {
      if (dirty.current) await save();
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

  const preview = (source: string) => (
    <Suspense fallback={null}>
      <MarkdownPreview source={source} path={path} cwd={cwd} />
    </Suspense>
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-white dark:bg-surface">
      {conflict && editing && (
        <div className="nodrag flex items-center gap-2 px-3 py-1.5 shrink-0 text-[11px] bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="flex-1">{t("doc.conflict")}</span>
          <button className="px-2 h-5 rounded hover:bg-amber-100 dark:hover:bg-amber-500/20" onClick={() => {
            dirty.current = false;
            setConflict(false);
            if (text !== null) editor.current?.setDoc(text);
            mtime.current = diskMtime;
            setDraft(null);
          }}>{t("doc.reload")}</button>
          <button className="px-2 h-5 rounded hover:bg-amber-100 dark:hover:bg-amber-500/20" onClick={() => void save(true)}>{t("doc.keepMine")}</button>
        </div>
      )}
      <div ref={scroller} className={`relative flex flex-1 min-h-0 ${interactive ? "nowheel" : "pointer-events-none"}`}>
        {editing && editorDoc !== null && (
          <div className={`relative min-w-0 ${mode === "split" ? "w-1/2 border-r border-gray-200 dark:border-white/8" : "flex-1"}`}>
            <CodeEditor
              path={path}
              doc={editorDoc}
              onDirty={onChange}
              onSave={() => void save()}
              handleRef={editor}
              changeLabels={{ before: "", revert: "", close: "", added: "" }}
            />
          </div>
        )}
        {(!editing || mode === "split") && text !== null && (
          <div className="relative flex-1 min-w-0">{preview(mode === "split" && draft !== null ? draft : text)}</div>
        )}
      </div>
      {interactive && (
        <div className="nodrag flex items-center gap-1 h-7 px-2 shrink-0 border-t border-gray-100 dark:border-white/8 text-[11px] text-gray-500 dark:text-white/45">
          {(["view", "edit", "split"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 h-5 rounded ${mode === m
                ? "bg-accent-500/12 text-accent-700 dark:text-accent-200"
                : "hover:bg-gray-100 dark:hover:bg-white/8 hover:text-gray-900 dark:hover:text-white"}`}
            >
              {t(`doc.mode.${m}`)}
            </button>
          ))}
          <span className="flex-1 truncate px-2">
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
