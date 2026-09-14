import { describe, expect, it } from "vitest";

import {
  comparablePath, findExisting, isLocalUrl, nextActiveAfterClose, normalizeUrl, relativeTo, toPersisted, viewLabels,
  viewsOfWorkspace, type ViewTab,
} from "../viewTabs";

const file = (id: string, cwd: string, path: string): ViewTab => ({
  kind: "file", id, cwd, path, title: path.split("/").pop()!,
});
const browser = (id: string, cwd: string): ViewTab => ({ kind: "browser", id, cwd, url: "", title: "" });

describe("abrir lo que ya está abierto", () => {
  it("un archivo se reusa, en su workspace y no en otro", () => {
    const views = [file("a", "/p1", "/p1/src/app.ts")];
    expect(findExisting(views, { kind: "file", cwd: "/p1", path: "/p1/src/app.ts" })?.id).toBe("a");
    expect(findExisting(views, { kind: "file", cwd: "/p2", path: "/p1/src/app.ts" })).toBeUndefined();
  });

  it("el diff de lo preparado y el de lo no preparado son dos tabs distintas", () => {
    const views: ViewTab[] = [{ kind: "diff", id: "d", cwd: "/p", root: "/p", path: "a.ts", staged: true, title: "a.ts" }];
    expect(findExisting(views, { kind: "diff", cwd: "/p", root: "/p", path: "a.ts", staged: true })?.id).toBe("d");
    expect(findExisting(views, { kind: "diff", cwd: "/p", root: "/p", path: "a.ts", staged: false })).toBeUndefined();
  });

  it("navegadores puede haber varios", () => {
    expect(findExisting([browser("b", "/p")], { kind: "browser", cwd: "/p", url: "" })).toBeUndefined();
  });
});

describe("cerrar", () => {
  const views = [file("a", "/p", "/p/a"), browser("x", "/otro"), file("b", "/p", "/p/b"), file("c", "/p", "/p/c")];

  it("pasa a la vecina de la izquierda del mismo workspace", () => {
    expect(nextActiveAfterClose(views, "c", "c")).toBe("b");
    // `b` es la segunda del workspace /p: la de su izquierda es `a`, no el navegador de /otro.
    expect(nextActiveAfterClose(views, "b", "b")).toBe("a");
  });

  it("sin vecinas vuelve a la terminal", () => {
    expect(nextActiveAfterClose(views, "x", "x")).toBeNull();
  });

  it("cerrar una que no está activa no cambia la activa", () => {
    expect(nextActiveAfterClose(views, "a", "c")).toBe("c");
  });

  it("la barra solo ve las de su workspace", () => {
    expect(viewsOfWorkspace(views, "/p").map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(viewsOfWorkspace(views, null)).toEqual([]);
  });
});

describe("persistencia", () => {
  it("no guarda lo efímero de un archivo", () => {
    const [saved] = toPersisted([{ ...file("a", "/p", "/p/a"), dirty: true, reveal: { line: 3, column: 0, nonce: 1 } } as ViewTab]);
    expect(saved).not.toHaveProperty("dirty");
    expect(saved).not.toHaveProperty("reveal");
  });
});

describe("títulos repetidos", () => {
  it("solo los homónimos llevan la carpeta que los separa", () => {
    const labels = viewLabels([
      file("a", "/p", "/p/src/tabs/index.ts"),
      file("b", "/p", "/p/src/editor/index.ts"),
      file("c", "/p", "/p/src/app.ts"),
    ]);
    expect(labels.get("a")?.hint).toBe("tabs");
    expect(labels.get("b")?.hint).toBe("editor");
    expect(labels.get("c")?.hint).toBeNull();
  });

  it("el archivo y su diff no chocan: ya los separa el ícono", () => {
    const labels = viewLabels([
      file("a", "/p", "/p/src/app.ts"),
      { kind: "diff", id: "d", cwd: "/p", root: "/p", path: "src/app.ts", staged: false, title: "app.ts" },
    ]);
    expect(labels.get("a")?.hint).toBeNull();
    expect(labels.get("d")?.hint).toBeNull();
  });
});

describe("barra de direcciones", () => {
  it.each([
    ["localhost:5173", "http://localhost:5173"],
    [":3000/login", "http://localhost:3000/login"],
    ["8080", "http://localhost:8080"],
    ["127.0.0.1:8000", "http://127.0.0.1:8000"],
    ["mi-app.local:4000", "http://mi-app.local:4000"],
    ["example.com", "https://example.com"],
    ["https://staging.example.com/x", "https://staging.example.com/x"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it("lo que no parece una dirección no se inventa", () => {
    expect(normalizeUrl("hola")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("reconoce los servidores de esta máquina", () => {
    expect(isLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalUrl("http://[::1]:3000")).toBe(true);
    expect(isLocalUrl("https://github.com/a/b")).toBe(false);
    expect(isLocalUrl("no es url")).toBe(false);
  });
});

describe("rutas de Windows", () => {
  it("el mismo archivo con separadores distintos es la misma tab", () => {
    // Así llega: el árbol con `\\`, git con `/`.
    const views = [file("a", "C:\\proyecto", "C:\\proyecto\\src\\app.ts")];
    expect(findExisting(views, { kind: "file", cwd: "C:/proyecto", path: "C:/proyecto/src/app.ts" })?.id).toBe("a");
    expect(viewsOfWorkspace(views, "c:/proyecto")).toHaveLength(1);
  });

  it("la unidad no distingue mayúsculas, el resto de la ruta sí", () => {
    expect(comparablePath("C:\\Repo\\A.ts")).toBe("c:/Repo/A.ts");
    expect(comparablePath("/home/luis/app.ts")).toBe("/home/luis/app.ts");
  });

  it("la ruta relativa se muestra igual venga como venga", () => {
    expect(relativeTo("C:\\proyecto\\src\\app.ts", "C:/proyecto")).toBe("src/app.ts");
    expect(relativeTo("/home/luis/p/src/a.ts", "/home/luis/p")).toBe("src/a.ts");
    expect(relativeTo("/otro/lado.ts", "/home/luis/p")).toBe("/otro/lado.ts");
  });
});
