import { describe, expect, it } from "vitest";

import { createDeadKeyFilter } from "../kittyTextKeys";

const down = (key: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ type: "keydown", key, keyCode: 0, isComposing: false, ...extra }) as KeyboardEvent;

describe("tecla muerta con el protocolo de Kitty", () => {
  it("la letra normal la procesa xterm", () => {
    const filter = createDeadKeyFilter();
    expect(filter(down("a"))).toBe(true);
    expect(filter(down("ñ"))).toBe(true);
  });

  it("el carácter que sigue a la tecla muerta va como texto", () => {
    const filter = createDeadKeyFilter();
    expect(filter(down("Dead"))).toBe(true);
    expect(filter(down("á"))).toBe(false);
    // Y solo ese: la siguiente vuelve a ser una tecla normal.
    expect(filter(down("b"))).toBe(true);
  });

  it("Shift entre la tecla muerta y la letra no rompe la composición (Á)", () => {
    const filter = createDeadKeyFilter();
    filter(down("Dead"));
    expect(filter(down("Shift", { shiftKey: true }))).toBe(true);
    expect(filter(down("Á", { shiftKey: true }))).toBe(false);
  });

  it("una tecla que no es texto después de la tecla muerta sigue su camino", () => {
    const filter = createDeadKeyFilter();
    filter(down("Dead"));
    expect(filter(down("ArrowLeft"))).toBe(true);
    expect(filter(down("a"))).toBe(true);
  });

  it("la composición por IME no se toca", () => {
    const filter = createDeadKeyFilter();
    filter(down("Dead"));
    expect(filter(down("Process", { keyCode: 229 }))).toBe(true);
    expect(filter(down("á", { isComposing: true }))).toBe(true);
    // Terminada la composición, la letra siguiente vuelve a ser una tecla normal.
    expect(filter(down("b"))).toBe(true);
  });

  it("los demás tipos de evento no se filtran", () => {
    const filter = createDeadKeyFilter();
    filter(down("Dead"));
    expect(filter({ type: "keypress", key: "á", keyCode: 225, isComposing: false } as KeyboardEvent)).toBe(true);
    expect(filter({ type: "keyup", key: "a", keyCode: 65, isComposing: false } as KeyboardEvent)).toBe(true);
  });

  it("un carácter fuera del plano básico cuenta como uno", () => {
    const filter = createDeadKeyFilter();
    filter(down("Dead"));
    expect(filter(down("𝒂"))).toBe(false);
  });
});
