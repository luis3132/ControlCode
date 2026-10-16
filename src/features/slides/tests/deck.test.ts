import { describe, expect, it } from "vitest";

import {
  SLIDE_LAYOUTS, bodyOf, layoutBody, replaceBody, restoreRefs, themeCss,
  composeSlide, deckCss, deckDirOf, findSlide, inlineRefs, isDeckFile, moveSlide, newSlideName, parseDeck, parseSize,
  relativeRefs, runnerHtml, safeSlideName, serializeDeck, slideDocument, type Deck,
} from "../deck";

const deck = (slides: string[]): Deck => ({ title: "Demo", size: { w: 1920, h: 1080 }, slides });

describe("deck", () => {
  it("ida y vuelta, descartando hojas con nombres peligrosos o repetidas", () => {
    const parsed = parseDeck(JSON.stringify({ title: "X", size: "4:3", slides: ["01-a.html", "../x.html", "index.html", "01-a.html", 3] }));
    expect(parsed).toEqual({ title: "X", size: { w: 1440, h: 1080 }, slides: ["01-a.html"] });
    expect(parseDeck(serializeDeck(parsed))).toEqual(parsed);
    expect(() => parseDeck("{")).toThrow(/JSON/);
  });

  it("tamaños con nombre, ANCHOxALTO, y error con lo que no entiende", () => {
    expect(parseSize("a4")).toEqual({ w: 794, h: 1123 });
    expect(parseSize("1280x720")).toEqual({ w: 1280, h: 720 });
    expect(() => parseSize("gigante")).toThrow(/16:9/);
  });

  it("encuentra la carpeta desde cualquier archivo de adentro", () => {
    expect(deckDirOf("/p/docs/demo.slides/03-x.html")).toBe("/p/docs/demo.slides");
    expect(deckDirOf("/p/docs/demo.slides")).toBe("/p/docs/demo.slides");
    expect(deckDirOf("/p/docs/otra")).toBeNull();
    expect(isDeckFile("/p/demo.slides/deck.json")).toBe(true);
  });

  it("una hoja por número, por nombre de archivo o por su nombre corto", () => {
    const d = deck(["01-portada.html", "02-problema.html"]);
    expect(findSlide(d, 2)).toBe(1);
    expect(findSlide(d, "02-problema.html")).toBe(1);
    expect(findSlide(d, "portada")).toBe(0);
    expect(() => findSlide(d, 5)).toThrow(/tiene 2/);
    expect(() => findSlide(d, "nada")).toThrow(/Hojas/);
  });

  it("nombres de hoja nuevos, numerados y sin repetir", () => {
    expect(newSlideName(deck(["01-a.html"]), "El Problema")).toBe("02-el-problema.html");
    expect(newSlideName(deck(["01-a.html", "03-b.html"]), "c")).toBe("04-c.html");
    expect(() => safeSlideName("../../etc.html")).toThrow();
  });

  it("mover una hoja", () => {
    expect(moveSlide(deck(["a.html", "b.html", "c.html"]), 2, 0).slides).toEqual(["c.html", "a.html", "b.html"]);
  });

  it("una hoja como documento completo que enlaza sus dos CSS", () => {
    const doc = slideDocument("<h1>Hola</h1>", "Portada");
    expect(doc).toContain('<link rel="stylesheet" href="deck.css">');
    expect(doc).toContain("<h1>Hola</h1>");
    expect(slideDocument(doc)).toBe(doc);
  });

  it("lo que muestra la app: los CSS adentro y sin scripts", () => {
    const shown = composeSlide(slideDocument("<p>x</p><script>alert(1)</script>"), "DECK", "THEME");
    expect(shown).toContain("<style>DECK</style><style>THEME</style>");
    expect(shown).not.toContain("<script");
    expect(shown).not.toContain("theme.css");
  });

  it("las imágenes relativas se cambian por su contenido", () => {
    const html = '<img src="assets/a.png"><div style="background:url(assets/b.svg)"></div><a href="https://x.com">x</a>';
    expect(relativeRefs(html)).toEqual(["assets/a.png", "assets/b.svg"]);
    const inlined = inlineRefs(html, new Map([["assets/a.png", "data:image/png;base64,AA"], ["assets/b.svg", "data:image/svg+xml,BB"]]));
    expect(inlined).toContain('src="data:image/png;base64,AA"');
    expect(inlined).toContain("url(data:image/svg+xml,BB)");
  });

  it("el CSS del tamaño y el visor autónomo", () => {
    expect(deckCss({ w: 1920, h: 1080 })).toContain("font-size: 30px");
    const runner = runnerHtml(deck(["01-a.html", "02-b.html"]));
    expect(runner).toContain('"slides":["01-a.html","02-b.html"]');
    expect(runner).not.toMatch(/<\/script>[\s\S]*<\/script>/);
  });
});

describe("editar hojas a mano", () => {
  it("cambia solo el cuerpo y respeta el head de la hoja", () => {
    const file = '<!doctype html><html><head><link rel="stylesheet" href="theme.css"><style>.x{}</style></head><body>\n<h1>Viejo</h1>\n</body></html>';
    const out = replaceBody(file, "<h1>Nuevo</h1>");
    expect(out).toContain("<style>.x{}</style>");
    expect(bodyOf(out)).toBe("<h1>Nuevo</h1>");
    expect(replaceBody("<p>suelto</p>", "<p>x</p>")).toContain('href="deck.css"');
  });

  it("las imágenes vuelven a su ruta al guardar", () => {
    const shown = '<img src="data:image/png;base64,AA"><div style="background:url(data:image/png;base64,AA)"></div>';
    expect(restoreRefs(shown, new Map([["assets/a.png", "data:image/png;base64,AA"]]))).toBe('<img src="assets/a.png"><div style="background:url(assets/a.png)"></div>');
  });

  it("cada diseño arma su hoja, con los textos de quien lo pide y sin dejarlos sin escapar", () => {
    const tx = { title: "<T>", subtitle: "s", heading: "h", point: (n: number) => `p${n}`, quote: "q", author: "a", caption: "c" };
    for (const layout of SLIDE_LAYOUTS) expect(layoutBody(layout, tx).length).toBeGreaterThan(10);
    expect(layoutBody("title", tx)).toContain("&lt;T>");
    expect(layoutBody("image", tx, "assets/x.png")).toContain('src="assets/x.png"');
    expect(layoutBody("text", tx)).toContain("<li>p3</li>");
  });

  it("los temas prearmados cambian solo los colores", () => {
    const dark = themeCss("dark");
    expect(dark).toContain("--bg: #111827");
    expect(dark.replace(/:root \{[\s\S]*?\}/, "")).toBe(themeCss("light").replace(/:root \{[\s\S]*?\}/, ""));
  });
});
