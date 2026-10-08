import { describe, expect, it } from "vitest";

import { suggestRepoName, validRepoName } from "../repoName";

describe("nombre del repo", () => {
  it("propone el de la carpeta, con lo que el host no acepta cambiado por guiones", () => {
    expect(suggestRepoName("/home/luis/proyectos/facturas-crear")).toBe("facturas-crear");
    expect(suggestRepoName("/home/luis/Mi App (v2)/")).toBe("Mi-App-v2");
    expect(suggestRepoName("C:\\Users\\luis\\Código Fuente")).toBe("Codigo-Fuente");
    expect(suggestRepoName("/tmp/.oculto")).toBe("oculto");
  });

  it("valida como los hosts", () => {
    expect(validRepoName("facturas-crear")).toBe(true);
    expect(validRepoName("app.web_2")).toBe(true);
    for (const bad of ["", ".oculto", "-guion", "con espacio", "a/b", "ñandú"]) expect(validRepoName(bad)).toBe(false);
  });
});
