/**
 * Compila la CLI (`ccode`) y la deja en `src-tauri/binaries/`, que es lo que
 * `bundle.resources` empaqueta dentro de la app.
 *
 * Corre desde `beforeBuildCommand`, o sea antes de que Tauri compile la app: para cuando
 * el bundler mira `binaries/`, el archivo ya está. Compilar acá y no depender de que
 * `tauri build` genere ambos binarios evita el orden inverso (el bundle se arma mirando
 * el directorio, no el output de cargo).
 *
 * Se configura por variables de entorno y no por argumentos, porque quien necesita
 * pasarle algo es `build.mjs`, y lo hace a través de Tauri — que invoca este script como
 * `beforeBuildCommand` sin reenviarle argumentos, pero sí heredando el entorno:
 *
 * - `CC_CLI_TARGET` — triple para el que compilar. Vacío = el de esta máquina.
 *   **Clave al compilar cruzado**: sin esto, un instalador de Windows armado desde Linux
 *   se llevaba adentro un `ccode` de Linux.
 * - `CC_CLI_RUNNER` — reemplazo de `cargo` (ej. `cargo-xwin`) para compilar cruzado.
 * - `CC_CLI_STRICT` — `1` para que un fallo corte el build. Por defecto solo avisa: en el
 *   build de todos los días, quedarse sin el botón "Instalar CLI" no justifica no tener app.
 * - `CC_CLI_SKIP` — `1` para no compilar la CLI en absoluto.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const dest = join(tauriDir, "binaries");

const target = process.env.CC_CLI_TARGET || "";
const runner = process.env.CC_CLI_RUNNER || "cargo";
const strict = process.env.CC_CLI_STRICT === "1";

/** El `.exe` depende del SO de DESTINO, no del de la máquina que compila. */
const isWindowsTarget = target ? target.includes("windows") : process.platform === "win32";
const fileName = isWindowsTarget ? "ccode.exe" : "ccode";

if (process.env.CC_CLI_SKIP === "1") {
  console.log("[stage-cli] omitido (CC_CLI_SKIP=1)");
  process.exit(0);
}

/**
 * Deja `binaries/` con un solo ejecutable: el de este target.
 *
 * Sin esto, empaquetar para varios sistemas seguidos acumulaba los binarios anteriores y
 * el bundler se los llevaba todos — un instalador de Windows con un ejecutable de Linux
 * adentro, además del peso.
 */
function cleanStaleBinaries() {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(dest)) {
    if (entry.startsWith("ccode")) rmSync(join(dest, entry), { force: true });
  }
}

try {
  const args = ["build", "--release", "--bin", "ccode"];
  if (target) args.push("--target", target);

  execFileSync(runner, args, { cwd: tauriDir, stdio: "inherit" });

  const built = target
    ? join(tauriDir, "target", target, "release", fileName)
    : join(tauriDir, "target", "release", fileName);

  cleanStaleBinaries();
  copyFileSync(built, join(dest, fileName));

  console.log(`[stage-cli] ${fileName}${target ? ` (${target})` : ""} listo para empaquetar`);
} catch (error) {
  const message =
    `[stage-cli] no se pudo preparar la CLI: ${error.message}\n` +
    "El bundle va a salir sin ella; 'Instalar CLI' no va a encontrar el binario.";

  console.error(message);
  if (strict) process.exit(1);
}
