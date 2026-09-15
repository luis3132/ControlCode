import { describe, expect, it } from "vitest";

import {
  activate, allGroups, closeGroup, createLayout, focusGroup, groupOf, moveItem, normalize, parseLayout, reconcile,
  resize, split, type LayoutNode, type WorkspaceLayout,
} from "../layout/layoutTree";

/** El árbol como texto, para comparar la forma sin depender de los ids. */
function shape(node: LayoutNode): string {
  if (node.kind === "group") return `[${node.items.map((k) => (k === node.active ? `*${k}` : k)).join(" ")}]`;
  return `${node.direction}(${node.children.map(shape).join(", ")})`;
}

const focusedItems = (layout: WorkspaceLayout) => allGroups(layout.root).find((g) => g.id === layout.focused)?.items;

describe("pantalla dividida", () => {
  it("sin dividir es un solo grupo con todas las tabs, agentes primero", () => {
    let layout = createLayout();
    layout = reconcile(layout, ["v:f1", "a:t1", "a:t2"]);
    expect(shape(layout.root)).toBe("[*a:t1 a:t2 v:f1]");
    // Activar cambia cuál se ve.
    layout = activate(layout, "a:t2");
    expect(shape(layout.root)).toBe("[a:t1 *a:t2 v:f1]");
  });

  it("dividir a la derecha lleva la tab a un grupo nuevo y lo enfoca", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "v:f1"]);
    const [group] = allGroups(layout.root);
    layout = split(layout, group!.id, "right", "v:f1");
    expect(shape(layout.root)).toBe("row([*a:t1 a:t2], [*v:f1])");
    expect(focusedItems(layout)).toEqual(["v:f1"]);
  });

  it("dividir abajo apila, y dividir de nuevo en la misma dirección suma hermanos", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "a:t3"]);
    const first = allGroups(layout.root)[0]!.id;
    layout = split(layout, first, "down", "a:t2");
    expect(shape(layout.root)).toBe("column([*a:t1 a:t3], [*a:t2])");
    layout = split(layout, layout.focused, "down");
    expect(layout.root.kind === "split" && layout.root.children.length).toBe(3);
    expect(layout.root.kind === "split" && layout.root.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("dividir un grupo de una sola tab deja un grupo vacío al lado, que no desaparece", () => {
    let layout = reconcile(createLayout(), ["a:t1"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:t1");
    expect(shape(layout.root)).toBe("row([*a:t1], [])");
    layout = reconcile(layout, ["a:t1"]);
    expect(allGroups(layout.root)).toHaveLength(2);
    // Lo que se abre después cae en el grupo enfocado: el vacío.
    layout = reconcile(layout, ["a:t1", "v:web"]);
    expect(shape(layout.root)).toBe("row([*a:t1], [*v:web])");
  });

  it("un grupo que se queda sin tabs desaparece y su lugar lo toma el vecino", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "v:f1"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "v:f1");
    layout = reconcile(layout, ["a:t1", "a:t2"]);
    expect(shape(layout.root)).toBe("[*a:t1 a:t2]");
    expect(layout.focused).toBe(allGroups(layout.root)[0]!.id);
  });

  it("si se va el grupo enfocado, el foco pasa al de al lado y no al primero", () => {
    let layout = reconcile(createLayout(), ["a:1", "a:2", "a:3"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:2");
    layout = split(layout, layout.focused, "right", "a:3");
    expect(shape(layout.root)).toBe("row([*a:1], [*a:2], [*a:3])");
    const [, middle, last] = allGroups(layout.root);
    layout = focusGroup(layout, last!.id);
    layout = reconcile(layout, ["a:1", "a:2"]);
    expect(layout.focused).toBe(middle!.id);
  });

  it("cerrar la tab visible muestra la de al lado dentro del mismo grupo", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "a:t3"]);
    layout = activate(layout, "a:t2");
    layout = reconcile(layout, ["a:t1", "a:t3"]);
    expect(shape(layout.root)).toBe("[*a:t1 a:t3]");
  });

  it("mover a otro grupo inserta donde se soltó y vacía el de origen", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "a:t3"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:t3");
    const [left, right] = allGroups(layout.root);
    layout = moveItem(layout, "a:t1", right!.id, 0);
    expect(shape(layout.root)).toBe("row([*a:t2], [*a:t1 a:t3])");
    expect(layout.focused).toBe(right!.id);
    layout = moveItem(layout, "a:t2", right!.id);
    expect(shape(layout.root)).toBe("[a:t1 a:t3 *a:t2]");
    expect(groupOf(layout, "a:t2")?.id).toBe(right!.id);
    expect(left).toBeDefined();
  });

  it("reordenar dentro del mismo grupo cuenta la posición como se veía", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "a:t3"]);
    const id = allGroups(layout.root)[0]!.id;
    layout = moveItem(layout, "a:t1", id, 2);
    expect(shape(layout.root)).toBe("[a:t2 *a:t1 a:t3]");
  });

  it("cerrar un grupo no cierra sus tabs: pasan al vecino", () => {
    let layout = reconcile(createLayout(), ["a:t1", "a:t2", "v:f1"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "v:f1");
    layout = closeGroup(layout, layout.focused);
    expect(shape(layout.root)).toBe("[*a:t1 a:t2 v:f1]");
    // Los agentes que llegan se juntan con los agentes, no quedan entre los archivos.
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:t1");
    layout = closeGroup(layout, layout.focused);
    expect(shape(layout.root)).toBe("[*a:t2 a:t1 v:f1]");
    // El único grupo no se cierra.
    expect(closeGroup(layout, layout.focused)).toBe(layout);
  });

  it("una división dentro de otra de la otra dirección se mantiene; las de la misma se aplanan", () => {
    let layout = reconcile(createLayout(), ["a:1", "a:2", "a:3", "a:4"]);
    const first = allGroups(layout.root)[0]!.id;
    layout = split(layout, first, "right", "a:4");
    layout = split(layout, first, "down", "a:3");
    expect(shape(layout.root)).toBe("row(column([*a:1 a:2], [*a:3]), [*a:4])");
    const flat = normalize({
      kind: "split", id: "x", direction: "row", sizes: [0.5, 0.5],
      children: [
        { kind: "split", id: "y", direction: "row", sizes: [0.5, 0.5], children: [
          { kind: "group", id: "g1", items: ["a"], active: "a" },
          { kind: "group", id: "g2", items: ["b"], active: "b" },
        ] },
        { kind: "group", id: "g3", items: ["c"], active: "c" },
      ],
    });
    expect(flat.kind === "split" && flat.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("redimensionar normaliza y se guarda en su división", () => {
    let layout = reconcile(createLayout(), ["a:1", "a:2"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:2");
    const root = layout.root;
    if (root.kind !== "split") throw new Error("esperaba una división");
    layout = resize(layout, root.id, [3, 1]);
    expect(layout.root.kind === "split" && layout.root.sizes).toEqual([0.75, 0.25]);
  });

  it("activar una tab de otro grupo enfoca ese grupo", () => {
    let layout = reconcile(createLayout(), ["a:1", "a:2"]);
    layout = split(layout, allGroups(layout.root)[0]!.id, "right", "a:2");
    const [left] = allGroups(layout.root);
    layout = activate(layout, "a:1");
    expect(layout.focused).toBe(left!.id);
    expect(focusGroup(layout, "no-existe")).toBe(layout);
  });

  it("lo que viene roto de localStorage no se usa", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ root: { kind: "split", id: "s", direction: "diagonal", children: [], sizes: [] }, focused: "x" })).toBeNull();
    const good = parseLayout({ root: { kind: "group", id: "g", items: ["a:1"], active: "a:1" }, focused: "otro" });
    expect(good?.focused).toBe("g");
  });
});
