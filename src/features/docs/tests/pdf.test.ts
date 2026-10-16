import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import { markdownToPdf, titleOf } from "../pdf";

// Un PNG de 1×1.
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("markdownToPdf", () => {
  it("arma un PDF con el título del documento", async () => {
    const bytes = await markdownToPdf("# Informe de arquitectura\n\nTexto con **negrita**, _cursiva_ y `código`.");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe("Informe de arquitectura");
  });

  it("pasa de página cuando el texto no entra", async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Párrafo ${i} con algo de texto para ocupar lugar en la página.`).join("\n\n");
    const pdf = await PDFDocument.load(await markdownToPdf(long));
    expect(pdf.getPageCount()).toBeGreaterThan(2);
  });

  it("no se rompe con lo que las fuentes estándar no escriben, ni con tablas, listas, código y citas", async () => {
    const md = [
      "## Ñandú: ¿qué pasó? 🚀 中文",
      "- uno\n- dos\n  1. anidado\n- [x] hecho",
      "```ts\nconst x = 1; // una línea muy larga ".concat("x".repeat(300), "\n```"),
      "> una cita\n> de dos líneas",
      "| A | B |\n|---|---|\n| 1 | una celda con bastante texto para partir |",
      "---",
      "Una URL larga: https://example.com/".concat("a".repeat(200)),
    ].join("\n\n");
    const pdf = await PDFDocument.load(await markdownToPdf(md));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("pone las imágenes que trae quien llama, y sigue si una no se puede traer", async () => {
    const asked: string[] = [];
    const bytes = await markdownToPdf("Antes\n\n![diagrama](diagrams/a.png)\n\n![rota](nope.png)\n\nDespués", {
      loadImage: async (src) => {
        asked.push(src);
        return src === "nope.png" ? null : { bytes: PIXEL, type: "png" };
      },
    });
    expect(asked).toEqual(["diagrams/a.png", "nope.png"]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("el título sale del primer h1", () => {
    expect(titleOf("intro\n# Título\n## otro")).toBe("Título");
    expect(titleOf("sin títulos")).toBeNull();
  });
});
