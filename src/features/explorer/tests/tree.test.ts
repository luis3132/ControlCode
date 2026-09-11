import { describe, expect, it } from "vitest";

import { flattenTree, markForPath, relativeTo, toggleExpanded } from "../tree";
import type { DirEntry, RepoInfo } from "../types";

const dir = (path: string): DirEntry => ({
  name: path.split("/").pop()!, path, isDir: true, isHidden: false,
});
const file = (path: string): DirEntry => ({
  name: path.split("/").pop()!, path, isDir: false, isHidden: false,
});

const repo = (changes: Record<string, string>): RepoInfo => ({
  root: "/p",
  branch: "main",
  isWorktree: false,
  changes: changes as RepoInfo["changes"],
  changedCount: Object.keys(changes).length,
});

describe("relativeTo", () => {
  it("recorta el root", () => {
    expect(relativeTo("/p", "/p/src/app.tsx")).toBe("src/app.tsx");
  });

  it("tolera el root con barra final", () => {
    expect(relativeTo("/p/", "/p/src/app.tsx")).toBe("src/app.tsx");
  });

  it("el root mismo es la cadena vacía", () => {
    expect(relativeTo("/p", "/p")).toBe("");
  });

  it("devuelve null si la ruta cae fuera del root", () => {
    // Un symlink de skill apunta afuera; marcarlo con el estado de un homónimo del
    // proyecto sería peor que no marcarlo.
    expect(relativeTo("/p", "/home/luis/.controlcode/skills/x")).toBeNull();
  });

  it("no confunde un hermano con un prefijo", () => {
    expect(relativeTo("/p", "/proyecto/src/app.tsx")).toBeNull();
  });

  it("normaliza las barras de Windows", () => {
    expect(relativeTo("C:\\p", "C:\\p\\src\\app.tsx")).toBe("src/app.tsx");
  });
});

describe("markForPath", () => {
  it("marca el archivo que cambió", () => {
    expect(markForPath(repo({ "src/app.tsx": "M" }), file("/p/src/app.tsx"))).toBe("M");
  });

  it("deja sin marca al que no cambió", () => {
    expect(markForPath(repo({ "src/app.tsx": "M" }), file("/p/src/otro.tsx"))).toBeNull();
  });

  it("una carpeta hereda la marca de lo que contiene", () => {
    // Con el árbol plegado, un cambio enterrado tiene que verse desde arriba.
    expect(markForPath(repo({ "src/deep/nested/x.rs": "M" }), dir("/p/src"))).toBe("M");
  });

  it("gana la marca más fuerte de la carpeta", () => {
    const r = repo({ "src/a.ts": "?", "src/b.ts": "M", "src/c.ts": "U" });
    expect(markForPath(r, dir("/p/src"))).toBe("U");
  });

  it("no confunde carpetas con prefijo común", () => {
    // `src-tauri` empieza igual que `src`: sin el separador, heredaría sus cambios.
    expect(markForPath(repo({ "src-tauri/lib.rs": "M" }), dir("/p/src"))).toBeNull();
  });

  it("sin repo no hay marcas", () => {
    expect(markForPath(null, file("/p/src/app.tsx"))).toBeNull();
    const noRepo = { ...repo({}), root: null };
    expect(markForPath(noRepo, file("/p/src/app.tsx"))).toBeNull();
  });
});

describe("flattenTree", () => {
  const loaded = new Map<string, DirEntry[]>([
    ["/p", [dir("/p/src"), file("/p/README.md")]],
    ["/p/src", [dir("/p/src/app"), file("/p/src/main.tsx")]],
    ["/p/src/app", [file("/p/src/app/shortcuts.ts")]],
  ]);

  it("plegado muestra solo el primer nivel", () => {
    const rows = flattenTree("/p", loaded, new Set());
    expect(rows.map((r) => r.entry.name)).toEqual(["src", "README.md"]);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it("expandido baja de nivel", () => {
    const rows = flattenTree("/p", loaded, new Set(["/p/src"]));
    expect(rows.map((r) => r.entry.name)).toEqual(["src", "app", "main.tsx", "README.md"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it("expande varios niveles", () => {
    const rows = flattenTree("/p", loaded, new Set(["/p/src", "/p/src/app"]));
    expect(rows.map((r) => r.entry.name)).toEqual(["src", "app", "shortcuts.ts", "main.tsx", "README.md"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it("un expandido sin leer todavía no rompe nada", () => {
    // La lectura es asíncrona: entre el click y la respuesta, el directorio está
    // expandido pero vacío. Tiene que dibujarse igual, sin hijos.
    const rows = flattenTree("/p", loaded, new Set(["/p/src", "/p/sin-leer"]));
    expect(rows.map((r) => r.entry.name)).toEqual(["src", "app", "main.tsx", "README.md"]);
  });

  it("un symlink que vuelve a un ancestro no cuelga", () => {
    const ciclico = new Map<string, DirEntry[]>([
      ["/p", [dir("/p/link")]],
      ["/p/link", [dir("/p")]],
    ]);
    const rows = flattenTree("/p", ciclico, new Set(["/p/link", "/p"]));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(10);
  });

  it("lleva la marca de git a cada fila", () => {
    const rows = flattenTree("/p", loaded, new Set(["/p/src"]), repo({ "src/main.tsx": "M" }));
    const byName = Object.fromEntries(rows.map((r) => [r.entry.name, r.mark]));
    expect(byName["main.tsx"]).toBe("M");
    expect(byName["src"]).toBe("M");
    expect(byName["README.md"]).toBeNull();
  });
});

describe("toggleExpanded", () => {
  it("abre y cierra sin mutar", () => {
    const a = new Set<string>();
    const b = toggleExpanded(a, "/p/src");
    expect(a.size).toBe(0);
    expect(b.has("/p/src")).toBe(true);
    expect(toggleExpanded(b, "/p/src").has("/p/src")).toBe(false);
  });
});
