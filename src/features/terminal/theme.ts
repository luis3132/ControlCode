/**
 * Paletas de la terminal, una por tema. Son GitHub Dark y GitHub Light: el resto de la app
 * ya venía con la oscura, y usar el par oficial mantiene los 16 colores ANSI coherentes
 * entre sí en vez de aclarar la oscura a ojo (que deja los colores brillantes ilegibles
 * sobre blanco — un amarillo #e3b341 sobre fondo claro no se lee).
 */
export const TERMINAL_THEMES = {
  dark: {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    selectionBackground: "#388bfd40",
    black: "#0d1117",
    brightBlack: "#6e7681",
    red: "#ff7b72",
    brightRed: "#ffa198",
    green: "#3fb950",
    brightGreen: "#56d364",
    yellow: "#d29922",
    brightYellow: "#e3b341",
    blue: "#388bfd",
    brightBlue: "#79c0ff",
    magenta: "#bc8cff",
    brightMagenta: "#d2a8ff",
    cyan: "#39c5cf",
    brightCyan: "#56d4dd",
    white: "#b1bac4",
    brightWhite: "#f0f6fc",
    // La barra de scroll de xterm por defecto es el color del texto al 20% — sobre este
    // fondo, indistinguible. Estos valores la hacen visible sin que compita con el
    // contenido, y suben al agarrarla para dar respuesta al arrastre.
    scrollbarSliderBackground: "rgba(230, 237, 243, 0.30)",
    scrollbarSliderHoverBackground: "rgba(230, 237, 243, 0.45)",
    scrollbarSliderActiveBackground: "rgba(230, 237, 243, 0.60)",
  },
  light: {
    // Gris, no blanco puro. El blanco a pantalla completa es agresivo en una superficie que
    // se mira durante horas, y deja sin margen los tonos claros. Es exactamente el
    // `bg-gray-100` que ya usa el panel que la contiene (ver TerminalPanel), así que la
    // terminal se integra con la app en vez de recortarse como un rectángulo blanco.
    background: "#f3f4f6",
    foreground: "#1f2328",
    cursor: "#0550ae",
    selectionBackground: "#0969da33",
    // Cada color cumple contraste sobre el fondo POR SÍ MISMO, conservando su tono. Esto
    // evita pedirle a xterm que corrija el contraste en caliente: esa corrección, para
    // llegar al ratio, arrastra el color hacia el negro y le borra el matiz — todo
    // terminaba viéndose gris.
    //
    // Elegidos maximizando SATURACIÓN, no oscuridad. Es la diferencia entre un tema claro
    // que se ve apagado y uno que se ve vivo: para ganar contraste sobre un fondo claro se
    // puede bajar la luminosidad (que lava el color) o subir el croma (que lo mantiene). Un
    // `#00792c` al 100% de saturación y un `#0a7d2e` al 85% contrastan casi igual, pero el
    // primero se lee como verde de verdad.
    //
    // Las variantes `bright` van más OSCURAS que las normales, no más claras: sobre fondo
    // claro, "más destacado" es más oscuro. Al revés se irían hacia el blanco y volverían
    // al problema original.
    black: "#24292e",
    brightBlack: "#57606a",
    red: "#d10d1f",
    brightRed: "#a4071c",
    green: "#00792c",
    brightGreen: "#04591f",
    yellow: "#b45309",
    brightYellow: "#8a3d00",
    blue: "#0969da",
    brightBlue: "#0546b8",
    magenta: "#7c3aed",
    brightMagenta: "#5f21c9",
    cyan: "#0e7490",
    brightCyan: "#0a5568",
    // La familia "white" va OSCURA a propósito. En la semántica de terminal, `white` y
    // `brightWhite` son "el texto normal / el destacado": pensados para fondo negro. Si se
    // dejan como grises claros (que es lo que trae GitHub Light), sobre fondo blanco
    // desaparecen — y es justo lo que más usan los agentes para su texto principal.
    white: "#4a5058",
    brightWhite: "#24292f",
    scrollbarSliderBackground: "rgba(31, 35, 40, 0.28)",
    scrollbarSliderHoverBackground: "rgba(31, 35, 40, 0.42)",
    scrollbarSliderActiveBackground: "rgba(31, 35, 40, 0.55)",
  },
} as const;

/**
 * Piso de contraste que xterm corrige en caliente, contra el fondo real de cada celda.
 *
 * Deliberadamente BAJO (2, no el 4.5 de WCAG AA). Con 4.5, para alcanzar el ratio xterm
 * arrastra el color hacia el negro y le borra el tono: los rojos, verdes y azules
 * terminaban viéndose todos gris oscuro. Como la paleta clara de acá ya cumple ~4.5 por su
 * cuenta, un piso de 2 no llega a activarse nunca para un color normal — solo entra donde
 * la paleta no puede llegar: el texto atenuado (SGR 2), que xterm dibuja mezclando hacia el
 * fondo y en tema claro queda casi invisible, y los pares fondo/texto que impone el propio
 * programa.
 *
 * En oscuro queda apagado (1): esa paleta ya se veía bien y no hay nada que corregir.
 */
export const MIN_CONTRAST = { dark: 1, light: 2 } as const;

/** Color de las líneas de corte (ver `terminalMarks`). Tenue a propósito: separa sin
 *  competir con el contenido, que es lo que se está leyendo. */
export const MARK_LINE = { dark: "rgba(88, 166, 255, 0.35)", light: "rgba(9, 105, 218, 0.28)" } as const;
