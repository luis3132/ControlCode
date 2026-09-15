import { useEffect, useRef, useState, type ReactNode } from "react";

import { breakpointOf, clampViewport, fitScale, type Viewport } from "./viewport";

type Edge = "x" | "y" | "xy";

/**
 * Donde se muestra la página: ocupando toda la tab o, con un tamaño elegido, en un marco
 * de ese tamaño que se agarra de los bordes para cambiarlo.
 *
 * El iframe (`children`) va SIEMPRE en el mismo lugar del árbol, con o sin marco: si React
 * lo desmontara al prender el modo responsive, la página se recargaría y perdería su
 * estado — justo lo que se quiere probar en otro ancho.
 *
 * Un tamaño más grande que el espacio se muestra achicado, pero la página sigue midiendo
 * lo que se pidió: las media queries ven 1440 px aunque en pantalla ocupe la mitad.
 */
export function ResponsiveStage({ viewport, onResize, children }: {
  viewport: Viewport | null;
  onResize: (viewport: Viewport) => void;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<Viewport>({ width: 0, height: 0 });
  /** Mientras se arrastra: el tamaño en curso y la escala congelada al empezar. Si la
   *  escala se recalculara con cada movimiento, el borde se escaparía del puntero. */
  const [drag, setDrag] = useState<{ draft: Viewport; scale: number } | null>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      // El padding del escenario y el rótulo de abajo no son espacio para el marco.
      setAvailable({ width: entry.contentRect.width - 56, height: entry.contentRect.height - 64 });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = drag?.draft ?? viewport;
  const scale = shown ? (drag?.scale ?? fitScale(shown, available)) : 1;

  const startDrag = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!viewport || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const origin = { x: e.clientX, y: e.clientY, viewport, scale };
    let draft = viewport;
    setDrag({ draft, scale });

    const move = (ev: PointerEvent) => {
      // El marco está centrado a lo ancho: el borde se mueve la mitad de lo que crece, así
      // que el ancho suma el doble del desplazamiento para que el borde siga al puntero.
      const dx = ((ev.clientX - origin.x) * 2) / origin.scale;
      const dy = (ev.clientY - origin.y) / origin.scale;
      draft = clampViewport({
        width: edge === "y" ? origin.viewport.width : origin.viewport.width + dx,
        height: edge === "x" ? origin.viewport.height : origin.viewport.height + dy,
      });
      setDrag({ draft, scale: origin.scale });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDrag(null);
      onResize(draft);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  return (
    <div
      ref={stage}
      className={shown
        ? "relative flex-1 min-h-0 overflow-auto px-7 pt-5 pb-11 bg-gray-100 dark:bg-[#090c10] bg-[radial-gradient(circle,rgba(120,130,150,0.22)_1px,transparent_1px)] [background-size:16px_16px]"
        : "relative flex-1 min-h-0 bg-white"}
    >
      <div
        style={shown
          ? { position: "relative", width: shown.width * scale, height: shown.height * scale, margin: "0 auto", flexShrink: 0 }
          : { position: "absolute", inset: 0 }}
      >
        <div
          style={shown
            ? { width: shown.width, height: shown.height, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "0 0" }
            : { width: "100%", height: "100%" }}
          className={shown ? "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_32px_-12px_rgba(0,0,0,0.35)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_12px_32px_-12px_rgba(0,0,0,0.8)]" : undefined}
        >
          {children}
        </div>

        {shown && (
          <>
            <Handle edge="x" onPointerDown={startDrag("x")} />
            <Handle edge="y" onPointerDown={startDrag("y")} />
            <Handle edge="xy" onPointerDown={startDrag("xy")} />
            <div className="absolute left-0 right-0 top-full mt-2.5 flex justify-center pointer-events-none">
              <span className={`px-2 h-5 rounded-full font-mono text-[10.5px] leading-5 tabular-nums
                ${drag ? "bg-blue-600 text-white" : "bg-white/90 dark:bg-white/8 text-gray-600 dark:text-white/55 ring-1 ring-gray-200 dark:ring-white/10"}`}>
                {shown.width} × {shown.height}
                <span className="opacity-60"> · {breakpointOf(shown.width)}{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}</span>
              </span>
            </div>
          </>
        )}
      </div>
      {/* Mientras se arrastra, el iframe no puede quedarse con el puntero: si el mouse pasa
          por encima de la página, los eventos se irían a ella y el arrastre se cortaría. */}
      {drag && <div className="fixed inset-0 z-50" style={{ cursor: "grabbing" }} />}
    </div>
  );
}

function Handle({ edge, onPointerDown }: { edge: Edge; onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  const place = edge === "x"
    ? "top-0 -right-4 w-4 h-full cursor-ew-resize flex items-center justify-center"
    : edge === "y"
      ? "left-0 -bottom-4 h-4 w-full cursor-ns-resize flex items-center justify-center"
      : "-right-4 -bottom-4 w-4 h-4 cursor-nwse-resize";
  const grip = edge === "x" ? "w-1 h-8" : edge === "y" ? "h-1 w-8" : "w-1.5 h-1.5";
  return (
    <div role="separator" aria-orientation={edge === "y" ? "horizontal" : "vertical"} onPointerDown={onPointerDown}
      className={`group absolute z-10 touch-none ${place}`}>
      <span className={`block rounded-full bg-gray-400/70 dark:bg-white/25 group-hover:bg-blue-500 ${grip}
        ${edge === "xy" ? "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" : ""}`} />
    </div>
  );
}
