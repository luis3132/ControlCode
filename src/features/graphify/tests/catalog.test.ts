import { describe, expect, it } from "vitest";

import catalogSource from "../../../../src-tauri/src/graphify/catalog.rs?raw";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

/**
 * El catálogo vive en Rust y sus textos en los JSON de i18n: dos archivos que no se
 * rompen al compilar cuando divergen. Un comando sin traducción no falla — muestra la
 * clave cruda (`settings.graphify.cmd.extract`) adentro de la lista, y eso se descubre
 * mirando la pantalla. Esto los ata, leyendo el fuente igual que `agentResume.test.ts`.
 */
const table = catalogSource.slice(catalogSource.indexOf("const COMMANDS"));

const found = (pattern: RegExp) =>
  [...table.matchAll(pattern)].map((m) => m[1]);

const ids = found(/\n\s+id: "([^"]+)",\n\s+group:/g);
const groups = [...new Set(found(/\n\s+group: "([^"]+)"/g))];
const args = [...new Set(found(/Arg \{ name: "([^"]+)"/g))];

describe("el catálogo de comandos de graphify", () => {
  /// Si el parseo del fuente se rompe (se renombró un campo), todo lo de abajo pasaría
  /// contra listas vacías sin que nadie se entere. Esta es la que avisa.
  it("se pudo leer la tabla de Rust", () => {
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(ids).toContain("extract");
    expect(groups).toContain("skill");
    expect(args).toContain("backend");
  });

  it.each([["es", es], ["en", en]] as const)("cada comando tiene su descripción en %s", (_lang, dict) => {
    const missing = ids.filter((id) => !(`settings.graphify.cmd.${id}` in dict));
    expect(missing).toEqual([]);
  });

  it.each([["es", es], ["en", en]] as const)("cada grupo tiene su título en %s", (_lang, dict) => {
    const missing = groups.filter((g) => !(`settings.graphify.group.${g}` in dict));
    expect(missing).toEqual([]);
  });

  /// Un hueco sin etiqueta cae al nombre crudo (`subcommand`), que es lo que dice el
  /// fuente y no lo que significa.
  it.each([["es", es], ["en", en]] as const)("cada hueco tiene su etiqueta en %s", (_lang, dict) => {
    const missing = args.filter((name) => !(`settings.graphify.arg.${name}` in dict));
    expect(missing).toEqual([]);
  });

  /// Las dos traducciones tienen que cubrir lo mismo: una clave que existe solo en
  /// español deja la interfaz en inglés mostrando la clave.
  it("los dos idiomas tienen las mismas claves de graphify", () => {
    const keysOf = (dict: object) =>
      Object.keys(dict).filter((k) => k.startsWith("settings.graphify")).sort();
    expect(keysOf(es)).toEqual(keysOf(en));
  });
});
