import { describe, expect, it } from "vitest";

import { BOTH_PANELS_MIN_WIDTH, closePanel, fitPanels, openPanel, type PanelState } from "../panels";

const NARROW = BOTH_PANELS_MIN_WIDTH - 1;
const WIDE = BOTH_PANELS_MIN_WIDTH;

const state = (patch: Partial<PanelState> = {}): PanelState => ({
  workspacesCollapsed: false,
  explorerCollapsed: false,
  lastOpened: "workspaces",
  autoCollapsed: null,
  ...patch,
});

const apply = (s: PanelState, patch: Partial<PanelState>): PanelState => ({ ...s, ...patch });

describe("openPanel", () => {
  it("en una ventana angosta, abrir uno pliega el otro", () => {
    const s = apply(state({ explorerCollapsed: true }), openPanel(state({ explorerCollapsed: true }), "explorer", NARROW));
    expect(s).toMatchObject({ explorerCollapsed: false, workspacesCollapsed: true, autoCollapsed: "workspaces", lastOpened: "explorer" });
  });

  it("con lugar, los dos quedan abiertos", () => {
    const s = apply(state({ explorerCollapsed: true }), openPanel(state({ explorerCollapsed: true }), "explorer", WIDE));
    expect(s).toMatchObject({ explorerCollapsed: false, workspacesCollapsed: false, autoCollapsed: null });
  });
});

describe("fitPanels", () => {
  it("al achicar la ventana se pliega el que se abrió antes", () => {
    expect(fitPanels(state({ lastOpened: "workspaces" }), NARROW)).toEqual({ explorerCollapsed: true, autoCollapsed: "explorer" });
    expect(fitPanels(state({ lastOpened: "explorer" }), NARROW)).toEqual({ workspacesCollapsed: true, autoCollapsed: "workspaces" });
  });

  it("con uno solo abierto no hay nada que plegar", () => {
    expect(fitPanels(state({ explorerCollapsed: true }), NARROW)).toEqual({});
  });

  it("al agrandarla vuelve el que plegó la app", () => {
    const narrow = apply(state(), fitPanels(state(), NARROW));
    expect(fitPanels(narrow, WIDE)).toEqual({ explorerCollapsed: false, autoCollapsed: null });
  });

  it("lo que plegó la persona no vuelve solo", () => {
    const narrow = apply(state(), fitPanels(state(), NARROW));
    // La persona pliega a mano el que la app había plegado: deja de ser automático.
    const closed = apply(narrow, closePanel(narrow, "explorer"));
    expect(closed.autoCollapsed).toBeNull();
    expect(fitPanels(closed, WIDE)).toEqual({});
  });
});
