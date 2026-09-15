import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  activateItem, focusGroup, moveItemTo, resetLayoutSync, splitGroup, syncLayouts, useLayoutStore,
} from "../layout/layoutStore";
import { allGroups, type LayoutNode, type WorkspaceLayout } from "../layout/layoutTree";
import { useTabsStore } from "../store";
import type { Tab } from "../types";
import { useViewTabsStore } from "../viewStore";
import type { ViewTab } from "../viewTabs";

function agent(id: string, cwd = "/p"): Tab {
  return { id, title: id, cwd, agentId: "bash", agentLabel: "bash", command: "bash", ptyId: null, openedAt: 1 } as Tab;
}

function file(id: string, cwd = "/p"): ViewTab {
  return { kind: "file", id, cwd, path: `${cwd}/${id}.ts`, title: `${id}.ts` };
}

const addAgent = (tab: Tab) => useTabsStore.setState((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
const openView = (view: ViewTab) => useViewTabsStore.setState((s) => ({ views: [...s.views, view], activeViewId: view.id }));

function shape(node: LayoutNode): string {
  if (node.kind === "group") return `[${node.items.map((k) => (k === node.active ? `*${k}` : k)).join(" ")}]`;
  return `${node.direction}(${node.children.map(shape).join(", ")})`;
}

const layout = (cwd = "/p") => useLayoutStore.getState().layouts[cwd]!;
const focusedGroup = (l: WorkspaceLayout) => allGroups(l.root).find((g) => g.id === l.focused)!;
const groups = () => allGroups(layout().root);

describe("grupos enganchados a las tabs", () => {
  let unsubs: (() => void)[] = [];

  beforeEach(() => {
    resetLayoutSync();
    useTabsStore.setState({ tabs: [], activeTabId: null, hydrated: true });
    useViewTabsStore.setState({ views: [], activeViewId: null, keepMountedIds: [] });
    const sync = () => syncLayouts();
    unsubs = [useTabsStore.subscribe(sync), useViewTabsStore.subscribe(sync)];
  });

  afterEach(() => unsubs.forEach((u) => u()));

  it("lo que se abre cae en el grupo enfocado", () => {
    addAgent(agent("t1"));
    addAgent(agent("t2"));
    splitGroup(groups()[0]!.id, "right", "a:t2");
    expect(shape(layout().root)).toBe("row([*a:t1], [*a:t2])");

    openView(file("f1"));
    expect(shape(layout().root)).toBe("row([*a:t1], [a:t2 *v:f1])");
    expect(useViewTabsStore.getState().activeViewId).toBe("f1");
  });

  it("cerrar lo que se ve en otro grupo no cambia lo que se está mirando", () => {
    addAgent(agent("t1"));
    addAgent(agent("t2"));
    openView(file("f1"));
    splitGroup(groups()[0]!.id, "right", "v:f1");
    expect(shape(layout().root)).toBe("row([a:t1 *a:t2], [*v:f1])");

    // El store de tabs elige a t1 y, con eso, volvería a la terminal.
    useTabsStore.getState().closeTab("t2");
    expect(shape(layout().root)).toBe("row([*a:t1], [*v:f1])");
    expect(useViewTabsStore.getState().activeViewId).toBe("f1");
    expect(focusedGroup(layout()).items).toEqual(["v:f1"]);
  });

  it("cerrar lo que se mira pasa a la vecina de su grupo, no a la de la lista", () => {
    addAgent(agent("t1"));
    openView(file("f1"));
    openView(file("f2"));
    openView(file("f3"));
    splitGroup(groups()[0]!.id, "right", "v:f3");
    const right = layout().focused;
    moveItemTo("v:f1", right);
    expect(shape(layout().root)).toBe("row([a:t1 *v:f2], [v:f3 *v:f1])");

    // El store de vistas elegiría f2, que está en el otro grupo.
    useViewTabsStore.getState().closeView("f1");
    expect(useViewTabsStore.getState().activeViewId).toBe("f3");
    expect(shape(layout().root)).toBe("row([a:t1 *v:f2], [*v:f3])");
    expect(layout().focused).toBe(right);
  });

  it("un grupo vacío enfocado sigue enfocado hasta que se abre algo ahí", () => {
    addAgent(agent("t1"));
    addAgent(agent("t0"));
    splitGroup(groups()[0]!.id, "right");
    const empty = layout().focused;
    expect(focusedGroup(layout()).items).toEqual([]);

    useTabsStore.getState().updateTab("t1", { ptyId: 3 });
    expect(layout().focused).toBe(empty);
    // Cerrar la del otro grupo cambia la tab activa de la app, pero no el foco.
    useTabsStore.getState().closeTab("t0");
    expect(layout().focused).toBe(empty);

    openView(file("f1"));
    expect(shape(layout().root)).toBe("row([*a:t1], [*v:f1])");

    // Volver a la tab que ya era la activa también enfoca su grupo.
    focusGroup(groups()[0]!.id);
    expect(useViewTabsStore.getState().activeViewId).toBeNull();
    expect(layout().focused).toBe(groups()[0]!.id);
  });

  it("activar una vista de otra carpeta deja activo un agente de esa carpeta", () => {
    addAgent(agent("t1", "/a"));
    useViewTabsStore.setState({ views: [file("f1", "/a")] });
    addAgent(agent("t2", "/b"));
    activateItem("v:f1");
    expect(useTabsStore.getState().activeTabId).toBe("t1");
    expect(useViewTabsStore.getState().activeViewId).toBe("f1");
  });

  it("al abrir la app se vuelve a mirar lo que se miraba", () => {
    useTabsStore.setState({ hydrated: false });
    useLayoutStore.setState({
      layouts: {
        "/p": {
          focused: "g2",
          root: {
            kind: "split", id: "s", direction: "row", sizes: [0.5, 0.5],
            children: [
              { kind: "group", id: "g1", items: ["a:t1", "a:t2"], active: "a:t2" },
              { kind: "group", id: "g2", items: ["v:f1"], active: "v:f1" },
            ],
          },
        },
      },
    });
    useViewTabsStore.setState({ views: [file("f1")], activeViewId: null });
    useTabsStore.setState({ tabs: [agent("t1"), agent("t2")], activeTabId: "t1" });
    useTabsStore.setState({ hydrated: true });

    expect(useViewTabsStore.getState().activeViewId).toBe("f1");
    expect(shape(layout().root)).toBe("row([a:t1 *a:t2], [*v:f1])");
    expect(layout().focused).toBe("g2");
  });
});
