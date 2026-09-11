/**
 * Moverse por una lista de resultados con las flechas.
 *
 * Trabaja sobre las CLAVES y no sobre los objetos: la usan el buscador del marketplace y
 * el de skills, que listan cosas distintas pero se recorren igual. Lo único que ambas
 * necesitan es que el orden de las claves sea el mismo en el que se dibujan las filas —
 * incluidos los saltos entre grupos, que a la flecha abajo le tienen que dar igual.
 */
import { useEffect, useRef, type RefObject } from "react";

/**
 * La clave a marcar al mover la selección.
 *
 * No da la vuelta: en una lista de resultados, llegar al final y reaparecer arriba hace
 * perder de vista dónde estabas. Se queda en el extremo.
 */
export function moveSelection(keys: string[], current: string | null, delta: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  // Sin nada marcado se entra por la punta que corresponde al sentido.
  if (at === -1) return delta > 0 ? keys[0] : keys[keys.length - 1];
  return keys[Math.min(keys.length - 1, Math.max(0, at + delta))];
}

/**
 * La selección que sobrevive a un cambio de resultados.
 *
 * Mientras se escribe, la lista se rehace en cada tecla. Si lo marcado sigue estando se
 * respeta; si desapareció, se marca lo primero — dejar la selección apuntando a algo que
 * ya no se ve hace que Enter actúe sobre lo que el usuario no tiene delante.
 */
export function reconcileSelection(keys: string[], current: string | null): string | null {
  if (keys.length === 0) return null;
  if (current !== null && keys.includes(current)) return current;
  return keys[0];
}

/**
 * Mantiene a la vista lo que está marcado.
 *
 * Sin esto, bajar con las flechas más allá del borde del contenedor deja la selección
 * fuera de pantalla: se sigue moviendo, pero a ciegas, y Enter actúa sobre algo que no se
 * ve. El `ref` se le pone SOLO a la fila marcada, así que en cada momento hay uno solo.
 *
 * Dos decisiones que importan:
 *
 * - `block: "nearest"` desplaza lo mínimo. Con `"center"` la lista salta en cada flecha
 *   aunque la fila siguiente ya estuviera perfectamente visible.
 * - Sin `behavior: "smooth"`: manteniendo la flecha apretada, la animación no llega a
 *   terminar antes de la próxima tecla y el scroll queda arrastrándose detrás de la
 *   selección. Instantáneo es lo que se siente preciso.
 *
 * El foco del teclado NO se mueve: se queda en el buscador, que es lo que permite seguir
 * escribiendo mientras se recorre el resultado.
 */
export function useSelectionVisible<T extends HTMLElement>(
  selectedKey: string | null
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (selectedKey === null) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);
  return ref;
}
