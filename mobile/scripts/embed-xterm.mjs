// Mete xterm.js dentro del bundle de la app, para la terminal del teléfono.
//
// Va embebido y no por un CDN: así la terminal anda sin depender de un tercero (ni de que
// el teléfono llegue a él), y lo que corre en la WebView es exactamente la versión que
// fija package.json. Corre solo en `postinstall`; el archivo generado no se versiona.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "@xterm", "xterm");
// `</` dentro de un <script> lo cerraría antes de tiempo.
const js = readFileSync(join(pkg, "lib", "xterm.js"), "utf8").replaceAll("</", "<\\/");
const css = readFileSync(join(pkg, "css", "xterm.css"), "utf8");
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;

const out = join(root, "src", "components", "terminal", "xterm.generated.ts");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `// Generado por scripts/embed-xterm.mjs a partir de @xterm/xterm ${version}. No editar.\n` +
    `export const XTERM_VERSION = ${JSON.stringify(version)};\n` +
    `export const XTERM_JS = ${JSON.stringify(js)};\n` +
    `export const XTERM_CSS = ${JSON.stringify(css)};\n`,
);
console.log(`xterm ${version} embebido en ${out}`);
