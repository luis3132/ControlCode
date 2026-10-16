import { forwardRef, useEffect, useState } from "react";

import type { DeckSize } from "./deck";
import { composedSlide } from "./store";

/** Cada cuánto se mira si la hoja cambió en disco mientras se ve. */
const POLL_MS = 1000;

/**
 * Una hoja, dibujada a su tamaño real y escalada para entrar en `box`.
 *
 * Va en un iframe aislado (`sandbox` sin nada: ni scripts ni acceso a la app), porque el
 * HTML lo escribe un agente. Se relee mientras está montada: lo que el agente escribe en
 * ESTA hoja aparece enseguida. Montarla y desmontarla es lo que hace el visor para cargar
 * solo la actual y sus vecinas.
 */
export const SlideFrame = forwardRef<HTMLIFrameElement, {
  dir: string;
  name: string;
  size: DeckSize;
  box: { width: number; height: number };
  hidden?: boolean;
  onLoad?: () => void;
}>(function SlideFrame({ dir, name, size, box, hidden = false, onLoad }, ref) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => composedSlide(dir, name).then((next) => {
      if (alive) setHtml((prev) => (prev === next ? prev : next));
    }, console.error);
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [dir, name]);

  const scale = Math.min(box.width / size.w, box.height / size.h) || 0;
  const width = size.w * scale;
  const height = size.h * scale;

  return (
    <div
      className="absolute overflow-hidden shadow-lg"
      style={{
        left: (box.width - width) / 2,
        top: (box.height - height) / 2,
        width,
        height,
        background: "#fff",
        visibility: hidden ? "hidden" : undefined,
      }}
    >
      {html !== null && (
        <iframe
          ref={ref}
          title={name}
          sandbox=""
          srcDoc={html}
          onLoad={onLoad}
          width={size.w}
          height={size.h}
          style={{ border: 0, transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none" }}
        />
      )}
    </div>
  );
});
