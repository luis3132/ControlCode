import { describe, expect, it } from "vitest";

import { addWord, parseWords, removeWord } from "../workingWords";

describe("las palabras de trabajando", () => {
  it("lo guardado se lee, y lo que no se entiende es como no tener lista", () => {
    expect(parseWords(JSON.stringify(["Rumiando", "Tejiendo"]))).toEqual(["Rumiando", "Tejiendo"]);
    expect(parseWords("")).toBeNull();
    expect(parseWords("no es json")).toBeNull();
    expect(parseWords(JSON.stringify([]))).toBeNull();
    expect(parseWords(JSON.stringify(["  ", 3]))).toBeNull();
  });

  it("agregar limpia, no repite y no acepta vacío", () => {
    expect(addWord(["Rumiando"], "  Tejiendo…  ")).toEqual(["Rumiando", "Tejiendo"]);
    expect(addWord(["Rumiando"], "rumiando")).toEqual(["Rumiando"]);
    expect(addWord(["Rumiando"], "   ")).toEqual(["Rumiando"]);
    // Una sola línea: es una etiqueta al lado de un spinner.
    expect(addWord([], "dos\nlíneas")).toEqual(["dos líneas"]);
  });

  it("quitar saca solo esa", () => {
    expect(removeWord(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});
