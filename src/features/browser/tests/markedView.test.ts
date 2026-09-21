import { describe, expect, it } from "vitest";

import { batchHeader, composePointer, formatMarked, type DescribedElement, type MarkedEntry } from "../markedView";
import type { PickedElement } from "../protocol";

function described(patch: Partial<DescribedElement> = {}): DescribedElement {
  return {
    ref: "u1",
    role: "button",
    name: "Guardar cambios",
    tag: "button",
    selector: "form#perfil > button.primary",
    states: ["disabled"],
    text: "Guardar cambios",
    components: [
      { framework: "React", name: "SaveButton", source: "src/components/SaveButton.tsx:24" },
      { framework: "React", name: "ProfileForm" },
    ],
    ancestors: ["form#perfil", "section.card"],
    attributes: { type: "submit", "data-testid": "save" },
    classes: ["primary"],
    box: { x: 340, y: 512, width: 120, height: 36, visible: true, covered: null },
    viewport: { width: 1280, height: 800 },
    styles: { display: "flex", color: "rgb(255, 255, 255)" },
    html: "<button class=\"primary\" disabled>Guardar cambios</button>",
    url: "http://127.0.0.1:40111/perfil",
    ...patch,
  };
}

const display = (url: string) => url.replace("http://127.0.0.1:40111", "http://localhost:5173");

describe("formatMarked", () => {
  /// Es la diferencia entre "arreglá el botón" y saber qué componente lo dibuja, dónde
  /// está y con qué ref tocarlo sin volver a buscarlo.
  it("dice qué es, de dónde sale y cómo actuar sobre eso", () => {
    const text = formatMarked([{ live: true, element: described() }], [], "no hace nada", display);
    expect(text).toContain("The user marked 1 element(s) in http://localhost:5173/perfil");
    expect(text).toContain('1. button "Guardar cambios" [ref=u1] [disabled]');
    expect(text).toContain("component: SaveButton (React) — src/components/SaveButton.tsx:24 (inside ProfileForm)");
    expect(text).toContain("inside: form#perfil › section.card");
    expect(text).toContain("box: 120×36 at (340, 512) in a 1280×800 viewport, visible");
    expect(text).toContain('attributes: type="submit" data-testid="save"');
    expect(text).toContain("browser_click u1");
    expect(text).toContain("Note from the user: no hace nada");
  });

  /// Un botón que no responde suele tener un overlay encima, y eso no se ve en el HTML.
  it("avisa cuando algo lo tapa o no se ve", () => {
    const text = formatMarked(
      [{ live: true, element: described({ box: { x: 0, y: 0, width: 10, height: 10, visible: true, covered: "div.modal" } }) }],
      [], "", display
    );
    expect(text).toContain("covered by div.modal");
  });

  /// Entre que se marca y el agente lee, la página pudo cambiar: lo que ya no está se dice
  /// así, con lo que se sabía, en vez de inventar un elemento que no existe.
  it("lo que ya no está en la página se marca como tal", () => {
    const stale: PickedElement = {
      url: "http://127.0.0.1:40111/perfil", title: "Perfil", selector: "#viejo", tag: "div",
      text: "Cargando", html: "<div>Cargando</div>", attributes: {},
      rect: { x: 0, y: 0, width: 0, height: 0 }, component: { framework: "Vue", name: "Spinner" },
    };
    const entries: MarkedEntry[] = [{ live: false, element: stale }];
    const text = formatMarked(entries, [], "", display);
    expect(text).toContain("no longer in the page");
    expect(text).toContain("component: Spinner (Vue)");
    expect(text).toContain("page: http://localhost:5173/perfil");
  });

  it("los refs se accionan con el nombre de tool que tenga ESE agente", () => {
    const entry = { live: true as const, element: described() };
    expect(formatMarked([entry], [], "", display)).toContain("(browser_click u1, browser_type u2 …)");
    expect(formatMarked([entry], [], "", display, "controlcode_"))
      .toContain("(controlcode_browser_click u1, controlcode_browser_type u2 …)");
  });

  /// Una captura es lo único que deja "ver" la página: va la ruta sola, para abrirla con
  /// las herramientas de archivos.
  it("las capturas van como archivo que el agente puede abrir", () => {
    const text = formatMarked([], [{ id: "s-aaaa1111", path: "/home/u/.controlcode/captures/a.png", url: "http://127.0.0.1:40111/perfil" }], "", display);
    expect(text).toContain("Screenshots the user annotated");
    // Con su id: es lo que el agente puede pasarle a browser_marked sin equivocarse.
    expect(text).toContain("[s-aaaa1111]");
    expect(text).toContain("/home/u/.controlcode/captures/a.png");
    expect(text).toContain("http://localhost:5173/perfil");
  });
});

describe("composePointer", () => {
  /// Al agente que tiene el MCP se le pega un aviso corto, no el volcado: lo que necesita
  /// lo pide, y lo que no, no le gasta contexto. En inglés: es un prompt, no interfaz.
  it("es un aviso corto, en inglés, con el lote que le toca y la nota tal cual", () => {
    const text = composePointer({ picks: 2, captures: 1 }, "http://localhost:5173/perfil", "no anda", [], "m-3f9a71c4");
    expect(text.split("\n")).toEqual([
      "I marked 2 elements for you in http://localhost:5173/perfil."
      + " I left 1 annotated screenshot of that page."
      + " Read it with browser_marked id=m-3f9a71c4 — that id is yours and returns exactly this: the"
      + " component and source file that rendered each element, where it sits, its styles and a ref you can act on.",
      "",
      "Note from the user: no anda",
    ]);
  });

  /// OpenCode registra las tools con el nombre del servidor de prefijo. Si el aviso lo
  /// manda a `browser_marked`, lo manda a una tool que en su lista no existe.
  it("nombra la tool como la tiene que escribir ESE agente", () => {
    const opencode = composePointer({ picks: 1, captures: 0 }, "http://localhost:5173/", "", [], "m-3f9a71c4", "controlcode_");
    expect(opencode).toContain("Read it with controlcode_browser_marked id=m-3f9a71c4");
    const sinLote = composePointer({ picks: 1, captures: 0 }, "http://localhost:5173/", "", [], undefined, "controlcode_");
    expect(sinLote).toContain("Read it with controlcode_browser_marked:");
  });

  it("sin lote no promete un lote, y un solo elemento va en singular", () => {
    const text = composePointer({ picks: 1, captures: 0 }, "http://localhost:5173/", "");
    expect(text).toContain("I marked 1 element for you");
    expect(text).toContain("Read it with browser_marked:");
    expect(text).not.toContain("batch");
  });

  it("la ruta de cada captura va sola en su renglón", () => {
    // La imagen ya está en disco: es un hecho que no cambia, así que va en el aviso y no
    // solo en la tool. Sola en su renglón, que es como una TUI la reconoce y la adjunta.
    const text = composePointer(
      { picks: 0, captures: 2 },
      "http://localhost:5173/",
      "mirá esto",
      ["/tmp/controlcode/capturas/a.png", "/tmp/controlcode/capturas/b.png"],
      "m-0b12e4aa"
    );
    const lines = text.split("\n");
    // Sin elementos marcados, esta frase es la única que dice de qué página es la captura.
    expect(lines[0]).toContain("I left 2 annotated screenshots of http://localhost:5173/.");
    expect(lines.slice(1)).toEqual([
      "",
      "/tmp/controlcode/capturas/a.png",
      "/tmp/controlcode/capturas/b.png",
      "",
      "Note from the user: mirá esto",
    ]);
  });
});

describe("batchHeader", () => {
  it("dice de quién es el lote, hace cuánto llegó y que es la última vez que se sirve", () => {
    const text = batchHeader({ id: "m-2b2b2b2b", at: 1000 }, 1000 + 45_000);
    expect(text).toContain("m-2b2b2b2b");
    expect(text).toContain("45s ago");
    expect(text).toContain("last time it is served");
    expect(batchHeader({ id: "m-2b2b2b2b", at: 0 }, 300_000)).toContain("5 min ago");
  });
});
