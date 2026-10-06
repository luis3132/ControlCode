/**
 * La salida de un PTY, como llega del backend: cada tramo dice cuántos bytes llevaba
 * escritos el proceso al terminarlo (`end`), con la misma cuenta que el `total` de una
 * copia del scrollback (`ptyAttach`). Con eso una terminal que se reconecta sabe qué
 * eventos ya venían en la copia y no los escribe dos veces.
 */
export interface PtyData {
  data: string;
  end: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Lo de `chunk` que no venía en una copia de `total` bytes. Vacío si venía entero. */
export function afterSnapshot(chunk: PtyData, total: number): string {
  if (chunk.end <= total) return "";
  const bytes = encoder.encode(chunk.data);
  const start = chunk.end - bytes.length;
  if (start >= total) return chunk.data;
  // El tramo empezó antes de la copia y terminó después: solo va la parte nueva.
  return decoder.decode(bytes.subarray(total - start));
}
