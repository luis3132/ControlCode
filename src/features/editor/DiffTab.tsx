import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { Alert, DocumentIcon, Tooltip, useTheme } from "neogestify-ui-components";

import { RefreshIcon } from "@/app/icons";
import { scmFileAt } from "@/features/scm/ipc";
import { isScmError } from "@/features/scm/types";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import type { DiffView } from "@/features/tabs/viewTabs";

import { editorTheme, languageFor } from "./codemirror";
import { readFile } from "./ipc";

/**
 * En el diff lado a lado scrollea el conjunto, no cada editor: los dos a altura natural y
 * el contenedor con la barra. El tema común les da `height: 100%` (es lo que necesita el
 * editor de archivos); con eso cada lado tenía su propio scroll, y los espaciadores que
 * alinean las dos columnas se recalculaban contra esas alturas en cada medición — un
 * circuito que llegó a congelar la ventana. Por eso esto va con la precedencia más alta.
 */
const naturalHeight = Prec.highest(EditorView.theme({
  "&": { height: "auto" },
  // Alto de línea en píxeles enteros. El del tema (13px × 1.6 = 20.8px) es fraccionario, y
  // cada lado lo redondea distinto: al alinearlos quedaba siempre un píxel de diferencia
  // que disparaba otra medición, y otra — medido en WebKitGTK, el margen oscilaba entre
  // 2245 y 2248px mil veces por segundo sin parar.
  ".cm-scroller": { overflow: "visible", lineHeight: "21px" },
  // El separador de "N líneas sin cambios" le dice a CodeMirror que mide 27px y con el
  // relleno de la librería medía 31. Esa diferencia hacía que cada lado corrigiera al otro
  // sin fin (medido en WebKitGTK: el margen saltando entre dos altos, mil cambios de DOM
  // por segundo sin tocar nada). Con el alto exacto, queda quieto.
  ".cm-collapsedLines": {
    height: "27px", lineHeight: "27px", padding: "0 5px 0 10px", boxSizing: "border-box", overflow: "hidden",
  },
}));

/**
 * Lo que cambió en un archivo, lado a lado como en VS Code: a la izquierda la versión
 * vieja, a la derecha la nueva, alineadas línea con línea y con lo cambiado resaltado.
 *
 * Tres diffs posibles, los mismos de git: lo preparado (HEAD → índice), lo que falta
 * preparar (índice → disco), y lo que cambió un commit (su padre → él, desde el historial).
 * Las zonas sin cambios se pliegan; en un archivo de mil líneas con tres tocadas, lo que
 * interesa son esas tres.
 */
export function DiffTab({ view, active }: { view: DiffView; active: boolean }) {
  const { t } = useTranslation();
  const openFile = useViewTabsStore((s) => s.openFile);
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);
  const themeSlots = useRef({ a: new Compartment(), b: new Compartment() });
  const [error, setError] = useState<string | null>(null);

  const abs = `${view.root}/${view.path}`;
  const beforeLabel = view.commit
    ? t("editor.diff.side.parent", { commit: view.commit.slice(0, 7) })
    : t(view.staged ? "editor.diff.side.head" : "editor.diff.side.index");
  const afterLabel = view.commit
    ? t("editor.diff.side.commit", { commit: view.commit.slice(0, 7) })
    : t(view.staged ? "editor.diff.side.index" : "editor.diff.side.disk");

  const load = useCallback(async () => {
    try {
      const [before, after, language] = await Promise.all([
        view.commit
          ? scmFileAt(view.root, view.origPath ?? view.path, `${view.commit}^`)
          : scmFileAt(view.root, view.path, view.staged ? "HEAD" : "INDEX"),
        view.commit
          ? scmFileAt(view.root, view.path, view.commit)
          : view.staged
            ? scmFileAt(view.root, view.path, "INDEX")
            : readFile(abs).then((c) => (c.kind === "text" ? c.content : null)).catch(() => null),
        languageFor(view.path),
      ]);
      if (!host.current) return;
      merge.current?.destroy();
      const dark = themeRef.current === "dark";
      const side = (slot: Compartment): Extension[] => [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        language,
        slot.of(editorTheme(dark)),
        naturalHeight,
      ];
      merge.current = new MergeView({
        parent: host.current,
        a: { doc: before ?? "", extensions: side(themeSlots.current.a) },
        b: { doc: after ?? "", extensions: side(themeSlots.current.b) },
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      });
      // El contenedor del MergeView es el que scrollea (ver `naturalHeight`).
      merge.current.dom.style.height = "100%";
      merge.current.dom.style.overflowY = "auto";
      setError(null);
    } catch (e) {
      setError(isScmError(e) ? e.message : String(e));
    }
  }, [view.root, view.path, view.staged, view.commit, view.origPath, abs]);

  // Al volver a la tab se recalcula: lo que falta preparar cambia cada vez que un agente
  // escribe, y un diff viejo engaña más que uno ausente.
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  useEffect(() => () => merge.current?.destroy(), []);

  useEffect(() => {
    const m = merge.current;
    if (!m) return;
    const next = editorTheme(theme === "dark");
    m.a.dispatch({ effects: themeSlots.current.a.reconfigure(next) });
    m.b.dispatch({ effects: themeSlots.current.b.reconfigure(next) });
  }, [theme]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 dark:bg-[#0d1117]">
      <div className="flex items-center gap-2 h-8 shrink-0 pl-4 pr-2 border-b border-gray-200 dark:border-white/7">
        <span className="min-w-0 truncate font-mono text-[11px] text-gray-500 dark:text-white/40" title={abs}>
          {view.path}
        </span>
        <span className="shrink-0 px-1.5 rounded text-[10px] bg-gray-200 text-gray-600 dark:bg-white/8 dark:text-gray-400">
          {view.commit
            ? t("editor.diff.commit", { commit: view.commit.slice(0, 7) })
            : t(view.staged ? "editor.diff.staged" : "editor.diff.unstaged")}
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
      {/* Qué es cada lado: sin esto no se sabe cuál es el viejo. */}
      <div className="grid grid-cols-2 shrink-0 h-6 border-b border-gray-200 dark:border-white/7
        text-[10.5px] text-gray-500 dark:text-white/40">
        <span className="px-4 leading-6 truncate border-r border-gray-200 dark:border-white/7">{beforeLabel}</span>
        <span className="px-4 leading-6 truncate">{afterLabel}</span>
      </div>
      <div ref={host} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}
