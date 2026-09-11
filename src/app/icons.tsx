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

/**
 * Carpeta abierta: la que está desplegada en el explorador.
 *
 * Va acá porque la librería solo trae la cerrada. Y a diferencia del resto de este
 * archivo NO usa `BASE`: esta convive en la misma lista con `FolderIcon` y `DocumentIcon`
 * de la librería, que son de trazo 2 sobre la misma grilla. Parecerse a sus vecinas
 * importa más que parecerse a sus hermanas de archivo — con 1.7 se veía más fina justo al
 * lado de la cerrada, y el cambio de peso se leía como un cambio de estado que no existe.
 */
export function FolderOpenIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* El fondo de la carpeta, con su pestaña. */}
      <path d="M4 19V6a2 2 0 012-2h3.6a2 2 0 011.6.8l1.3 1.7H17a2 2 0 012 2v1" />
      {/* La bandeja del frente, inclinada: es lo que la hace leer como abierta. */}
      <path d="M4 19l2.5-8A2 2 0 018.4 9.5H21l-2.5 8a2 2 0 01-1.9 1.5H4z" />
    </svg>
  );
}
