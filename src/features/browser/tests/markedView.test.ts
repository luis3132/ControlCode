import { describe, expect, it } from "vitest";

import { composePointer, formatMarked, type DescribedElement, type MarkedEntry } from "../markedView";
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

  /// Una captura es lo único que deja "ver" la página: va la ruta sola, para abrirla con
  /// las herramientas de archivos.
  it("las capturas van como archivo que el agente puede abrir", () => {
    const text = formatMarked([], [{ path: "/home/u/.controlcode/captures/a.png", url: "http://127.0.0.1:40111/perfil" }], "", display);
    expect(text).toContain("Screenshots the user annotated");
    expect(text).toContain("/home/u/.controlcode/captures/a.png");
    expect(text).toContain("http://localhost:5173/perfil");
  });
});

describe("composePointer", () => {
  /// Al agente que tiene el MCP se le pega un aviso corto, no el volcado: lo que necesita
  /// lo pide, y lo que no, no le gasta contexto.
  it("es un aviso corto con la nota del usuario", () => {
    const text = composePointer({ picks: 2, captures: 1 }, "http://localhost:5173/perfil", "no anda", {
      marked: (n, url) => `Marqué ${n} elementos en ${url}.`,
      captures: (n) => `Además dejé ${n} captura(s).`,
      read: "Leelo con browser_marked.",
      note: "Nota",
    });
    expect(text).toBe("Marqué 2 elementos en http://localhost:5173/perfil. Además dejé 1 captura(s). Leelo con browser_marked.\n\nNota: no anda");
    expect(composePointer({ picks: 1, captures: 0 }, "u", "", {
      marked: () => "uno", captures: () => "no va", read: "leé", note: "Nota",
    })).toBe("uno leé");
  });
});
