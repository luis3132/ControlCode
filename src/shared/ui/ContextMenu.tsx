import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/** Cuánto aire se le deja al menú contra el borde de la ventana al reubicarlo. */
const EDGE = 8;

/**
 * El menú de click derecho, uno solo para toda la app.
 *
 * Se reubica si no entra: abrirlo cerca del borde derecho o inferior dejaba la mitad de
 * las opciones fuera de la ventana, y con la ventana sin decoración no hay scroll que
 * valga — lo que se sale, se pierde.
 */
export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - width - EDGE),
      y: Math.min(y, window.innerHeight - height - EDGE),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Se corta acá: si no, el Escape sigue hasta la terminal de atrás.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.y, left: pos.x, zIndex: 10000 }}
      className="cc-pop min-w-52 py-1 rounded-lg border shadow-xl overflow-hidden
        bg-white dark:bg-gray-800
        border-gray-200 dark:border-white/10
        text-gray-800 dark:text-gray-100
        text-xs select-none"
    >
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => { item.onSelect(); onClose(); }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
            ${item.danger
              ? "text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
              : "hover:bg-gray-100 dark:hover:bg-white/10"}`}
        >
          {item.icon && <span className="shrink-0 flex w-4 h-4">{item.icon}</span>}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
