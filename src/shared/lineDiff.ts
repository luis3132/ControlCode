/**
 * Diff por líneas, para dibujar una edición como la dibuja cualquier herramienta de diff:
 * en rojo solo lo que sale, en verde solo lo que entra, y lo que queda igual sin color.
 *
 * Antes cada línea de `old_string` iba en rojo y cada una de `new_string` en verde, así que
 * cambiar una palabra en un bloque de veinte líneas pintaba cuarenta (issue #23).
 */

export type DiffSign = " " | "-" | "+";

export interface DiffLine {
  sign: DiffSign;
  text: string;
  /** Número de línea antes (`-` y ` `) y después (`+` y ` `), si se conoce. */
  oldNo?: number;
  newNo?: number;
}

/** Un tramo de líneas iguales que no se muestra, entre dos tramos con cambios. */
export interface DiffGap {
  sign: "gap";
  count: number;
}

const split = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);

/** Por encima de esto (líneas × líneas del tramo que difiere) no se busca la subsecuencia
 *  común más larga: se marca el tramo entero como reemplazado. Nunca pasa con una edición
 *  normal; protege de un `Write` de miles de líneas. */
const MAX_CELLS = 4_000_000;

/** Las líneas de `before` a `after`, cada una con su signo. `firstLine` es el número de la
 *  primera línea de `before` en el archivo, si se sabe. */
export function diffLines(before: string, after: string, firstLine = 1): DiffLine[] {
  const a = split(before);
  const b = split(after);

  // Lo igual al principio y al final no entra en la búsqueda: es casi todo, casi siempre.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middle: DiffSign[] = [];
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > MAX_CELLS) {
    middle.push(...midA.map(() => "-" as const), ...midB.map(() => "+" as const));
  } else {
    middle.push(...lcsOps(midA, midB));
  }

  const out: DiffLine[] = [];
  let ia = 0;
  let ib = 0;
  const push = (sign: DiffSign) => {
    const text = sign === "+" ? b[ib]! : a[ia]!;
    const line: DiffLine = { sign, text };
    if (sign !== "+") line.oldNo = firstLine + ia;
    if (sign !== "-") line.newNo = firstLine + ib;
    out.push(line);
    if (sign !== "+") ia++;
    if (sign !== "-") ib++;
  };
  for (let i = 0; i < start; i++) push(" ");
  for (const sign of middle) push(sign);
  while (ia < a.length && ib < b.length) push(" ");
  return out;
}

/** Las operaciones de la subsecuencia común más larga. Dentro de un cambio, lo que sale va
 *  antes de lo que entra, como en un diff unificado. */
function lcsOps(a: string[], b: string[]): DiffSign[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = largo de la LCS de a[i..] y b[j..], en un arreglo plano.
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)]! + 1 : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }
  const ops: DiffSign[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(" ");
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) {
      ops.push("-");
      i++;
    } else {
      ops.push("+");
      j++;
    }
  }
  while (i++ < n) ops.push("-");
  while (j++ < m) ops.push("+");
  return ops;
}

/** Un tramo del diff que hizo la CLI (`structuredPatch`), en líneas con su signo y número. */
export interface PatchHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

export function patchLines(hunks: PatchHunk[]): (DiffLine | DiffGap)[] {
  const out: (DiffLine | DiffGap)[] = [];
  hunks.forEach((h, k) => {
    if (k > 0) out.push({ sign: "gap", count: 0 });
    let oldNo = h.oldStart;
    let newNo = h.newStart;
    for (const raw of h.lines) {
      const first = raw.charAt(0);
      // `\ No newline at end of file` y cualquier otra marca que no es una línea.
      if (first !== " " && first !== "-" && first !== "+") continue;
      const line: DiffLine = { sign: first, text: raw.slice(1) };
      if (first !== "+") line.oldNo = oldNo++;
      if (first !== "-") line.newNo = newNo++;
      out.push(line);
    }
  });
  return out;
}

/**
 * Deja solo los cambios y `context` líneas iguales alrededor de cada uno; lo demás se
 * resume en un hueco con cuántas líneas tapa. Lo que hace `git diff` con su `-U3`.
 */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | DiffGap)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.sign === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | DiffGap)[] = [];
  let hidden = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (hidden > 0) out.push({ sign: "gap", count: hidden });
      hidden = 0;
      out.push(l);
    } else {
      hidden++;
    }
  });
  if (hidden > 0 && out.length > 0) out.push({ sign: "gap", count: hidden });
  return out;
}
