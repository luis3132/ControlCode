import { describe, expect, it } from "vitest";

import {
  classifyDocLink, createSlugger, isMarkdownPath, isRemoteSource, parseFrontmatter, resolveDocPath,
} from "../markdown";

describe("qué archivos ofrecen vista previa", () => {
  it("los de Markdown, sin importar mayúsculas", () => {
    expect(isMarkdownPath("/repo/README.md")).toBe(true);
    expect(isMarkdownPath("C:\\repo\\docs\\Guia.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/repo/page.mdx")).toBe(true);
  });

  it("los demás no", () => {
    expect(isMarkdownPath("/repo/main.rs")).toBe(false);
    expect(isMarkdownPath("/repo/.md")).toBe(false);
    expect(isMarkdownPath("/repo/md")).toBe(false);
  });
});

describe("a dónde lleva un enlace", () => {
  const file = "/home/ana/repo/docs/guia.md";
  const root = "/home/ana/repo";

  it("un fragmento es un salto dentro del documento", () => {
    expect(classifyDocLink("#instalación", file, root)).toEqual({ kind: "anchor", id: "instalación" });
    expect(classifyDocLink("#instalaci%C3%B3n", file, root)).toEqual({ kind: "anchor", id: "instalación" });
  });

  it("http, https y mailto son URLs; lo demás con esquema no se sigue", () => {
    expect(classifyDocLink("https://github.com", file, root)).toEqual({ kind: "url", url: "https://github.com" });
    expect(classifyDocLink("mailto:ana@ejemplo.com", file, root)).toEqual({ kind: "url", url: "mailto:ana@ejemplo.com" });
    expect(classifyDocLink("//cdn.ejemplo.com/x", file, root)).toEqual({ kind: "url", url: "https://cdn.ejemplo.com/x" });
    expect(classifyDocLink("javascript:alert(1)", file, root)).toEqual({ kind: "none" });
  });

  it("una ruta es un archivo, relativa a la carpeta del documento", () => {
    expect(classifyDocLink("./api.md", file, root)).toEqual({ kind: "file", path: "/home/ana/repo/docs/api.md" });
    expect(classifyDocLink("../README.md#uso", file, root)).toEqual({ kind: "file", path: "/home/ana/repo/README.md" });
    expect(classifyDocLink("/plan.md", file, root)).toEqual({ kind: "file", path: "/home/ana/repo/plan.md" });
  });

  it("sin destino no hay nada que hacer", () => {
    expect(classifyDocLink(undefined, file, root)).toEqual({ kind: "none" });
    expect(classifyDocLink("   ", file, root)).toEqual({ kind: "none" });
    expect(classifyDocLink("?solo=query", file, root)).toEqual({ kind: "none" });
  });
});

describe("resolver rutas del documento", () => {
  it("decodifica espacios y no sube más allá de la raíz", () => {
    expect(resolveDocPath("/repo/docs/a.md", "mis%20notas/b.md", "/repo")).toBe("/repo/docs/mis notas/b.md");
    expect(resolveDocPath("/repo/a.md", "../../../../x.md", "/repo")).toBe("/x.md");
  });

  it("en Windows conserva la unidad y las barras invertidas", () => {
    expect(resolveDocPath("C:\\repo\\docs\\a.md", "../img/logo.png", "C:\\repo")).toBe("C:\\repo\\img\\logo.png");
    expect(resolveDocPath("C:\\repo\\docs\\a.md", "/README.md", "C:\\repo")).toBe("C:\\repo\\README.md");
  });
});

describe("imágenes de internet", () => {
  it("se reconocen por el esquema", () => {
    expect(isRemoteSource("https://img.shields.io/badge/x.svg")).toBe(true);
    expect(isRemoteSource("//cdn.ejemplo.com/a.png")).toBe(true);
    expect(isRemoteSource("./docs/captura.png")).toBe(false);
    expect(isRemoteSource("/logo.svg")).toBe(false);
  });
});

describe("ids de los títulos", () => {
  it("como los arma GitHub", () => {
    const slug = createSlugger();
    expect(slug("Instalación rápida")).toBe("instalación-rápida");
    expect(slug("What's next?")).toBe("whats-next");
    expect(slug("🚀 A fleet of background agents")).toBe("-a-fleet-of-background-agents");
    expect(slug("CLI reference")).toBe("cli-reference");
  });

  it("los repetidos llevan número", () => {
    const slug = createSlugger();
    expect(slug("Uso")).toBe("uso");
    expect(slug("Uso")).toBe("uso-1");
    expect(slug("Uso")).toBe("uso-2");
  });
});

describe("frontmatter como tabla", () => {
  it("toma las claves de primer nivel y deja el resto como valor", () => {
    const raw = 'name: git-helper\ndescription: "Ayuda con git"\ntags:\n  - git\n  - cli\nversion: 1.2';
    expect(parseFrontmatter(raw)).toEqual([
      ["name", "git-helper"],
      ["description", "Ayuda con git"],
      ["tags", "  - git\n  - cli"],
      ["version", "1.2"],
    ]);
  });
});
