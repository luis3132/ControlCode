import { describe, expect, it } from "vitest";

import { buildPreview } from "../PermissionCard";

/**
 * Lo que se muestra para decidir un permiso.
 *
 * Mostrar el `input` crudo sería técnicamente lo mismo y prácticamente inservible: nadie
 * aprueba un `old_string`/`new_string` escapado. Estos tests fijan que de cada herramienta
 * salga LO QUE SE DECIDE.
 */
describe("buildPreview", () => {
  it("de un Edit sale un diff", () => {
    const p = buildPreview("Edit", {
      file_path: "/home/u/proy/src/app/store.rs",
      old_string: "let a = 1;",
      new_string: "let a = 2;",
    });

    expect(p.title).toBe("Edit(app/store.rs)");
    expect(p.diff).toEqual([
      { sign: "-", text: "let a = 1;" },
      { sign: "+", text: "let a = 2;" },
    ]);
  });

  /// Issue #23: cambiar una línea en un bloque no puede pintar el bloque entero. Lo igual
  /// queda sin color y lo que está lejos del cambio ni se muestra.
  it("de un Edit sale solo lo que cambia, no el bloque entero", () => {
    const old_string = ["fn a() {", "  let x = 1;", "  let y = 2;", "  let z = 3;", "  x + y + z", "}"].join("\n");
    const p = buildPreview("Edit", { file_path: "/a.rs", old_string, new_string: old_string.replace("y = 2", "y = 20") });
    expect(p.diff).toEqual([
      { sign: " ", text: "⋯" },
      { sign: " ", text: "  let x = 1;" },
      { sign: "-", text: "  let y = 2;" },
      { sign: "+", text: "  let y = 20;" },
      { sign: " ", text: "  let z = 3;" },
      { sign: " ", text: "⋯" },
    ]);
  });

  it("de un Write sale todo como agregado", () => {
    const p = buildPreview("Write", { file_path: "/a/b/nuevo.ts", content: "uno\ndos" });
    expect(p.title).toBe("Write(b/nuevo.ts)");
    expect(p.diff.map((l) => l.sign)).toEqual(["+", "+"]);
  });

  /// Para un Bash el comando ES la decisión: no hay diff que mostrar, y fabricar uno solo
  /// escondería lo único que importa leer.
  it("de un Bash sale el comando, sin diff", () => {
    const p = buildPreview("Bash", { command: "git push origin main" });
    expect(p.diff).toEqual([]);
    expect(p.literal).toBe("git push origin main");
  });

  /// Un diff enorme no entra en una tarjeta y taparía el resto de la flota. Se corta.
  it("un diff gigante se recorta", () => {
    const p = buildPreview("Write", {
      file_path: "/a/b.txt",
      content: Array.from({ length: 50 }, (_, i) => `línea ${i}`).join("\n"),
    });
    expect(p.diff.length).toBeLessThanOrEqual(10);
  });

  /// Una herramienta que no conocemos (de un MCP) no se puede dibujar, pero SÍ se tiene que
  /// poder decidir: se muestra su nombre en vez de una tarjeta vacía.
  it("una herramienta desconocida al menos se nombra", () => {
    const p = buildPreview("mcp__foo__bar", { lo_que_sea: 1 });
    expect(p.title).toBe("mcp__foo__bar");
    expect(p.diff).toEqual([]);
    expect(p.literal).toBeUndefined();
  });
});
