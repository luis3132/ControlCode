import { describe, expect, it } from "vitest";

import { fileChange, mainArg, mcpParts, relativePath } from "../ToolCard";

describe("tarjetas de herramientas de un MCP", () => {
  it("separa el servidor de la herramienta", () => {
    expect(mcpParts("mcp__controlcode__browser_click")).toEqual({ server: "controlcode", tool: "browser_click" });
    expect(mcpParts("mcp__claude-in-chrome__javascript_tool")).toEqual({ server: "claude-in-chrome", tool: "javascript_tool" });
    expect(mcpParts("Bash")).toBeNull();
  });

  it("elige el dato que identifica la llamada", () => {
    expect(mainArg({ ref: "e3", url: "http://localhost:5173" })).toBe("http://localhost:5173");
    expect(mainArg({ timeout: 10, text: "hola\nmundo" })).toBe("hola");
    expect(mainArg({ width: 390 })).toBe("390");
    expect(mainArg({ flag: true })).toBeNull();
    expect(mainArg(null)).toBeNull();
  });
});

describe("encabezado de las herramientas de archivo", () => {
  const write = (result: unknown) => ({
    name: "Write",
    input: { file_path: "/p/src/a.ts", content: "uno\ndos\ntres" },
    result: result as never,
  });

  it("un Write que ya corrió sin diff creó el archivo: todo agregado", () => {
    expect(fileChange(write({ content: "ok", isError: false, images: 0, truncated: false, patch: null })))
      .toEqual({ state: "created", path: "/p/src/a.ts", added: 3, removed: 0 });
  });

  it("con el diff de la CLI cuenta lo que de verdad cambió", () => {
    const patch = [{ oldStart: 1, newStart: 1, lines: [" uno", "-dos", "+DOS", "+cuatro", " tres"] }];
    expect(fileChange(write({ content: "ok", isError: false, images: 0, truncated: false, patch })))
      .toEqual({ state: "modified", path: "/p/src/a.ts", added: 2, removed: 1 });
  });

  it("un Write sin correr todavía no sabe cuánto cambia", () => {
    expect(fileChange(write(null))).toEqual({ state: "pending", path: "/p/src/a.ts", added: null, removed: null });
  });

  it("un Edit cuenta solo las líneas distintas", () => {
    const edit = {
      name: "Edit",
      input: { file_path: "/p/b.rs", old_string: "a\nb\nc", new_string: "a\nB\nc" },
      result: null,
    };
    expect(fileChange(edit)).toEqual({ state: "pending", path: "/p/b.rs", added: 1, removed: 1 });
    expect(fileChange({ name: "Bash", input: { command: "ls" }, result: null })).toBeNull();
  });

  it("la ruta va relativa a la carpeta de la tab", () => {
    expect(relativePath("/home/u/proy/src/a.ts", "/home/u/proy")).toBe("src/a.ts");
    expect(relativePath("/home/u/proy/src/a.ts", "/home/u/proy/")).toBe("src/a.ts");
    expect(relativePath("/otra/a.ts", "/home/u/proy")).toBe("/otra/a.ts");
    expect(relativePath("/home/u/proyecto2/a.ts", "/home/u/proy")).toBe("/home/u/proyecto2/a.ts");
  });
});
