import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { useTheme } from "neogestify-ui-components";

import { changeGutter, setBaseline, type ChangeGutterLabels } from "./changeGutter";
import { editorTheme, languageFor } from "./codemirror";

/** Marca los cambios que no hizo el usuario (recargar desde disco): no ensucian la tab. */
const External = Annotation.define<boolean>();

export interface EditorHandle {
  getDoc: () => string;
  /** Reemplaza el contenido conservando cursor y scroll, sin marcarlo como cambio. */
  setDoc: (doc: string) => void;
  focus: () => void;
}

/**
 * Un editor de CodeMirror para una tab de archivo.
 *
 * El documento se pasa una vez, al montar; después se lee y se reemplaza por `handleRef`.
 * Pasarlo como prop controlada obligaría a copiar el archivo entero en cada tecla, y en un
 * archivo de miles de líneas eso se siente al escribir.
 */
export function CodeEditor({ path, doc, onDirty, onSave, reveal, handleRef, baseline, changeLabels }: {
  path: string;
  doc: string;
  onDirty: () => void;
  onSave: () => void;
  reveal?: { line: number; column: number; nonce: number };
  handleRef: React.RefObject<EditorHandle | null>;
  /** La versión de git contra la que se marcan los cambios al margen. `null` = sin marcas. */
  baseline?: string | null;
  changeLabels: ChangeGutterLabels;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeSlot = useRef(new Compartment());
  const languageSlot = useRef(new Compartment());
  const { theme } = useTheme();
  const callbacks = useRef({ onDirty, onSave });
  callbacks.current = { onDirty, onSave };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [
          basicSetup,
          // Después de `basicSetup`: la barra de cambios queda entre los números de línea y
          // el texto, como en VS Code.
          changeGutter(changeLabels),
          keymap.of([indentWithTab]),
          // Por encima de todo: Ctrl+S es guardar aunque CodeMirror o el navegador tengan
          // otra idea.
          Prec.highest(keymap.of([{
            key: "Mod-s",
            preventDefault: true,
            run: () => { callbacks.current.onSave(); return true; },
          }])),
          themeSlot.current.of(editorTheme(theme === "dark")),
          languageSlot.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) {
              callbacks.current.onDirty();
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    handleRef.current = {
      getDoc: () => view.state.doc.toString(),
      setDoc: (next) => {
        const { anchor } = view.state.selection.main;
        const scroll = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: Math.min(anchor, next.length) },
          annotations: External.of(true),
        });
        view.scrollDOM.scrollTop = scroll;
      },
      focus: () => view.focus(),
    };
    return () => {
      handleRef.current = null;
      viewRef.current = null;
      view.destroy();
    };
    // El editor se crea una sola vez; el contenido nuevo entra por `setDoc`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stale = false;
    languageFor(path).then((ext) => {
      if (!stale) viewRef.current?.dispatch({ effects: languageSlot.current.reconfigure(ext) });
    });
    return () => { stale = true; };
  }, [path]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeSlot.current.reconfigure(editorTheme(theme === "dark")) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setBaseline.of(baseline ?? null) });
  }, [baseline]);

  // Saltar a una línea (desde el buscador). Va por `nonce`: dos clicks en el mismo
  // resultado son dos pedidos, aunque la línea sea la misma.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    const pos = line.from + Math.min(reveal.column, line.length);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
