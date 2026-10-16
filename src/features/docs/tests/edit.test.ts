import { describe, expect, it } from "vitest";

import { applyDocEdit, relativeLink } from "../edit";

describe("applyDocEdit", () => {
  const doc = "# Título\n\nIntro.\n\n## Detalle\n\nAlgo.\n";

  it("agregar al final deja una línea en blanco y termina en salto de línea", () => {
    expect(applyDocEdit(doc, { mode: "append", content: "## Nuevo\n\nTexto" })).toBe("# Título\n\nIntro.\n\n## Detalle\n\nAlgo.\n\n## Nuevo\n\nTexto\n");
    expect(applyDocEdit("", { mode: "append", content: "# Hola" })).toBe("# Hola\n");
  });

  it("reemplaza o inserta en un fragmento exacto y único", () => {
    expect(applyDocEdit(doc, { mode: "replace", find: "Intro.", content: "Introducción." })).toContain("Introducción.");
    expect(applyDocEdit(doc, { mode: "insert_after", find: "## Detalle\n", content: "\nNuevo párrafo.\n" })).toContain("## Detalle\n\nNuevo párrafo.\n");
  });

  it("dice qué pasa si el fragmento no está o se repite", () => {
    expect(() => applyDocEdit(doc, { mode: "replace", find: "nada", content: "x" })).toThrow(/No encontré/);
    expect(() => applyDocEdit("a a", { mode: "replace", find: "a", content: "x" })).toThrow(/más de una vez/);
    expect(() => applyDocEdit(doc, { mode: "replace", content: "x" })).toThrow(/find/);
  });
});

describe("relativeLink", () => {
  it("la ruta de la imagen vista desde el documento", () => {
    expect(relativeLink("/p/docs/informe.md", "/p/docs/diagrams/a.png")).toBe("diagrams/a.png");
    expect(relativeLink("/p/docs/informe.md", "/p/assets/b.png")).toBe("../assets/b.png");
    expect(relativeLink("/p/README.md", "/p/docs/assets/c.png")).toBe("docs/assets/c.png");
  });
});
