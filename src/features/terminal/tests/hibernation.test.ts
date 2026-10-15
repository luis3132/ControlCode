import { describe, expect, it } from "vitest";

import { markDormant, rouse, useDormant } from "../hibernation";

describe("tabs dormidas", () => {
  it("una restaurada espera a mostrarse, y se despierta una sola vez", () => {
    markDormant(["a", "b"]);
    expect(useDormant.getState().ids.has("a")).toBe(true);
    expect(rouse("a")).toBe(true);
    expect(rouse("a")).toBe(false);
    expect(useDormant.getState().ids.has("b")).toBe(true);
    expect(rouse("nunca-dormida")).toBe(false);
  });
});
