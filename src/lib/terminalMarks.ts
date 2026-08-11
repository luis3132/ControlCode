import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Líneas de corte en cada envío del usuario.
 *
 * ## Qué se puede detectar y qué no
 *
 * Desde la terminal NO se sabe qué es "un mensaje": eso lo decide el programa de adentro.
 * Lo único observable es lo que el usuario TECLEA. Por eso la señal es el Enter (`\r`), que
 * es lo que en la práctica separa una intervención de la siguiente, y por eso esto es una
 * heurística y no una verdad: un Enter dentro de un composer multilínea marca igual, y un
 * envío hecho con otra tecla no marca.
 *
 * ## Por qué solo en la pantalla normal
 *
 * Las TUIs de pantalla alternativa (OpenCode entre ellas) no tienen scrollback: se
 * redibujan enteras sobre un lienzo fijo. Ahí una marca no tendría a qué anclarse — la
 * línea que marcaste deja de existir en el siguiente repintado. Se detecta el caso y no se
 * marca, en vez de dejar rayas flotando sobre una interfaz que se redibuja.
 *
 * En la pantalla normal (Claude Code, Codex, un shell) cada línea sí es una línea real del
 * historial, la marca sube con el scroll y acompaña a su contenido, que es lo que la hace
 * útil para navegar una conversación larga.
 */

/** Techo de marcas vivas. Cada una es un elemento en el DOM: sin límite, una sesión de
 *  horas termina con miles. Al pasarse se descartan las más viejas, que además son las que
 *  ya están fuera del scrollback útil. */
const MAX_MARKS = 300;

export interface InputMarkColors {
  /** Color de la línea, en CSS. Se espera algo tenue: es un separador, no contenido. */
  line: string;
}

/**
 * Engancha las marcas a `term`. Devuelve la función para sacarlas (y borrar las existentes).
 */
export function installInputMarks(term: Terminal, colors: InputMarkColors): () => void {
  const marks: IDisposable[] = [];
  let lastMarkedLine = -1;

  const drop = (count: number) => {
    for (const mark of marks.splice(0, count)) mark.dispose();
  };

  const mark = () => {
    // Sin scrollback no hay dónde anclar: ver el comentario de arriba.
    if (term.buffer.active.type !== "normal") return;

    const buffer = term.buffer.active;
    const line = buffer.baseY + buffer.cursorY;
    // Varios Enter seguidos sobre la misma línea (o un Enter que no movió el cursor)
    // dibujarían la misma raya varias veces, una encima de la otra.
    if (line === lastMarkedLine) return;
    lastMarkedLine = line;

    const marker = term.registerMarker(0);
    if (!marker) return;

    const decoration = term.registerDecoration({
      marker,
      width: term.cols,
      height: 1,
      // `bottom` deja el texto por encima: la marca es un fondo, nunca tapa un carácter.
      layer: "bottom",
    });
    if (!decoration) {
      marker.dispose();
      return;
    }

    decoration.onRender((element) => {
      element.style.borderTop = `1px solid ${colors.line}`;
      element.style.pointerEvents = "none";
      // El ancho se fija al crear la decoración (en columnas), así que tras un resize la
      // raya quedaría corta o pasada. Estirarla al contenedor la deja siempre completa.
      element.style.width = "100%";
    });

    marks.push(decoration);
    if (marks.length > MAX_MARKS) drop(marks.length - MAX_MARKS);
  };

  const listener = term.onData((data) => {
    // `includes` y no `===`: un pegado puede traer el Enter junto al texto, y las teclas
    // con modificadores llegan como secuencias que terminan igual en `\r`.
    if (data.includes("\r")) mark();
  });

  return () => {
    listener.dispose();
    drop(marks.length);
  };
}
