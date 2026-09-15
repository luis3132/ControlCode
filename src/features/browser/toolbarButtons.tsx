import { Tooltip } from "neogestify-ui-components";

/**
 * Un botón de ícono de la barra del navegador. `plain`: con el rótulo nativo del sistema en
 * vez del tooltip de la app — para lo que dispara una captura, porque el tooltip de la app
 * se dibuja en la página y saldría en la foto; el del sistema no.
 */
export function ToolButton({ label, onClick, disabled, active, plain, children }: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  plain?: boolean;
  children: React.ReactNode;
}) {
  const button = (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={plain ? label : undefined}
      // Contraste de texto, no de adorno: estos son los controles con los que se usa la
      // tab. Con el gris al 45% sobre el fondo oscuro, y encima atenuados al 35% mientras
      // la página no cargó, prácticamente no se veían.
      className={`cc-t relative flex items-center justify-center w-8 h-8 rounded-lg shrink-0
        disabled:text-gray-400 dark:disabled:text-white/30 disabled:hover:bg-transparent
        ${active
          ? "bg-blue-500/15 text-blue-600 dark:bg-blue-400/20 dark:text-blue-300"
          : "text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
  return plain ? button : <Tooltip content={label} placement="bottom">{button}</Tooltip>;
}

/** Una acción propia de esta tab, con rótulo. Marcar y enviar no son iconos que alguien
 *  reconozca de un navegador: sin la palabra al lado había que pasar el mouse para saber
 *  qué hacían. `plain`: ver `ToolButton`. */
export function ActionButton({ hint, onClick, disabled, active, plain, children }: {
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  plain?: boolean;
  children: React.ReactNode;
}) {
  const button = (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={plain ? hint : undefined}
      className={`cc-t flex items-center gap-1.5 h-8 px-2.5 rounded-lg shrink-0 border text-[12px] font-semibold
        disabled:opacity-45 disabled:hover:bg-transparent
        ${active
          ? "bg-blue-600 border-blue-600 text-white hover:bg-blue-500"
          : "border-gray-300 dark:border-white/15 text-gray-800 dark:text-gray-100 hover:bg-gray-200 dark:hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
  return plain ? button : <Tooltip content={hint} placement="bottom">{button}</Tooltip>;
}

/** La raya que separa grupos de botones. */
export function ToolbarSeparator() {
  return <div className="w-px h-5 mx-0.5 shrink-0 bg-gray-200 dark:bg-white/10" />;
}
