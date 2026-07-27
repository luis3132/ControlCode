/**
 * Compila la CLI (`ccode`) en release y la copia a `src-tauri/binaries/`, que es lo que
 * `bundle.resources` empaqueta dentro de la app.
 *
 * Corre desde `beforeBuildCommand`, o sea antes de que Tauri compile la app: para cuando
 * el bundler mira `binaries/`, el archivo ya está. Compilar acá y no depender de que
 * `tauri build` genere ambos binarios evita el orden inverso (el bundle se arma mirando
 * el directorio, no el output de cargo).
 *
 * No falla el build si algo sale mal: sin este binario la app funciona igual, solo queda
 * sin el botón "Instalar CLI" operativo. Se avisa por stderr.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const isWindows = process.platform === "win32";
const fileName = isWindows ? "ccode.exe" : "ccode";

try {
  execFileSync("cargo", ["build", "--release", "--bin", "ccode"], {
    cwd: tauriDir,
    stdio: "inherit",
  });

  const dest = join(tauriDir, "binaries");
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(tauriDir, "target", "release", fileName), join(dest, fileName));

  console.log(`[stage-cli] ${fileName} listo para empaquetar`);
} catch (error) {
  console.error(
    `[stage-cli] no se pudo preparar la CLI: ${error.message}\n` +
      "El bundle va a salir sin ella; 'Instalar CLI' no va a encontrar el binario."
  );
}
