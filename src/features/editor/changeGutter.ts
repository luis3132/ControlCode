/**
 * Las marcas de cambios al margen del editor, como en VS Code: una barra verde donde se
 * agregaron líneas, azul donde se modificaron y un triángulo rojo donde se borraron.
 *
 * Se compara el documento (con lo que todavía no se guardó) contra la versión del índice
 * de git — lo mismo que muestra "cambios sin preparar". Un click en una marca despliega
 * debajo lo que había antes, con un botón para revertir ESE cambio; el resto del archivo
 * no se toca. Revertir cambia el documento, no el disco: se guarda como cualquier edición.
 *
 * Los mismos tramos se marcan además sobre la barra de scroll, a la altura relativa de cada
 * uno en el archivo (`rulerMarks`): se ve de un vistazo dónde hay cambios sin recorrerlo.
 *
 * Los tramos (`Chunk`) salen de `@codemirror/merge`, el mismo diff del visor de diffs.
 */
import { Chunk } from "@codemirror/merge";
import {
  RangeSetBuilder, StateEffect, StateField, Text, type EditorState, type Extension, type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate,
} from "@codemirror/view";

export interface ChangeGutterLabels {
  before: string;
  revert: string;
  close: string;
  /** Tramo que solo agrega líneas: no hay nada "antes" que mostrar. */
  added: string;
}

/** La versión contra la que se compara. `null` = sin base (archivo fuera de git o nuevo). */
export const setBaseline = StateEffect.define<string | null>();
/** Abre (con el `fromB` del tramo) o cierra (`null`) el despliegue. */
const setPeek = StateEffect.define<number | null>();

interface ChangeState {
  base: Text | null;
  chunks: readonly Chunk[];
  /** El `fromB` del tramo desplegado. */
  peek: number | null;
}

function toText(content: string): Text {
  return Text.of(content.split(/\r\n?|\n/));
}

const changes = StateField.define<ChangeState>({
  create: () => ({ base: null, chunks: [], peek: null }),
  update(value, tr) {
    let { base, chunks, peek } = value;
    let rebuild = false;
    for (const e of tr.effects) {
      if (e.is(setBaseline)) {
        const next = e.value === null ? null : toText(e.value);
        if (!(base && next && base.eq(next)) && !(base === null && next === null)) {
          base = next;
          rebuild = true;
        }
      }
      if (e.is(setPeek)) peek = e.value;
    }
    if (!base) return { base: null, chunks: [], peek: null };
    if (rebuild) {
      chunks = Chunk.build(base, tr.state.doc);
    } else if (tr.docChanged) {
      // Incremental: rehacer el diff entero en cada tecla se nota en archivos grandes.
      chunks = Chunk.updateB(chunks, base, tr.state.doc, tr.changes);
    }
    if (peek !== null && tr.docChanged) peek = tr.changes.mapPos(peek);
    if (peek !== null && !chunks.some((c) => c.fromB === peek)) peek = null;
    return { base, chunks, peek };
  },
});

type Kind = "added" | "modified" | "deleted";

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: Kind) { super(); }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change cm-change-${this.kind}`;
    return el;
  }
}

const MARKERS: Record<Kind, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

function kindOf(c: Chunk): Kind {
  if (c.fromB === c.toB) return "deleted";
  if (c.fromA === c.toA) return "added";
  return "modified";
}

/** El tramo que toca una línea. Uno borrado se marca en la línea donde estaba. */
function chunkAt(state: EditorState, lineFrom: number): Chunk | undefined {
  const line = state.doc.lineAt(lineFrom);
  return state.field(changes).chunks.find((c) => {
    if (c.fromB === c.toB) return state.doc.lineAt(Math.min(c.fromB, state.doc.length)).number === line.number;
    return c.fromB <= line.to && c.endB >= line.from;
  });
}

/** Lo que deshace un tramo: vuelve a poner las líneas de la base en su lugar. Es lo mismo
 *  que hace el "revertir" del MergeView de CodeMirror. */
export function revertSpec(state: EditorState, chunk: Chunk): TransactionSpec | null {
  const { base } = state.field(changes);
  if (!base) return null;
  const doc = state.doc;
  let insert = base.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
  if (chunk.fromA !== chunk.toA && chunk.toB <= doc.length) insert += state.lineBreak;
  return {
    changes: { from: chunk.fromB, to: Math.min(doc.length, chunk.toB), insert },
    effects: setPeek.of(null),
    userEvent: "revert",
  };
}

function revert(view: EditorView, chunk: Chunk) {
  const spec = revertSpec(view.state, chunk);
  if (spec) view.dispatch(spec);
}

class PeekWidget extends WidgetType {
  constructor(readonly chunk: Chunk, readonly before: string, readonly labels: ChangeGutterLabels) { super(); }

  eq(other: PeekWidget) {
    return other.chunk.fromB === this.chunk.fromB && other.chunk.toB === this.chunk.toB && other.before === this.before;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = `cm-changePeek cm-changePeek-${kindOf(this.chunk)}`;

    const head = document.createElement("div");
    head.className = "cm-changePeek-head";
    const title = document.createElement("span");
    title.textContent = this.labels.before;
    const revertBtn = document.createElement("button");
    revertBtn.className = "cm-changePeek-revert";
    revertBtn.textContent = this.labels.revert;
    revertBtn.onmousedown = (e) => e.preventDefault();
    revertBtn.onclick = () => revert(view, this.chunk);
    const closeBtn = document.createElement("button");
    closeBtn.className = "cm-changePeek-close";
    closeBtn.textContent = "×";
    closeBtn.title = this.labels.close;
    closeBtn.onmousedown = (e) => e.preventDefault();
    closeBtn.onclick = () => view.dispatch({ effects: setPeek.of(null) });
    head.append(title, revertBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "cm-changePeek-body";
    if (this.chunk.fromA === this.chunk.toA) {
      const note = document.createElement("div");
      note.className = "cm-changePeek-note";
      note.textContent = this.labels.added;
      body.append(note);
    } else {
      for (const text of this.before.split("\n")) {
        const line = document.createElement("div");
        line.className = "cm-changePeek-line";
        // Un espacio en las vacías: si no, la línea colapsa y el bloque miente su alto.
        line.textContent = text || " ";
        body.append(line);
      }
    }
    box.append(head, body);
    return box;
  }

  ignoreEvent() { return true; }
}

function peekDecoration(state: EditorState, labels: ChangeGutterLabels): DecorationSet {
  const { base, chunks, peek } = state.field(changes);
  const chunk = peek === null ? undefined : chunks.find((c) => c.fromB === peek);
  if (!base || !chunk) return Decoration.none;
  const before = base.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
  const doc = state.doc;
  // Debajo de la última línea del tramo; uno borrado, encima de donde estaba.
  const deleted = chunk.fromB === chunk.toB;
  const pos = deleted ? doc.lineAt(Math.min(chunk.fromB, doc.length)).from : doc.lineAt(Math.min(chunk.endB, doc.length)).to;
  const widget = Decoration.widget({ widget: new PeekWidget(chunk, before, labels), block: true, side: deleted ? -1 : 1 });
  return Decoration.set([widget.range(pos)]);
}

const theme = EditorView.baseTheme({
  ".cm-changeGutter": { width: "4px", marginRight: "4px" },
  ".cm-changeGutter .cm-gutterElement": { padding: "0", cursor: "pointer" },
  ".cm-change": { width: "3px", height: "100%" },
  ".cm-change-added": { backgroundColor: "#2ea043" },
  ".cm-change-modified": { backgroundColor: "#1f78d1" },
  ".cm-change-deleted": {
    width: "0", height: "0", marginTop: "-4px",
    borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid #f85149",
  },
  ".cm-changeRuler": { position: "absolute", right: "0", zIndex: "5", pointerEvents: "none" },
  ".cm-changeRuler-mark": { position: "absolute", left: "1px", right: "1px", borderRadius: "1px", opacity: "0.85" },
  ".cm-changeRuler-added": { backgroundColor: "#2ea043" },
  ".cm-changeRuler-modified": { backgroundColor: "#1f78d1" },
  ".cm-changeRuler-deleted": { backgroundColor: "#f85149" },
  ".cm-changePeek": {
    margin: "2px 0 4px", borderTop: "2px solid", borderBottom: "2px solid", fontSize: "12px",
  },
  ".cm-changePeek-added": { borderColor: "#2ea043" },
  ".cm-changePeek-modified": { borderColor: "#1f78d1" },
  ".cm-changePeek-deleted": { borderColor: "#f85149" },
  ".cm-changePeek-head": {
    display: "flex", alignItems: "center", gap: "8px", padding: "3px 10px",
    fontFamily: "system-ui, sans-serif", fontSize: "11px", opacity: "0.85",
  },
  ".cm-changePeek-revert": {
    padding: "1px 8px", borderRadius: "4px", border: "1px solid currentColor", background: "transparent",
    color: "inherit", cursor: "pointer", fontSize: "11px",
  },
  // Revertir queda al lado del título, donde se está mirando; cerrar, al final de la franja.
  ".cm-changePeek-close": {
    marginLeft: "auto", border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "14px", lineHeight: "1",
  },
  ".cm-changePeek-body": { padding: "2px 0" },
  ".cm-changePeek-line": {
    padding: "0 10px", whiteSpace: "pre", backgroundColor: "rgba(248,81,73,0.14)", textDecoration: "none",
  },
  ".cm-changePeek-note": { padding: "2px 10px", fontStyle: "italic", opacity: "0.7", fontFamily: "system-ui, sans-serif" },
  "&light .cm-changePeek-head": { backgroundColor: "rgba(0,0,0,0.04)" },
  "&dark .cm-changePeek-head": { backgroundColor: "rgba(255,255,255,0.05)" },
});

export interface RulerMark {
  kind: Kind;
  /** Dónde empieza, como fracción del archivo (0 = primera línea, 1 = después de la última). */
  top: number;
  /** Cuánto ocupa, en la misma escala. Un borrado no ocupa líneas: 0. */
  height: number;
}

/** Cada tramo como una fracción del archivo: la línea 267 de 534 está en 0.5. */
export function rulerMarks(state: EditorState): RulerMark[] {
  const doc = state.doc;
  const lines = doc.lines;
  return state.field(changes).chunks.map((chunk) => {
    const kind = kindOf(chunk);
    const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
    const count = kind === "deleted" ? 0 : doc.lineAt(Math.min(chunk.endB, doc.length)).number - first + 1;
    return { kind, top: (first - 1) / lines, height: count / lines };
  });
}

/** Lo mínimo que se dibuja una marca: un cambio de una línea en un archivo de miles tiene
 *  que verse igual. */
const RULER_MIN_PX = 3;

/**
 * La franja de marcas sobre la barra de scroll. Va encima de la barra, del mismo ancho, y
 * no recibe el mouse: el pulgar se sigue arrastrando igual.
 */
const ruler = ViewPlugin.fromClass(class {
  dom: HTMLElement;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-changeRuler";
    this.dom.setAttribute("aria-hidden", "true");
    view.dom.appendChild(this.dom);
    this.draw();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged
      || update.startState.field(changes) !== update.state.field(changes)) {
      this.draw();
    }
  }

  draw() {
    const marks = rulerMarks(this.view.state);
    this.view.requestMeasure({
      read: (view) => {
        const scroller = view.scrollDOM;
        return {
          // El ancho real de la barra: 8px con el estilo de la app, 0 donde es flotante
          // (macOS). Ahí igual se dibuja una franja angosta en el borde.
          width: Math.max(scroller.offsetWidth - scroller.clientWidth, 6),
          top: scroller.offsetTop,
          height: scroller.clientHeight,
        };
      },
      write: ({ width, top, height }) => {
        const box = this.dom;
        box.style.top = `${top}px`;
        box.style.height = `${height}px`;
        box.style.width = `${width}px`;
        box.replaceChildren(...marks.map((m) => {
          const el = document.createElement("div");
          el.className = `cm-changeRuler-mark cm-changeRuler-${m.kind}`;
          el.style.top = `${Math.min(m.top * height, height - RULER_MIN_PX)}px`;
          el.style.height = `${Math.max(m.height * height, RULER_MIN_PX)}px`;
          return el;
        }));
      },
    });
  }

  destroy() {
    this.dom.remove();
  }
});

/** Las marcas de cambios y su despliegue. La base se fija con el efecto `setBaseline`. */
export function changeGutter(labels: ChangeGutterLabels): Extension {
  return [
    changes,
    EditorView.decorations.compute([changes], (state) => peekDecoration(state, labels)),
    gutter({
      class: "cm-changeGutter",
      markers: (view) => {
        const builder = new RangeSetBuilder<GutterMarker>();
        const doc = view.state.doc;
        for (const chunk of view.state.field(changes).chunks) {
          const kind = kindOf(chunk);
          if (kind === "deleted") {
            const line = doc.lineAt(Math.min(chunk.fromB, doc.length));
            builder.add(line.from, line.from, MARKERS.deleted);
            continue;
          }
          const first = doc.lineAt(chunk.fromB).number;
          const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number;
          for (let n = first; n <= last; n++) {
            const line = doc.line(n);
            builder.add(line.from, line.from, MARKERS[kind]);
          }
        }
        return builder.finish();
      },
      lineMarkerChange: (update) => update.startState.field(changes) !== update.state.field(changes),
      domEventHandlers: {
        mousedown(view, line) {
          const chunk = chunkAt(view.state, line.from);
          if (!chunk) return false;
          const open = view.state.field(changes).peek === chunk.fromB;
          view.dispatch({ effects: setPeek.of(open ? null : chunk.fromB) });
          return true;
        },
      },
    }),
    ruler,
    theme,
  ];
}

/** Para los tests: los tramos que ve el editor ahora. */
export function currentChunks(state: EditorState): readonly Chunk[] {
  return state.field(changes).chunks;
}
