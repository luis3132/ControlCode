/**
 * El grafo del historial: en qué carril va cada commit y qué líneas cruzan su fila.
 *
 * Es el algoritmo de siempre (el de `git log --graph`, el de VS Code): se recorren los
 * commits en orden topológico llevando la lista de carriles abiertos, cada uno esperando
 * a un commit. Un commit ocupa el carril que lo esperaba (o uno nuevo, si nadie lo
 * esperaba: la punta de una rama), y deja en su lugar a su primer padre. Los demás padres
 * —un merge— abren carriles nuevos o se unen al que ya los esperaba.
 *
 * Los carriles no se corren de lugar cuando otro se cierra: queda el hueco, y el próximo
 * que se abre lo reusa. Así cada línea es recta mientras vive, que es lo que deja seguir
 * una rama con la vista.
 *
 * Cada fila se dibuja en dos mitades: de arriba hasta el punto del commit, y del punto
 * hacia abajo. `top` y `bottom` son los tramos de cada mitad.
 */

export interface GraphInput {
  hash: string;
  parents: string[];
}

export interface Segment {
  /** Carril donde empieza el tramo (arriba) y donde termina (abajo). */
  from: number;
  to: number;
  /** Índice en la paleta. */
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  top: Segment[];
  bottom: Segment[];
  /** Carriles abiertos al terminar la fila: los que siguen hacia abajo. */
  continuing: { lane: number; color: number }[];
}

export function layoutGraph(commits: GraphInput[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const freeLane = () => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // Nadie lo esperaba: es la punta de una rama.
      lane = freeLane();
      colors[lane] = nextColor++;
    }
    const color = colors[lane];

    // ── mitad de arriba: los que llegan al commit convergen, el resto sigue derecho ──
    const top: Segment[] = [];
    lanes.forEach((h, i) => {
      if (h === null) return;
      top.push({ from: i, to: h === commit.hash ? lane : i, color: colors[i] });
    });
    // Varios carriles pueden estar esperando al mismo commit (dos ramas que salieron de
    // él): ahí se juntan y se cierran todos menos el del commit.
    lanes.forEach((h, i) => { if (h === commit.hash) lanes[i] = null; });
    const passing = lanes.map((h) => h !== null);

    // ── mitad de abajo: el commit baja hacia sus padres ──
    const bottom: Segment[] = [];
    const [first, ...merged] = commit.parents;
    if (first !== undefined) {
      const waiting = lanes.indexOf(first);
      if (waiting !== -1 && waiting < lane) {
        // Otra rama, más a la izquierda, ya espera a ese padre: esta línea se le une y el
        // carril se cierra.
        bottom.push({ from: lane, to: waiting, color: colors[waiting] });
      } else {
        if (waiting !== -1) {
          // La que lo esperaba está a la derecha: es ELLA la que converge acá. Así la
          // línea principal se queda a la izquierda, como en VS Code, en vez de saltar.
          lanes[waiting] = null;
          passing[waiting] = false;
          bottom.push({ from: waiting, to: lane, color: colors[waiting] });
        }
        lanes[lane] = first;
        bottom.push({ from: lane, to: lane, color });
      }
    }
    for (const parent of merged) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = freeLane();
        lanes[target] = parent;
        colors[target] = nextColor++;
      }
      bottom.push({ from: lane, to: target, color: colors[target] });
    }
    passing.forEach((on, i) => {
      if (on) bottom.push({ from: i, to: i, color: colors[i] });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const continuing = lanes
      .map((h, i) => (h === null ? null : { lane: i, color: colors[i] }))
      .filter((c): c is { lane: number; color: number } => c !== null);

    rows.push({ lane, color, top, bottom, continuing });
  }
  return rows;
}

/** Cuántos carriles ocupa el grafo entero: el ancho que hay que reservarle. */
export function graphWidth(rows: GraphRow[]): number {
  let max = 0;
  for (const r of rows) {
    max = Math.max(max, r.lane + 1);
    for (const s of [...r.top, ...r.bottom]) max = Math.max(max, s.from + 1, s.to + 1);
  }
  return max;
}
