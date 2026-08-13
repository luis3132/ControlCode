import { describe, expect, it } from "vitest";

import { applyName } from "../frontmatter";

describe("applyName", () => {
  it("reemplaza el name existente y no toca el resto del frontmatter ni el cuerpo", () => {
    const md = "---\nname: viejo\ndescription: hace algo\nversion: 1.0.0\n---\n\n# Instrucciones\n";
    expect(applyName(md, "nuevo")).toBe(
      "---\nname: nuevo\ndescription: hace algo\nversion: 1.0.0\n---\n\n# Instrucciones\n"
    );
  });

  it("agrega el name si el frontmatter no lo tenía", () => {
    const md = "---\ndescription: hace algo\n---\ncuerpo\n";
    expect(applyName(md, "mi-skill")).toBe("---\nname: mi-skill\ndescription: hace algo\n---\ncuerpo\n");
  });

  /// Un archivo sin frontmatter es válido (la metadata es opcional): se le arma uno en vez
  /// de dejar la skill sin nombre.
  it("le arma un frontmatter a un archivo que no tenía", () => {
    expect(applyName("solo cuerpo\n", "mi-skill")).toBe("---\nname: mi-skill\n---\n\nsolo cuerpo\n");
  });

  it("un nombre vacío deja el contenido como estaba", () => {
    const md = "---\nname: viejo\n---\ncuerpo\n";
    expect(applyName(md, "   ")).toBe(md);
  });

  /// El campo se recorta: un nombre con espacios al borde termina siendo el nombre de una
  /// carpeta y de lo que el agente escribe para invocarla.
  it("recorta los espacios del nombre", () => {
    expect(applyName("---\nname: v\n---\nx\n", "  nuevo  ")).toContain("name: nuevo\n");
  });

  /// Solo el `name` de la raíz: una línea `name:` indentada es de otra cosa (un item de
  /// una lista, un mapa anidado) y pisarla rompería el YAML.
  it("no toca un name anidado", () => {
    const md = "---\nname: raiz\ncompatible_versions:\n  name: no-soy-el-nombre\n---\nx\n";
    const out = applyName(md, "nuevo");
    expect(out).toContain("name: nuevo\n");
    expect(out).toContain("  name: no-soy-el-nombre");
  });
});
