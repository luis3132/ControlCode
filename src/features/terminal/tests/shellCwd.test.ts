import { describe, expect, it } from "vitest";

import { parseCwdOsc } from "../shellCwd";

describe("parseCwdOsc", () => {
  it("OSC 7 de bash/zsh/fish, con la ruta codificada", () => {
    expect(parseCwdOsc(7, "file://pc/home/u/mis%20docs")).toBe("/home/u/mis docs");
    expect(parseCwdOsc(7, "file:///tmp")).toBe("/tmp");
    expect(parseCwdOsc(7, "file://pc/C:/Users/u")).toBe("C:/Users/u");
    expect(parseCwdOsc(7, "algo")).toBeNull();
  });

  it("OSC 9;9 del PowerShell de Windows, con o sin comillas", () => {
    expect(parseCwdOsc(9, '9;"C:\\Users\\u\\proyecto"')).toBe("C:\\Users\\u\\proyecto");
    expect(parseCwdOsc(9, "9;C:\\x")).toBe("C:\\x");
  });

  it("las otras OSC 9 (notificaciones de ConEmu, progreso) no son una carpeta", () => {
    expect(parseCwdOsc(9, "4;1;50")).toBeNull();
    expect(parseCwdOsc(9, "Terminó la compilación")).toBeNull();
    expect(parseCwdOsc(52, "c;aGk=")).toBeNull();
  });
});
