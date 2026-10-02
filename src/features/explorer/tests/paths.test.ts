import { describe, expect, it } from "vitest";

import { canDrop, dirFor, dropText, fileMention, isInside, joinPath, parentDir, relativePath, remapPath } from "../paths";

describe("parentDir / joinPath", () => {
  it("respeta el separador de cada sistema", () => {
    expect(parentDir("/a/b/c.ts")).toBe("/a/b");
    expect(parentDir("/a")).toBe("/");
    expect(parentDir("C:\\p\\src\\a.ts")).toBe("C:\\p\\src");
    expect(parentDir("C:\\p")).toBe("C:\\");
    expect(joinPath("/a/b", "c")).toBe("/a/b/c");
    expect(joinPath("C:\\p", "c")).toBe("C:\\p\\c");
    expect(joinPath("/", "c")).toBe("/c");
  });
});

describe("isInside", () => {
  it("no confunde un prefijo de nombre con una carpeta", () => {
    expect(isInside("/p/src/a.ts", "/p/src")).toBe(true);
    expect(isInside("/p/src", "/p/src")).toBe(true);
    expect(isInside("/p/src2/a.ts", "/p/src")).toBe(false);
    expect(isInside("C:/p/src/a.ts", "c:\\p\\src")).toBe(true);
  });
});

describe("dirFor", () => {
  it("una carpeta recibe en sí misma; un archivo, en la suya", () => {
    expect(dirFor({ path: "/p/src", isDir: true })).toBe("/p/src");
    expect(dirFor({ path: "/p/src/a.ts", isDir: false })).toBe("/p/src");
  });
});

describe("canDrop", () => {
  it("mover a la misma carpeta no hace nada; copiar ahí es duplicar", () => {
    expect(canDrop("/p/src/a.ts", "/p/src", false)).toBe(false);
    expect(canDrop("/p/src/a.ts", "/p/src", true)).toBe(true);
    expect(canDrop("/p/src/a.ts", "/p/lib", false)).toBe(true);
  });

  it("una carpeta no entra en sí misma ni en lo suyo", () => {
    expect(canDrop("/p/src", "/p/src", true)).toBe(false);
    expect(canDrop("/p/src", "/p/src/deep", false)).toBe(false);
    expect(canDrop("/p/src", "/p/src2", false)).toBe(true);
  });
});

describe("remapPath", () => {
  it("lleva lo de adentro a la ruta nueva", () => {
    expect(remapPath("/p/src/a.ts", "/p/src", "/p/lib/src")).toBe("/p/lib/src/a.ts");
    expect(remapPath("/p/src", "/p/src", "/p/app")).toBe("/p/app");
    expect(remapPath("/p/src2/a.ts", "/p/src", "/p/app")).toBeNull();
  });
});

describe("fileMention", () => {
  it("relativa a la carpeta del agente, con @", () => {
    expect(fileMention("/p/src/a.ts", "/p", false)).toBe("@src/a.ts");
    expect(fileMention("/p/src", "/p", true)).toBe("@src/");
    expect(fileMention("/p", "/p", true)).toBe("@./");
  });

  it("afuera de su carpeta, relativa con ..; absoluta solo en otra unidad; nunca entre comillas", () => {
    expect(fileMention("/otra/a.ts", "/p", false)).toBe("@../otra/a.ts");
    expect(fileMention("/home/u/proyectos/lib/x.rs", "/home/u/proyectos/app/src", false)).toBe("@../../lib/x.rs");
    expect(fileMention("/home/u/proyectos", "/home/u/proyectos/app", true)).toBe("@../");
    expect(fileMention("D:\\datos\\a.csv", "C:\\p", false)).toBe("@D:\\datos\\a.csv");
    expect(fileMention("/p/mis docs/a.md", "/p", false)).toBe("@mis docs/a.md");
    expect(fileMention("C:\\p\\src\\a.ts", "C:\\p", false)).toBe("@src/a.ts");
  });
});

describe("dropText", () => {
  it("a un agente, menciones; a un shell, rutas citadas", () => {
    const files = [{ path: "/p/src/a.ts", isDir: false }, { path: "/p/mis docs", isDir: true }];
    expect(dropText(files, "/p", false)).toBe("@src/a.ts @mis docs/ ");
    expect(dropText(files, "/p", true)).toBe("/p/src/a.ts '/p/mis docs' ");
    expect(dropText([{ path: "/p/it's.md", isDir: false }], "/p", true)).toBe("'/p/it'\\''s.md' ");
    expect(dropText([], "/p", false)).toBe("");
  });
});

describe("relativePath", () => {
  it("sube con .. hasta lo común y baja", () => {
    expect(relativePath("/p/app", "/p/app/src/a.ts")).toBe("src/a.ts");
    expect(relativePath("/p/app", "/p/lib/b.ts")).toBe("../lib/b.ts");
    expect(relativePath("/p/app/src", "/p/app")).toBe("..");
    expect(relativePath("/p/app", "/p/app")).toBe(".");
    expect(relativePath("/p/app2", "/p/app/a.ts")).toBe("../app/a.ts");
    expect(relativePath("C:\\p\\app", "c:/p/lib/b.ts")).toBe("../lib/b.ts");
    expect(relativePath("C:\\p", "D:\\q")).toBeNull();
  });
});
