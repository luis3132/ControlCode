import { describe, expect, it, vi } from "vitest";

import { createTerminalKeyHandler } from "../terminalKeys";

const event = (type: string, key: string, extra: Partial<KeyboardEvent> = {}) => {
  const preventDefault = vi.fn();
  return {
    type, key, code: "", keyCode: 0, isComposing: false, repeat: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    ...extra,
    preventDefault,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
};
const down = (key: string, extra: Partial<KeyboardEvent> = {}) => event("keydown", key, extra);

describe("Tab no saca el foco de la terminal", () => {
  it("Tab y Shift+Tab se cancelan y los procesa xterm", () => {
    const handler = createTerminalKeyHandler(() => {});
    const tab = down("Tab");
    const shiftTab = down("Tab", { shiftKey: true });
    expect(handler(tab)).toBe(true);
    expect(handler(shiftTab)).toBe(true);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(shiftTab.preventDefault).toHaveBeenCalled();
  });

  it("también con una tecla muerta pendiente", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    const tab = down("Tab");
    expect(handler(tab)).toBe(true);
    expect(tab.preventDefault).toHaveBeenCalled();
  });

  it("Shift+Tab de WebKitGTK (tecla desconocida) se cancela y se reenvía como Tab", () => {
    const redispatch = vi.fn();
    const handler = createTerminalKeyHandler(redispatch);
    const gtkShiftTab = down("Unidentified", { code: "Tab", keyCode: 9, shiftKey: true });
    // xterm no procesa el original, que no sabría leer: procesa el reenviado.
    expect(handler(gtkShiftTab)).toBe(false);
    expect(gtkShiftTab.preventDefault).toHaveBeenCalled();
    expect(redispatch).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true }),
    );
    // Y el reenviado sigue el camino normal, sin volver a reenviarse.
    expect(handler(down("Tab", { code: "Tab", keyCode: 9, shiftKey: true }))).toBe(true);
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Tab queda para el atajo de la app", () => {
    const handler = createTerminalKeyHandler(() => {});
    const ctrlTab = down("Tab", { ctrlKey: true });
    expect(handler(ctrlTab)).toBe(true);
    expect(ctrlTab.preventDefault).not.toHaveBeenCalled();
  });

  it("las demás teclas no se cancelan acá", () => {
    const handler = createTerminalKeyHandler(() => {});
    const a = down("a");
    handler(a);
    expect(a.preventDefault).not.toHaveBeenCalled();
  });
});

describe("AltGr y las teclas muertas no le llegan a xterm", () => {
  it("ni al apretarlas ni al soltarlas", () => {
    const handler = createTerminalKeyHandler(() => {});
    expect(handler(down("AltGraph"))).toBe(false);
    expect(handler(event("keyup", "AltGraph"))).toBe(false);
    expect(handler(down("Dead"))).toBe(false);
    expect(handler(event("keyup", "Dead"))).toBe(false);
  });

  it("el carácter de AltGr lo procesa xterm como cualquier otro", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("AltGraph"));
    expect(handler(down("@"))).toBe(true);
  });

  it("AltGr suelto no deja nada pendiente", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("AltGraph"));
    handler(event("keyup", "AltGraph"));
    expect(handler(down("Enter"))).toBe(true);
    expect(handler(down("b"))).toBe(true);
  });
});

describe("tecla muerta", () => {
  it("la letra normal la procesa xterm", () => {
    const handler = createTerminalKeyHandler(() => {});
    expect(handler(down("a"))).toBe(true);
    expect(handler(down("ñ"))).toBe(true);
  });

  it("el carácter que sigue a la tecla muerta va como texto", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(down("á"))).toBe(false);
    // Y solo ese: la siguiente vuelve a ser una tecla normal.
    expect(handler(down("b"))).toBe(true);
  });

  it("Shift entre la tecla muerta y la letra no rompe la composición (Á)", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(down("Shift", { shiftKey: true }))).toBe(true);
    expect(handler(down("Á", { shiftKey: true }))).toBe(false);
  });

  it("una tecla que no es texto después de la tecla muerta sigue su camino", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(down("ArrowLeft"))).toBe(true);
    expect(handler(down("a"))).toBe(true);
  });

  it("la composición por IME no se toca", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(down("Process", { keyCode: 229 }))).toBe(true);
    expect(handler(down("á", { isComposing: true }))).toBe(true);
    // Terminada la composición, la letra siguiente vuelve a ser una tecla normal.
    expect(handler(down("b"))).toBe(true);
  });

  it("keypress y el soltar de las teclas normales no se filtran", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(event("keypress", "á", { keyCode: 225 }))).toBe(true);
    expect(handler(event("keyup", "a", { keyCode: 65 }))).toBe(true);
  });

  it("un carácter fuera del plano básico cuenta como uno", () => {
    const handler = createTerminalKeyHandler(() => {});
    handler(down("Dead"));
    expect(handler(down("𝒂"))).toBe(false);
  });
});

describe("copiar y pegar", () => {
  const clipboard = (isMac: boolean, selected: boolean) => ({
    isMac,
    hasSelection: () => selected,
    copy: vi.fn(),
    paste: vi.fn(),
  });

  it("Ctrl+C con selección copia y la quita; sin selección es ^C", () => {
    const withSel = clipboard(false, true);
    const ctrlC = down("c", { ctrlKey: true });
    expect(createTerminalKeyHandler(() => {}, withSel)(ctrlC)).toBe(false);
    expect(withSel.copy).toHaveBeenCalledWith(true);
    expect(ctrlC.preventDefault).toHaveBeenCalled();

    const noSel = clipboard(false, false);
    expect(createTerminalKeyHandler(() => {}, noSel)(down("c", { ctrlKey: true }))).toBe(true);
    expect(noSel.copy).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+C copia sin quitar la selección y Ctrl+Shift+V pega", () => {
    const clip = clipboard(false, true);
    const handler = createTerminalKeyHandler(() => {}, clip);
    expect(handler(down("C", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(clip.copy).toHaveBeenCalledWith(false);
    expect(handler(down("V", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(clip.paste).toHaveBeenCalled();
  });

  it("Ctrl+Insert copia y Shift+Insert pega", () => {
    const clip = clipboard(false, true);
    const handler = createTerminalKeyHandler(() => {}, clip);
    expect(handler(down("Insert", { ctrlKey: true }))).toBe(false);
    expect(handler(down("Insert", { shiftKey: true }))).toBe(false);
    expect(clip.copy).toHaveBeenCalled();
    expect(clip.paste).toHaveBeenCalled();
  });

  it("Ctrl+V lo sigue manejando la TUI (Claude Code pega imágenes con él)", () => {
    const clip = clipboard(false, true);
    expect(createTerminalKeyHandler(() => {}, clip)(down("v", { ctrlKey: true }))).toBe(true);
    expect(clip.paste).not.toHaveBeenCalled();
  });

  it("en macOS es ⌘C / ⌘V, y Ctrl+C sigue siendo ^C aunque haya selección", () => {
    const clip = clipboard(true, true);
    const handler = createTerminalKeyHandler(() => {}, clip);
    expect(handler(down("c", { metaKey: true }))).toBe(false);
    expect(handler(down("v", { metaKey: true }))).toBe(false);
    expect(clip.copy).toHaveBeenCalledWith(false);
    expect(clip.paste).toHaveBeenCalled();
    expect(handler(down("c", { ctrlKey: true }))).toBe(true);
  });

  it("copiar sin nada seleccionado no hace nada pero no le llega a la TUI", () => {
    const clip = clipboard(false, false);
    const e = down("C", { ctrlKey: true, shiftKey: true });
    expect(createTerminalKeyHandler(() => {}, clip)(e)).toBe(false);
    expect(clip.copy).not.toHaveBeenCalled();
  });
});
