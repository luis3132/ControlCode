import { describe, expect, it } from "vitest";

import { coarseMedia, mentionsPointer } from "../page/touch";

describe("coarseMedia", () => {
  /// Es lo que decide si emular un teléfono es real o solo angosto: `(hover: hover)` es la
  /// consulta con la que una página esconde su menú táctil.
  it("contesta hover y puntero como una pantalla táctil", () => {
    expect(coarseMedia("(hover: hover)")).toBe("(min-width: 99999px)");
    expect(coarseMedia("(hover: none)")).toBe("(min-width: 0px)");
    expect(coarseMedia("(pointer: fine)")).toBe("(min-width: 99999px)");
    expect(coarseMedia("(pointer: coarse)")).toBe("(min-width: 0px)");
  });

  /// `any-hover` pregunta por CUALQUIER dispositivo apuntador conectado. En el táctil que
  /// se emula no hay ninguno con hover, así que contesta igual que `hover`.
  it("trata any-hover y any-pointer igual", () => {
    expect(coarseMedia("(any-hover: hover)")).toBe("(min-width: 99999px)");
    expect(coarseMedia("(any-pointer: coarse)")).toBe("(min-width: 0px)");
  });

  /// La forma booleana pregunta si la capacidad existe: un táctil no tiene hover, pero sí
  /// tiene puntero (grueso). Confundirlas apagaría estilos que en un teléfono sí aplican.
  it("la forma sin valor distingue hover de puntero", () => {
    expect(coarseMedia("(hover)")).toBe("(min-width: 99999px)");
    expect(coarseMedia("(pointer)")).toBe("(min-width: 0px)");
  });

  it("deja intacto el resto de la consulta", () => {
    expect(coarseMedia("screen and (min-width: 768px) and (hover: hover)"))
      .toBe("screen and (min-width: 768px) and (min-width: 99999px)");
    expect(coarseMedia("(min-width: 600px)")).toBe("(min-width: 600px)");
    expect(coarseMedia("print")).toBe("print");
  });

  it("acepta los espacios que escribe la gente y los que deja un minificador", () => {
    expect(coarseMedia("( hover : hover )")).toBe("(min-width: 99999px)");
    expect(coarseMedia("(HOVER:HOVER)")).toBe("(min-width: 99999px)");
  });

  /// Reescribir una consulta que no habla del puntero sería tocar reglas que no hacía falta
  /// tocar, y dejarlas rotas si algo sale mal.
  it("solo se reescribe lo que habla de hover o puntero", () => {
    expect(mentionsPointer("(hover: hover)")).toBe(true);
    expect(mentionsPointer("(any-pointer: fine)")).toBe(true);
    expect(mentionsPointer("(min-width: 600px)")).toBe(false);
    expect(mentionsPointer("screen")).toBe(false);
  });
});
