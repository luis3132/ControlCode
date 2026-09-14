import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { Alert, DocumentIcon, Tooltip, useTheme } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { scmFileAt } from "@/features/scm/ipc";
import { isScmError } from "@/features/scm/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import type { DiffView } from "@/features/tabs/viewTabs";

import { editorTheme, languageFor } from "./codemirror";
import { readFile } from "./ipc";

/**
 * Lo que cambió en un archivo, en una sola columna: lo quitado en rojo arriba de lo que
 * lo reemplazó.
 *
 * Unificado y no lado a lado a propósito. En una tab, dos columnas cortan cada línea larga
 * a la mitad; y la vista lado a lado de CodeMirror alinea las dos columnas con espaciadores
 * que se recalculan con cada medición de altura, un circuito que en el layout de la app
 * llegó a congelar la ventana.
 *
 * Dos diffs posibles, los mismos de git: lo preparado (HEAD → índice) y lo que falta
 * preparar (índice → disco). Las zonas sin cambios se pliegan; en un archivo de mil
 * líneas con tres tocadas, lo que interesa son esas tres.
 */
export function DiffTab({ view, active }: { view: DiffView; active: boolean }) {
  const { t } = useTranslation();
  const openFile = useViewTabsStore((s) => s.openFile);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const themeSlot = useRef(new Compartment());
  const [error, setError] = useState<string | null>(null);

  const abs = `${view.root}/${view.path}`;

  const load = useCallback(async () => {
    try {
      const [before, after, language] = await Promise.all([
        scmFileAt(view.root, view.path, view.staged ? "HEAD" : "INDEX"),
        view.staged
          ? scmFileAt(view.root, view.path, "INDEX")
          : readFile(abs).then((c) => (c.kind === "text" ? c.content : null)).catch(() => null),
        languageFor(view.path),
      ]);
      if (!host.current) return;
      editor.current?.destroy();
      editor.current = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: after ?? "",
          extensions: [
            lineNumbers(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            language,
            themeSlot.current.of(editorTheme(themeRef.current === "dark")),
            unifiedMergeView({
              original: before ?? "",
              highlightChanges: true,
              gutter: true,
              // Solo se mira: aceptar o revertir trozos se hace preparando o descartando
              // desde el panel, que es donde está el resto de las operaciones de git.
              mergeControls: false,
              collapseUnchanged: { margin: 3, minSize: 6 },
            }),
          ],
        }),
      });
      setError(null);
    } catch (e) {
      setError(isScmError(e) ? e.message : String(e));
    }
  }, [view.root, view.path, view.staged, abs]);

  // Al volver a la tab se recalcula: lo que falta preparar cambia cada vez que un agente
  // escribe, y un diff viejo engaña más que uno ausente.
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  useEffect(() => () => editor.current?.destroy(), []);

  useEffect(() => {
    editor.current?.dispatch({ effects: themeSlot.current.reconfigure(editorTheme(theme === "dark")) });
  }, [theme]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-[#0d1117]">
      <div className="flex items-center gap-2 h-8 shrink-0 pl-4 pr-2 border-b border-gray-200 dark:border-white/7">
        <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-white/40" title={abs}>
          {view.path}
        </span>
        <span className="shrink-0 px-1.5 rounded text-[10px] bg-gray-200 text-gray-600 dark:bg-white/8 dark:text-gray-400">
          {t(view.staged ? "editor.diff.staged" : "editor.diff.unstaged")}
        </span>
        <div className="flex-1" />
        <Tooltip content={t("explorer.refresh")} placement="bottom">
          <button onClick={load} aria-label={t("explorer.refresh")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <RefreshIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip content={t("scm.openFile")} placement="bottom">
          <button onClick={() => openFile(view.cwd, abs)} aria-label={t("scm.openFile")}
            className="cc-t flex items-center justify-center w-6 h-6 rounded-md
              text-gray-400 dark:text-white/35 hover:text-gray-700 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10">
            <DocumentIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
      {error && <div className="shrink-0 px-4 pt-3"><Alert variant="danger">{error}</Alert></div>}
      <div ref={host} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
