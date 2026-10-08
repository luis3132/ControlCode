/**
 * La forma de una tab de la barra, compartida por las de agente y las de archivo, diff o
 * navegador: conviven en la misma tira y tienen que verse de la misma familia.
 *
 * Es más baja que la barra y va pegada abajo: la activa, del color del contenido y con su
 * borde, se funde con el área de abajo como una pestaña de verdad. La línea de color va
 * arriba y dice cuál es el grupo enfocado cuando la pantalla está dividida.
 */
export const TAB_SHELL = `group relative flex items-center gap-2 h-[30px] self-end pl-3 pr-1.5 shrink-0
  rounded-t-lg border border-b-0 cursor-pointer select-none transition-colors duration-150`;

export const TAB_ACTIVE = `bg-gray-50 dark:bg-[#0d1117] border-gray-200 dark:border-white/7
  text-gray-900 dark:text-white`;

export const TAB_IDLE = `border-transparent text-gray-500 dark:text-gray-400
  hover:bg-gray-200/50 dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-200`;

export const activeMark = (groupFocused: boolean) =>
  `absolute -top-px left-2 right-2 h-[2px] rounded-b ${groupFocused ? "bg-blue-500" : "bg-gray-300 dark:bg-white/20"}`;

/** Lo que la tira y el encabezado de cada grupo usan de fondo, con la raya de abajo. La
 *  raya es una sombra hacia adentro y no un borde: así la tab activa, que pinta encima, la
 *  tapa y se une con el contenido. */
export const STRIP_BG = `bg-gray-100 dark:bg-[#080b0f]
  shadow-[inset_0_-1px_0_var(--color-gray-200)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.07)]`;
