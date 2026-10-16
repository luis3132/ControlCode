import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import type { DeckSize } from "./deck";
import { composedSlideWithRefs, saveSlideBody } from "./store";

/** Cuánto se espera sin escribir antes de guardar la hoja. */
const SAVE_MS = 600;

export interface EditableSlideHandle {
  /** Un comando de formato sobre lo seleccionado (`bold`, `formatBlock`…). */
  exec: (command: string, value?: string) => void;
  /** Mete una imagen donde está el cursor. `ref` es la ruta que se guarda; `data`, cómo se ve. */
  insertImage: (ref: string, data: string) => void;
}

/**
 * Una hoja que se edita escribiendo sobre ella: un click en un texto y se cambia, como en
 * cualquier editor de presentaciones. Lo que se escribe se guarda solo, en el cuerpo del
 * HTML de la hoja, con las imágenes otra vez como rutas.
 *
 * El iframe deja leer su documento (`allow-same-origin`) pero sigue sin scripts: lo que haya
 * escrito un agente no corre ni acá.
 */
export const EditableSlide = forwardRef<EditableSlideHandle, {
  dir: string;
  name: string;
  size: DeckSize;
  box: { width: number; height: number };
}>(function EditableSlide({ dir, name, size, box }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const refs = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);

  // Se compone una vez por hoja: recomponer con cada guardado recargaría el iframe y se
  // perdería el cursor en medio de una palabra.
  useEffect(() => {
    let alive = true;
    setHtml(null);
    composedSlideWithRefs(dir, name).then((entry) => {
      if (!alive || !entry) return;
      refs.current = new Map(entry.refs);
      setHtml(entry.html);
    }, console.error);
    return () => {
      alive = false;
    };
  }, [dir, name]);

  const save = () => {
    const body = frame.current?.contentDocument?.body;
    if (!body || !pending.current) return;
    pending.current = false;
    const clone = body.cloneNode(true) as HTMLElement;
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("spellcheck");
    saveSlideBody(dir, name, clone.innerHTML, refs.current).catch(console.error);
  };

  // Lo pendiente se guarda al cambiar de hoja o al salir de editar.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    save();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, name]);

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    doc.body.contentEditable = "true";
    doc.body.spellcheck = true;
    // Que se note qué se puede tocar, sin cambiar cómo se ve la hoja.
    const style = doc.createElement("style");
    style.setAttribute("data-cc-editor", "");
    style.textContent = "body:focus{outline:none} body *:hover{outline:1px dashed rgba(37,99,235,.45);outline-offset:2px}";
    doc.head.appendChild(style);
    doc.addEventListener("input", () => {
      pending.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, SAVE_MS);
    });
  };

  useImperativeHandle(ref, () => ({
    exec: (command, value) => {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      frame.current?.contentWindow?.focus();
      doc.execCommand(command, false, value);
      pending.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, SAVE_MS);
    },
    insertImage: (path, data) => {
      refs.current.set(path, data);
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      frame.current?.contentWindow?.focus();
      doc.execCommand("insertHTML", false, `<img src="${data}" alt="">`);
      pending.current = true;
      save();
    },
  }));

  const scale = Math.min(box.width / size.w, box.height / size.h) || 0;
  const width = size.w * scale;
  const height = size.h * scale;

  return (
    <div
      className="absolute overflow-hidden shadow-lg ring-2 ring-accent-500/60"
      style={{ left: (box.width - width) / 2, top: (box.height - height) / 2, width, height, background: "#fff" }}
    >
      {html !== null && (
        <iframe
          ref={frame}
          title={name}
          sandbox="allow-same-origin"
          srcDoc={html}
          onLoad={onLoad}
          width={size.w}
          height={size.h}
          style={{ border: 0, transform: `scale(${scale})`, transformOrigin: "0 0" }}
        />
      )}
    </div>
  );
});
