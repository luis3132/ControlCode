import { useEffect, type RefObject } from "react";

/**
 * Al abrirse, trae el foco del teclado adentro del marco — salvo que ya esté adentro.
 *
 * Los marcos que se abren encima de las terminales (`RouteModal`, `ShellModal`) las dejan
 * visibles detrás, y una terminal visible conserva el foco. El resultado era que, estando
 * en una terminal, abrir la flota con Ctrl+F y apretar `y` para aprobar un permiso le
 * escribía una "y" al agente de atrás: las teclas de la consola se ignoran a propósito
 * cuando el foco está en un campo de texto, y el campo de entrada de xterm es un
 * `textarea`. Verificado contra el bundle de producción antes de arreglarlo.
 *
 * "Salvo que ya esté adentro" importa: los efectos de los hijos corren antes que los del
 * padre, así que una página que enfoca su buscador al montarse ya lo hizo cuando esto
 * corre, y robarle el foco la rompería.
 *
 * El rAF es por lo mismo que en `Terminal`: en WebKitGTK `focus()` sobre algo que todavía
 * no terminó de pintarse es un no-op silencioso.
 */
export function useFocusInside(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ref]);
}
