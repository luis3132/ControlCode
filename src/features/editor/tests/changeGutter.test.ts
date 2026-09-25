import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { changeGutter, currentChunks, revertSpec, setBaseline } from "../changeGutter";

const labels = { before: "", revert: "", close: "", added: "" };

function editor(base: string | null, doc: string) {
  const state = EditorState.create({ doc, extensions: changeGutter(labels) });
  return state.update({ effects: setBaseline.of(base) }).state;
}

describe("changeGutter", () => {
  it("sin base no marca nada", () => {
    expect(currentChunks(editor(null, "a\nb"))).toEqual([]);
  });

  it("marca lo modificado, lo agregado y lo borrado", () => {
    // Con líneas sin tocar entre medio: cambios pegados se juntan en un solo tramo.
    const base = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10";
    const state = editor(base, "l1\nL2\nl3\nl4\nl5\nnueva\nl6\nl7\nl8\nl10");
    const chunks = currentChunks(state);
    const kinds = chunks.map((c) => (c.fromB === c.toB ? "deleted" : c.fromA === c.toA ? "added" : "modified"));
    expect(kinds).toEqual(["modified", "added", "deleted"]);
  });

  it("revertir un tramo deja solo ese como estaba", () => {
    const base = "uno\ndos\ntres\ncuatro";
    let state = editor(base, "uno\nDOS\ntres\nCUATRO");
    const [first] = currentChunks(state);
    state = state.update(revertSpec(state, first)!).state;
    expect(state.doc.toString()).toBe("uno\ndos\ntres\nCUATRO");
    expect(currentChunks(state)).toHaveLength(1);
  });

  it("revertir líneas agregadas las quita, y revertir un borrado las devuelve", () => {
    const base = "a\nb\nc";
    let added = editor(base, "a\nb\nnueva\nc");
    added = added.update(revertSpec(added, currentChunks(added)[0])!).state;
    expect(added.doc.toString()).toBe(base);

    let removed = editor(base, "a\nc");
    removed = removed.update(revertSpec(removed, currentChunks(removed)[0])!).state;
    expect(removed.doc.toString()).toBe(base);
  });

  it("los tramos siguen al escribir, sin rehacer todo", () => {
    let state = editor("a\nb\nc", "a\nb\nc");
    expect(currentChunks(state)).toEqual([]);
    state = state.update({ changes: { from: 2, to: 3, insert: "B" } }).state;
    expect(currentChunks(state)).toHaveLength(1);
    // Una base con CRLF se compara igual (git en Windows).
    expect(currentChunks(editor("a\r\nb", "a\nb"))).toEqual([]);
  });
});

describe("rulerMarks", () => {
  it("cada cambio va a la altura relativa de su línea en el archivo", async () => {
    const { rulerMarks } = await import("../changeGutter");
    const lines = Array.from({ length: 534 }, (_, i) => `l${i + 1}`);
    const base = lines.join("\n");
    const modified = [...lines];
    modified[266] = "CAMBIADA"; // la línea 267
    const added = [...lines.slice(0, 400), "nueva", ...lines.slice(400)];

    const [m] = rulerMarks(editor(base, modified.join("\n")));
    expect(m.kind).toBe("modified");
    expect(m.top).toBeCloseTo(266 / 534);
    expect(m.top).toBeCloseTo(0.5, 2);
    expect(m.height).toBeCloseTo(1 / 534);

    const [a] = rulerMarks(editor(base, added.join("\n")));
    expect(a.kind).toBe("added");
    expect(a.top).toBeCloseTo(400 / 535);

    const [d] = rulerMarks(editor(base, lines.filter((_, i) => i !== 100).join("\n")));
    expect(d.kind).toBe("deleted");
    expect(d.height).toBe(0);
  });
});
