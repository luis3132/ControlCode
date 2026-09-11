import { beforeEach, describe, expect, it } from "vitest";

import { useTabsStore } from "../store";
import type { Tab } from "../types";

function row(id: string, cwd = "/p"): Tab {
  return {
    id, title: `tab ${id}`, cwd,
    agentId: "claude-code", agentLabel: "Claude Code", command: "claude",
    ptyId: null, openedAt: 1,
  } as Tab;
}

describe("hydrateFromBackend", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it("hidrata una ventana vacía", () => {
    useTabsStore.getState().hydrateFromBackend([row("a"), row("b")]);
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(["a", "b"]);
    expect(activeTabId).toBe("a");
  });

  it("hidratar dos veces deja lo mismo que hidratar una", () => {
    // El bug: anexaba sin mirar los ids, así que un remontaje del árbol duplicaba todas
    // las tabs. Un error de render en una terminal lo disparaba en bucle: 5 → 10 → 15.
    const payload = [row("a"), row("b"), row("c"), row("d"), row("e")];
    const hydrate = useTabsStore.getState().hydrateFromBackend;
    hydrate(payload);
    hydrate(payload);
    hydrate(payload);
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("conserva una tab que todavía no está en el backend", () => {
    // Se acaba de crear y su fila no persistió aún; hidratar no puede tirarla.
    useTabsStore.setState({ tabs: [row("nueva")], activeTabId: "nueva" });
    useTabsStore.getState().hydrateFromBackend([row("a")]);
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs.map((t) => t.id)).toEqual(["a", "nueva"]);
    expect(activeTabId).toBe("nueva");
  });

  it("la versión del backend pisa a la que estaba en memoria", () => {
    useTabsStore.setState({ tabs: [{ ...row("a"), title: "vieja" }], activeTabId: "a" });
    useTabsStore.getState().hydrateFromBackend([{ ...row("a"), title: "persistida" }]);
    const { tabs } = useTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe("persistida");
  });

  it("si la tab activa desapareció, se activa la primera", () => {
    useTabsStore.setState({ tabs: [], activeTabId: "fantasma" });
    useTabsStore.getState().hydrateFromBackend([row("a"), row("b")]);
    expect(useTabsStore.getState().activeTabId).toBe("a");
  });

  it("adopta el workspace cuando viene", () => {
    useTabsStore.getState().hydrateFromBackend([row("a")], "ws-nuevo");
    expect(useTabsStore.getState().workspaceId).toBe("ws-nuevo");
  });
});
