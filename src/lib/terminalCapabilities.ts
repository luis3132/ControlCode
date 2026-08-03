import type { Terminal } from "@xterm/xterm";

/**
 * Respuestas a las consultas de capacidades que hacen las TUIs modernas al arrancar.
 *
 * ## El problema
 *
 * Antes de dibujar, una TUI le pregunta a la terminal qué sabe hacer, y **espera la
 * respuesta**. OpenCode (vía opentui) manda una tanda al arrancar:
 *
 *   ESC[?2031h  ESC]10;?  ESC]11;?  ESC[>0q  ESC[6n  ESC P+q…  ESC[?2026$p  ESC[?u  …
 *
 * xterm.js 6 contesta `ESC[6n` (posición del cursor) y las DA, pero **no implementa
 * DECRQM (`$p`) ni XTVERSION (`>q`) ni el protocolo de teclado de Kitty (`?u`)** —
 * verificado sobre el bundle instalado. Sin esas respuestas, OpenCode se queda esperando
 * para siempre: dibuja su logo, cambia a la pantalla alternativa (fondo #0a0a0a) y no
 * escribe nada más. Desde afuera es una **terminal negra**.
 *
 * Medido con un PTY real (`cargo run --example pty_probe`): sin responder, OpenCode escribe
 * 7011 bytes y se detiene a los 3s, vivo pero mudo, incluso pasados 30s. Respondiendo,
 * llega a ~10100 bytes y termina de pintar su interfaz.
 *
 * ## La respuesta
 *
 * Se contesta lo que xterm.js no cubre, y se contesta **"no soportado"** en todos los
 * casos en que la respuesta implicaría una promesa. Decirle a una TUI que soportamos un
 * modo que xterm.js no implementa es peor que decirle que no: usaría secuencias que la
 * terminal no entiende y el resultado sería basura en pantalla en vez de una degradación
 * limpia. Lo que importa es **contestar**, no contestar que sí.
 */

/** Terminadores de secuencia: BEL para OSC, ST (ESC \) para DCS/APC. */
const ST = "\x1b\\";

export interface CapabilityColors {
  /** Color de texto en formato CSS (`#rrggbb`), para responder OSC 10. */
  foreground: string;
  /** Color de fondo, para responder OSC 11. */
  background: string;
}

/** `#rrggbb` → `rgb:rrrr/gggg/bbbb`, que es el formato que espera OSC 10/11. */
export function toXParseColor(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "rgb:0000/0000/0000";
  const part = (i: number) => {
    const byte = clean.slice(i, i + 2);
    return `${byte}${byte}`.toLowerCase();
  };
  return `rgb:${part(0)}/${part(2)}/${part(4)}`;
}

/**
 * Registra las respuestas en `term`. `send` tiene que escribir al PTY (no al terminal).
 * Devuelve la función para desregistrarlas.
 */
export function registerCapabilityResponders(
  term: Terminal,
  send: (data: string) => void,
  colors: CapabilityColors
): () => void {
  const disposables: Array<{ dispose: () => void }> = [];

  // ── DECRQM: "¿tenés el modo N?" ─────────────────────────────
  // Se responde 0 = "no lo conozco" para todos, incluso los que xterm.js sí implementa.
  // Es la respuesta conservadora: la TUI evita usarlos y degrada bien. Afirmar soporte
  // que después no está es lo que produce pantallas corruptas.
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
      const mode = Number(params[0]) || 0;
      send(`\x1b[?${mode};0$y`);
      return true;
    })
  );

  // ── XTVERSION: "¿qué terminal sos?" ─────────────────────────
  // Solo la forma `CSI > 0 q`. Otros valores de `Ps` son DECSCUSR (forma del cursor),
  // que le corresponde manejar a xterm.js — por eso se devuelve false ahí.
  disposables.push(
    term.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
      if (Number(params[0] ?? 0) !== 0) return false;
      send(`\x1bP>|xterm.js${ST}`);
      return true;
    })
  );

  // ── Protocolo de teclado de Kitty ───────────────────────────
  // `CSI ? u` pregunta qué flags están activas. `0` = ninguna, o sea "no lo soporto".
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      send("\x1b[?0u");
      return true;
    })
  );

  // ── OSC 10/11: colores de texto y de fondo ──────────────────
  // Con esto la TUI elige su paleta clara u oscura según el tema real de la app, en vez
  // de adivinar. Solo se intercepta la forma de consulta (`?`); la de asignación sigue
  // siendo de xterm.js.
  const colorQuery = (code: number, value: string) =>
    term.parser.registerOscHandler(code, (data) => {
      if (data !== "?") return false;
      send(`\x1b]${code};${toXParseColor(value)}${ST}`);
      return true;
    });
  disposables.push(colorQuery(10, colors.foreground));
  disposables.push(colorQuery(11, colors.background));

  // ── XTGETTCAP: consulta de terminfo ─────────────────────────
  // `DCS + q <hex> ST`. Se responde `0` = "no tengo esa capacidad", que es la respuesta
  // válida para una terminal que no expone terminfo.
  disposables.push(
    term.parser.registerDcsHandler({ intermediates: "+", final: "q" }, () => {
      send(`\x1bP0+q${ST}`);
      return true;
    })
  );

  return () => {
    for (const d of disposables) d.dispose();
  };
}
