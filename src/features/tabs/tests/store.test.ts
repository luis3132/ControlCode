import { beforeEach, describe, expect, it } from "vitest";

import { useTabsStore } from "../store";
import { DEFAULT_WORKSPACE_ID, type AgentInfo, type Tab } from "../types";

const CLAUDE: AgentInfo = {
  id: "claude-code",
  label: "Claude Code",
  command: "claude",
  available: true,
};
const BASH: AgentInfo = { id: "bash", label: "Terminal (bash)", command: "bash", available: true };

const store = () => useTabsStore.getState();

function reset() {
  useTabsStore.setState({
    tabs: [],
    activeTabId: null,
    workspaceId: DEFAULT_WORKSPACE_ID,
    hydrated: false,
  });
}

function restored(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    title: id,
    cwd: "/proj",
    agentId: "claude-code",
    agentLabel: "Claude Code",
    command: "claude",
    ptyId: null,
    openedAt: 0,
    ...patch,
  };
}

beforeEach(reset);

describe("addTab", () => {
  it("deriva el título de la carpeta y deja la tab nueva activa", () => {
    const id = store().addTab({ cwd: "/home/u/mi-proyecto", agent: CLAUDE });
    const tab = store().tabs[0];
    expect(tab.title).toBe("Claude Code — mi-proyecto");
    expect(store().activeTabId).toBe(id);
  });

  /// bash no es un agente: poner "Terminal (bash) — carpeta" en la pestaña gasta el ancho
  /// en repetir lo mismo en todas.
  it("una terminal pelada se titula solo con la carpeta", () => {
    store().addTab({ cwd: "/home/u/mi-proyecto", agent: BASH });
    expect(store().tabs[0].title).toBe("mi-proyecto");
  });

  it("un título explícito manda sobre el derivado", () => {
    store().addTab({ cwd: "/proj", agent: CLAUDE, title: "Mío", titleIsCustom: true });
    expect(store().tabs[0].title).toBe("Mío");
    expect(store().tabs[0].titleIsCustom).toBe(true);
  });

  it("una ruta con barra final igual da el nombre de la carpeta", () => {
    store().addTab({ cwd: "/home/u/proyecto/", agent: BASH });
    expect(store().tabs[0].title).toBe("proyecto");
  });
});

describe("closeTab", () => {
  /// Cerrar la tab activa tiene que dejar el foco en la de la IZQUIERDA: es la que el
  /// usuario estaba viendo antes, y saltar a la derecha lo manda a otra parte del trabajo.
  it("al cerrar la activa se activa la anterior", () => {
    const a = store().addTab({ cwd: "/a", agent: CLAUDE });
    const b = store().addTab({ cwd: "/b", agent: CLAUDE });
    const c = store().addTab({ cwd: "/c", agent: CLAUDE });

    store().activateTab(b);
    store().closeTab(b);
    expect(store().activeTabId).toBe(a);

    store().closeTab(a);
    expect(store().activeTabId).toBe(c);
  });

  it("cerrar una que no está activa no mueve el foco", () => {
    const a = store().addTab({ cwd: "/a", agent: CLAUDE });
    const b = store().addTab({ cwd: "/b", agent: CLAUDE });
    store().activateTab(b);
    store().closeTab(a);
    expect(store().activeTabId).toBe(b);
  });

  it("cerrar la última deja la ventana sin tab activa", () => {
    const a = store().addTab({ cwd: "/a", agent: CLAUDE });
    store().closeTab(a);
    expect(store().tabs).toHaveLength(0);
    expect(store().activeTabId).toBeNull();
  });
});

describe("reorderTabs", () => {
  it("mueve la tab conservando el resto del orden", () => {
    const ids = ["/a", "/b", "/c"].map((cwd) => store().addTab({ cwd, agent: BASH }));
    store().reorderTabs(0, 2);
    expect(store().tabs.map((t) => t.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("mover una tab a su propia posición no cambia nada", () => {
    const ids = ["/a", "/b"].map((cwd) => store().addTab({ cwd, agent: BASH }));
    store().reorderTabs(1, 1);
    expect(store().tabs.map((t) => t.id)).toEqual(ids);
  });
});

describe("hydrateFromBackend", () => {
  it("con la ventana vacía adopta las tabs guardadas y activa la primera", () => {
    store().hydrateFromBackend([restored("t1"), restored("t2")], "ws-1");
    expect(store().tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(store().activeTabId).toBe("t1");
    expect(store().workspaceId).toBe("ws-1");
  });

  /// El caso de una tab que llegó por detach/merge ANTES de que la ventana terminara de
  /// hidratar: las guardadas se anexan, no pisan lo que ya está en memoria.
  it("si ya hay tabs en memoria, las restauradas se anexan sin pisarlas", () => {
    const viva = store().addTab({ cwd: "/viva", agent: CLAUDE });
    store().hydrateFromBackend([restored("t1")]);
    expect(store().tabs.map((t) => t.id)).toEqual(["t1", viva]);
    expect(store().activeTabId).toBe(viva);
  });

  it("sin workspace en el payload conserva el que ya tenía", () => {
    useTabsStore.setState({ workspaceId: "ws-actual" });
    store().hydrateFromBackend([restored("t1")]);
    expect(store().workspaceId).toBe("ws-actual");
  });
});

describe("renameTab", () => {
  /// Renombrar a mano marca el título como del usuario: a partir de ahí el refresco
  /// automático deja de pisarlo con el que sale de la sesión.
  it("marca el título como custom", () => {
    const id = store().addTab({ cwd: "/proj", agent: CLAUDE });
    store().renameTab(id, "Mi tarea");
    expect(store().tabs[0]).toMatchObject({ title: "Mi tarea", titleIsCustom: true });
  });
});
