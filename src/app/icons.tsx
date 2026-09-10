/**
 * Los iconos que la librería no trae.
 *
 * Todos son de trazo sobre una grilla de 24, `currentColor` y `strokeWidth` parejo, para
 * que convivan con los de `neogestify-ui-components` sin que se note el corte. El tamaño
 * lo pone quien los usa, vía `className`.
 */
type IconProps = { className?: string };

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Panel lateral: el rectángulo con una columna marcada. Es el toggle de plegado. */
export function PanelIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

/** Rama de git: el nodo que se separa y vuelve. */
export function BranchIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className} strokeWidth={1.9}>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <circle cx="18" cy="9" r="2.6" />
      <path d="M6 8.6v6.8M18 11.6c0 3.4-4 3-8 3.6" />
    </svg>
  );
}

/** Lista con tildes: las tareas del proyecto. */
export function TasksIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M4 6.4l1.5 1.5L8.3 5.1" />
      <path d="M4 13l1.5 1.5L8.3 11.7" />
      <path d="M4 19.6l1.5 1.5L8.3 18.3" />
      <path d="M12 6.8h8M12 13.4h8M12 20h8" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className} strokeWidth={1.8}>
      <path d="M20 11a8 8 0 10-1.6 5.6" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

/** Los tres puntos del menú contextual del panel. */
export function DotsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

/** Servidores MCP. */
export function PlugIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M8 7V4M16 7V4M8 12h8" />
    </svg>
  );
}

/** Cuadrícula: la vista de tablero. */
export function GridIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </svg>
  );
}

/**
 * El anillo de "corriendo": un arco sobre una pista tenue.
 *
 * No gira. Una animación por cada agente en un panel con varios es ruido constante en la
 * periferia de la vista, y acá el estado se lee de un vistazo sin necesidad de moverse.
 */
export function RunningIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.6} strokeLinecap="round" className={className}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" opacity={0.25} />
      <path d="M12 3a9 9 0 019 9" stroke="currentColor" />
    </svg>
  );
}
