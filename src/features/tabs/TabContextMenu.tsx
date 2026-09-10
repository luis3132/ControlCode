import { useEffect, useRef } from "react";

interface TabContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCloseTab: () => void;
}

/** "Mover a ventana" ya no está: un workspace es una carpeta con agentes adentro y se
 *  cambia desde el panel izquierdo, sin abrir ventanas. */
export function TabContextMenu({ x, y, onClose, onCloseTab }: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Cierra al hacer clic fuera o presionar Escape
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Ajusta posición para que no salga de la pantalla
  const style: React.CSSProperties = {
    position: "fixed",
    top: y,
    left: x,
    zIndex: 10000,
  };

  return (
    <div
      ref={ref}
      style={style}
      className="min-w-44 rounded-lg border shadow-xl overflow-hidden
        bg-white dark:bg-gray-800
        border-gray-200 dark:border-white/10
        text-gray-800 dark:text-gray-100
        text-xs select-none"
    >
      <button
        onClick={() => { onCloseTab(); onClose(); }}
        className="w-full text-left px-3 py-1.5 pb-2
          text-red-500 dark:text-red-400
          hover:bg-red-50 dark:hover:bg-red-500/10
          transition-colors"
      >
        Cerrar tab
      </button>
    </div>
  );
}
