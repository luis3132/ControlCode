/**
 * Moverse por una lista de resultados con las flechas.
 *
 * Trabaja sobre las CLAVES y no sobre los objetos: la usan el buscador del marketplace y
 * el de skills, que listan cosas distintas pero se recorren igual. Lo único que ambas
 * necesitan es que el orden de las claves sea el mismo en el que se dibujan las filas —
 * incluidos los saltos entre grupos, que a la flecha abajo le tienen que dar igual.
 */

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
