import { describe, expect, it } from "vitest";

import { isPresetStep, stepCommand, stepLabel, type PrelaunchPreset } from "../types";

const PRESETS: PrelaunchPreset[] = [
  { id: "p1", name: "entorno conda", command: "conda activate ml", createdAt: 0 },
  { id: "p2", name: "node del proyecto", command: "nvm use", createdAt: 0 },
];

describe("isPresetStep", () => {
  it("distingue un preset guardado de un comando escrito a mano", () => {
    expect(isPresetStep({ presetId: "p1" })).toBe(true);
    expect(isPresetStep({ command: "nvm use" })).toBe(false);
  });
});

describe("stepCommand", () => {
  it("resuelve el preset contra la lista actual", () => {
    expect(stepCommand({ presetId: "p1" }, PRESETS)).toBe("conda activate ml");
  });

  it("un comando suelto se muestra tal cual", () => {
    expect(stepCommand({ command: "source .venv/bin/activate" }, PRESETS))
      .toBe("source .venv/bin/activate");
  });

  /// Un preset borrado NO desaparece de la cadena: se marca. La cadena va a fallar al
  /// lanzar (a propósito) y el usuario tiene que poder ver en qué paso.
  it("un preset que ya no existe devuelve null en vez de desaparecer", () => {
    expect(stepCommand({ presetId: "fantasma" }, PRESETS)).toBeNull();
    expect(stepCommand({ presetId: "p1" }, [])).toBeNull();
  });
});

describe("stepLabel", () => {
  it("solo los pasos guardados tienen nombre", () => {
    expect(stepLabel({ presetId: "p2" }, PRESETS)).toBe("node del proyecto");
    expect(stepLabel({ command: "nvm use" }, PRESETS)).toBeNull();
    expect(stepLabel({ presetId: "fantasma" }, PRESETS)).toBeNull();
  });
});
