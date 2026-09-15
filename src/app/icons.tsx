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

/** Globo: una tab de navegador. */
export function GlobeIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </svg>
  );
}

/** Cursor sobre un recuadro punteado: marcar un elemento de la página. */
export function PickIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 3H5a2 2 0 00-2 2v4M21 9V5a2 2 0 00-2-2h-4M3 15v4a2 2 0 002 2h4" strokeDasharray="0" />
      <path d="M12 12l8.5 3.2-3.6 1.6-1.6 3.6L12 12z" />
    </svg>
  );
}

/** Flecha saliendo de una caja: abrir afuera de la app. */
export function ExternalIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
    </svg>
  );
}

/** Avión de papel: mandar algo a un agente. */
export function SendIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M21 3L10 14M21 3l-7 18-4-7-7-4 18-7z" />
    </svg>
  );
}

/** Flecha hacia arriba sobre una línea: subir (push). */
export function PushIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 17V5M6 11l6-6 6 6M5 20h14" />
    </svg>
  );
}

/** Flecha hacia abajo sobre una línea: traer (pull). */
export function PullIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 4v12M6 10l6 6 6-6M5 20h14" />
    </svg>
  );
}

/** Flecha curva hacia atrás: descartar cambios. */
export function UndoIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
    </svg>
  );
}

/** El logo de GitHub, de trazo como el resto. */
export function GithubIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
    </svg>
  );
}

/** El logo de GitLab (el zorro), simplificado a trazo. */
export function GitlabIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M12 21l-9-7 2.5-10 3 7h7l3-7L21 14l-9 7z" />
    </svg>
  );
}

/** Un teléfono delante de un monitor: probar la página en otros tamaños. */
export function DevicesIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M17 17H4.5A1.5 1.5 0 013 15.5v-9A1.5 1.5 0 014.5 5h13A1.5 1.5 0 0119 6.5V9M8 21h7M11 17v4" />
      <rect x="15" y="11" width="6" height="10" rx="1.2" />
    </svg>
  );
}

/** Un bicho: el panel de debug de la página. */
export function BugIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <path d="M9 7.5V6a3 3 0 016 0v1.5" />
      <rect x="7" y="7.5" width="10" height="12" rx="5" />
      <path d="M12 11v8.5M3.5 13H7M17 13h3.5M4.5 8.5L7.2 10M19.5 8.5L16.8 10M4.5 18.5l2.8-1.6M19.5 18.5l-2.8-1.6" />
    </svg>
  );
}

/** Flecha que gira sobre un rectángulo: cambiar la orientación. */
export function RotateIcon({ className }: IconProps) {
  return (
    <svg {...BASE} className={className}>
      <rect x="4" y="9" width="11" height="11" rx="1.5" />
      <path d="M13 3.5a7 7 0 017 7M17.5 8.5l2.5 2 2-2.5" />
    </svg>
  );
}
