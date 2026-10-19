import { describe, expect, it } from "vitest";

import type { CanvasNode, CanvasPage } from "@/features/canvas/model";

import { canvasEdits, type CanvasEditsInput } from "../canvasEdits";

const node = (id: string, kind: CanvasNode["kind"], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, kind, x: 0, y: 0, w: 100, h: 100, ...extra });
const page = (id: string, nodes: CanvasNode[]): CanvasPage =>
  ({ id, name: `Página ${id}`, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const by = (at: number) => ({ id: "tab-1", label: "Claude Code", at });

const input = (extra: Partial<CanvasEditsInput>): CanvasEditsInput => ({
  pages: { "/repo": [page("p1", [node("n-doc", "doc", { ref: "/repo/notas.md" })]), page("p2", [node("n-dia", "diagram", { ref: "/repo/arq.json" })])] },
  canvasMode: { "/repo": true },
  activePage: { "/repo": "p1" },
  presence: {},
  shownWorkspace: "/repo",
  ...extra,
});

describe("canvasEdits", () => {
  it("avisa de una ventana que un agente cambia en otra página del canvas", () => {
    const out = canvasEdits(input({ presence: { "/repo/arq.json#shape-3": by(10) } }));
    expect(out).toEqual([expect.objectContaining({
      workspace: "/repo", pageId: "p2", nodeId: "n-dia", kind: "diagram", name: "arq.json",
      actor: { id: "tab-1", label: "Claude Code" },
    })]);
  });

  it("no avisa de lo que se está viendo", () => {
    expect(canvasEdits(input({ presence: { "/repo/notas.md#doc": by(10) } }))).toEqual([]);
  });

  it("con el canvas fuera de la vista, avisa también de la página activa", () => {
    const out = canvasEdits(input({ presence: { "/repo/notas.md#doc": by(10) }, shownWorkspace: null }));
    expect(out.map((e) => e.nodeId)).toEqual(["n-doc"]);
  });

  it("sin modo canvas no hay ventanas que avisar", () => {
    expect(canvasEdits(input({ presence: { "/repo/arq.json#x": by(10) }, canvasMode: {} }))).toEqual([]);
  });

  it("la terminal de un agente no es una ventana que esté cambiando", () => {
    const pages = { "/repo": [page("p1", []), page("p2", [node("n-agent", "agent", { ref: "tab-9" })])] };
    expect(canvasEdits(input({ pages, presence: { "n-agent": by(10) } }))).toEqual([]);
  });

  it("lo último que cambió va primero, y una nota sin título se nombra por su tipo", () => {
    const pages = { "/repo": [page("p1", []), page("p2", [node("n-a", "note"), node("n-b", "slides", { ref: "/repo/deck", title: "Demo" })])] };
    const out = canvasEdits(input({ pages, presence: { "n-a": by(5), "/repo/deck#slides": by(20) } }));
    expect(out.map((e) => [e.nodeId, e.name])).toEqual([["n-b", "Demo"], ["n-a", null]]);
  });
});
