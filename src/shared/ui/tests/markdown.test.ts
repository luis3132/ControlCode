import { describe, expect, it } from "vitest";

import { stripFrontmatter } from "../Markdown";

describe("stripFrontmatter", () => {
  it("saca el bloque inicial", () => {
    const md = "---\nname: una\nversion: 1.0\n---\n# Título\n\nCuerpo.\n";
    expect(stripFrontmatter(md)).toBe("# Título\n\nCuerpo.\n");
  });

  it("deja intacto un archivo sin frontmatter", () => {
    const md = "# Título\n\nCuerpo.\n";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("no corta en un `---` que es una línea horizontal de la prosa", () => {
    // Sin frontmatter al principio no hay nada que sacar, aunque haya `---` más abajo.
    const md = "# Título\n\nUno\n\n---\n\nDos\n";
    expect(stripFrontmatter(md)).toBe(md);
  });

  it("corta en el PRIMER cierre, no en una línea horizontal posterior", () => {
    const md = "---\nname: una\n---\n# Título\n\n---\n\nFinal\n";
    expect(stripFrontmatter(md)).toBe("# Título\n\n---\n\nFinal\n");
  });

  it("tolera el BOM que dejan algunos editores", () => {
    expect(stripFrontmatter("﻿---\nname: una\n---\nCuerpo\n")).toBe("Cuerpo\n");
  });

  it("un frontmatter sin cerrar no se lleva puesto el archivo", () => {
    const md = "---\nname: rota\nsin cierre\n";
    expect(stripFrontmatter(md)).toBe(md);
  });
});
