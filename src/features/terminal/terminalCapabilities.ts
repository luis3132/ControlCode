import type { Terminal } from "@xterm/xterm";

/**
 * Respuestas a las consultas de capacidades que hacen las TUIs modernas al arrancar, en
 * los casos en que xterm.js todavía no contesta solo.
 *
 * ## El problema
 *
 * Antes de dibujar, una TUI le pregunta a la terminal qué sabe hacer, y **espera la
 * respuesta**. OpenCode (vía opentui) manda una tanda al arrancar:
 *
 *   ESC[?2031h  ESC]10;?  ESC]11;?  ESC[>0q  ESC[6n  ESC P+q…  ESC[?2026$p  ESC[?u  …
 *
 * Si alguna queda sin contestar, se queda esperando para siempre: dibuja su logo, cambia a
 * la pantalla alternativa y no escribe nada más. Desde afuera es una **terminal negra**.
 * Medido con un PTY real (`cargo run --example pty_probe`): sin responder, OpenCode se
 * detiene a los 3s en 7011 bytes; respondiendo, llega a ~10100 y termina de pintar.
 *
 * ## Qué contesta xterm y qué no
 *
 * Con xterm 6.0 había que contestar casi todo a mano. Desde 6.1 xterm implementa por su
 * cuenta DECRQM (`$p`), XTVERSION (`>q`) y la consulta de colores (OSC 10/11) — verificado
 * en `src/common/InputHandler.ts` de la versión instalada — y los contesta MEJOR que esto:
 * con el estado real de cada modo y los colores del tema vigente.
 *
 * Por eso ya no se interceptan. No era inocuo dejarlos: un handler registrado después se
 * prueba primero, así que el nuestro, que contestaba "no conozco ese modo" a todo, le
 * decía a las TUIs que no había salida sincronizada (modo 2026) ni bracketed paste. Con
 * eso redibujaban sin sincronizar — el parpadeo — y pegaban texto como si se tipeara.
 *
 * Quedan los dos que xterm no cubre:
 *
 * - **Teclado de Kitty (`CSI ? u`)** mientras esté apagado: xterm lo acepta pero no
 *   contesta nada, que es justo lo que cuelga a quien espera respuesta.
 * - **XTGETTCAP (`DCS + q`)**: xterm no lo implementa.
 *
 * En ambos se contesta "no soportado". Decirle a una TUI que soportamos algo que la
 * terminal no hace es peor que decirle que no: usaría secuencias que nadie entiende. Lo
 * que importa es **contestar**, no contestar que sí.
 */

/** Terminador de DCS (ESC \). */
const ST = "\x1b\\";

/**
 * Registra las respuestas en `term`. `send` tiene que escribir al PTY (no al terminal).
 * Devuelve la función para desregistrarlas.
 */
export function registerCapabilityResponders(term: Terminal, send: (data: string) => void): () => void {
  const disposables: Array<{ dispose: () => void }> = [];

  // ── Protocolo de teclado de Kitty ───────────────────────────
  // `CSI ? u` pregunta qué flags están activas. Con el protocolo encendido la respuesta es
  // de xterm (sabe qué flags pidió la TUI); apagado, `0` = "no lo soporto".
  disposables.push(
    term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      if (term.options.vtExtensions?.kittyKeyboard) return false;
      send("\x1b[?0u");
      return true;
    })
  );

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
