import { resolveConfig, transformWithEsbuild } from "vite";
import { describe, expect, it } from "vitest";

import xtermSource from "@xterm/xterm/lib/xterm.mjs?raw";

/**
 * El bug que rompió la terminal en el release de Linux (ver `build.target` en
 * vite.config.ts): con un target sin asignación lógica, esbuild minificado convierte
 * `let r; f(r ||= {})` en una asignación a una variable que no existe.
 *
 * Se prueba con el target que resuelve Vite de verdad, sin variables de Tauri: el de
 * macOS y Linux, que son los que compilan contra WebKit.
 */
const XTERM_PATTERN = `(() => {
  let r;
  ((e) => { e[e.SET = 1] = "SET"; })(r ||= {});
})();`;

/** Lo que deja esbuild cuando se equivoca: `void 0 || (i = {})`. */
const BROKEN = /void 0\|\|\([\w$]+=\{\}\)/;

async function webkitTarget(): Promise<string> {
  const config = await resolveConfig({ configFile: "vite.config.ts", logLevel: "silent" }, "build", "production");
  const target = config.build.target;
  if (typeof target !== "string") throw new Error(`target inesperado: ${String(target)}`);
  return target;
}

/** Como minifica Vite el build: para Safari < 14.1 le avisa a esbuild que la
 *  desestructuración está soportada (si no, esbuild se niega a bajar la de xterm). */
async function minify(code: string, target: string): Promise<string> {
  const supported = /^safari(1[0-3]|14)$/.test(target) ? { destructuring: true } : undefined;
  return (await transformWithEsbuild(code, "probe.js", { minify: true, target, supported })).code;
}

/** Corre el código en modo estricto, como un módulo: ahí asignar sin declarar es un error. */
const runStrict = (code: string) => new Function(`"use strict";\n${code}`)();

describe("target del build", () => {
  it("el patrón de xterm sobrevive al minificado para WebKit", async () => {
    const code = await minify(XTERM_PATTERN, await webkitTarget());
    expect(() => runStrict(code)).not.toThrow();
  });

  it("con safari13 se rompe (si esto falla, esbuild lo arregló y el test ya no prueba nada)", async () => {
    const code = await minify(XTERM_PATTERN, "safari13");
    expect(() => runStrict(code)).toThrow(ReferenceError);
  });

  it("xterm entero, minificado para WebKit, no trae asignaciones rotas", async () => {
    // Primero, que el detector encuentre lo que tiene que encontrar: con safari13 está.
    expect(await minify(xtermSource, "safari13")).toMatch(BROKEN);
    expect(await minify(xtermSource, await webkitTarget())).not.toMatch(BROKEN);
  }, 30_000);
});
