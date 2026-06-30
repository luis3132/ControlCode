import { useEffect, useRef } from "react";

interface TabContextMenuProps {
  x: number;
  y: number;
  otherWindows: string[];
  onClose: () => void;
  onMoveToWindow: (label: string) => void;
  onCloseTab: () => void;
}

function formatWindowLabel(label: string, index: number): string {
  if (label === "main") return "Ventana principal";
  return `Ventana ${index + 1}`;
}

export function TabContextMenu({
  x, y, otherWindows, onClose, onMoveToWindow, onCloseTab,
}: TabContextMenuProps) {
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
      {otherWindows.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Mover a ventana
          </div>
          {otherWindows.map((label, i) => (
            <button
              key={label}
              onClick={() => { onMoveToWindow(label); onClose(); }}
              className="w-full text-left px-3 py-1.5
                hover:bg-blue-50 dark:hover:bg-blue-500/15
                hover:text-blue-700 dark:hover:text-blue-300
                transition-colors"
            >
              {formatWindowLabel(label, i)}
            </button>
          ))}
          <div className="my-1 border-t border-gray-100 dark:border-white/6" />
        </>
      )}

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
