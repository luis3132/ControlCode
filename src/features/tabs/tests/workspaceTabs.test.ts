import { describe, expect, it } from "vitest";

import { tabsOfWorkspace } from "../workspaceTabs";
import type { Tab } from "../types";

let seq = 0;
const tab = (cwd: string): Tab => {
  seq += 1;
  return {
    id: `t${seq}`, title: `tab ${seq}`, cwd,
    agentId: "claude-code", agentLabel: "Claude Code", command: "claude",
    ptyId: seq, openedAt: seq,
  } as Tab;
};

describe("tabsOfWorkspace", () => {
  it("solo devuelve las de la carpeta activa", () => {
    const a1 = tab("/proyecto-a");
    const b1 = tab("/proyecto-b");
    const a2 = tab("/proyecto-a");
    expect(tabsOfWorkspace([a1, b1, a2], a1.id).map((x) => x.id)).toEqual([a1.id, a2.id]);
    expect(tabsOfWorkspace([a1, b1, a2], b1.id).map((x) => x.id)).toEqual([b1.id]);
  });

  it("conserva el orden de la barra", () => {
    const a1 = tab("/p");
    const b = tab("/otro");
    const a2 = tab("/p");
    const a3 = tab("/p");
    expect(tabsOfWorkspace([a3, b, a1, a2], a1.id).map((x) => x.id)).toEqual([a3.id, a1.id, a2.id]);
  });

  it("sin tab activa devuelve todas", () => {
    // Es el instante justo después de cerrar la última de una carpeta: mostrar cero
    // dejaría la barra vacía cuando todavía hay agentes vivos en otras.
    const a = tab("/p");
    const b = tab("/otro");
    expect(tabsOfWorkspace([a, b], null)).toHaveLength(2);
  });

  it("una tab activa que ya no está tampoco filtra de más", () => {
    const a = tab("/p");
    const b = tab("/otro");
    expect(tabsOfWorkspace([a, b], "id-que-no-existe")).toHaveLength(2);
  });

  it("sin tabs, lista vacía", () => {
    expect(tabsOfWorkspace([], null)).toEqual([]);
  });
});
