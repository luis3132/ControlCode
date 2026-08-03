/**
 * Punto de entrada de los builds. Dos modos:
 *
 *   bun run app:build             Solo Control Code, para esta máquina, sin empaquetar.
 *                                 Es el build de todos los días: compila y deja el
 *                                 ejecutable en src-tauri/target/release/.
 *
 *   bun run app:build --release   Todo: la app + la CLI `ccode`, empaquetada en
 *                                 instaladores para cada sistema que esta máquina pueda
 *                                 producir.
 *
 * ## Por qué "cada sistema que esta máquina pueda producir" y no "todos"
 *
 * Empaquetar para los tres sistemas desde uno solo no es posible, y conviene saber
 * exactamente dónde está el límite:
 *
 * - **Linux**: nativo en Linux.
 * - **Windows**: nativo en Windows; desde Linux se puede *cruzar* con `cargo-xwin`
 *   (compilador) y NSIS (instalador). Este script lo hace si están instalados.
 * - **macOS**: solo en macOS. No es una limitación de este script: el bundle `.app`/`.dmg`
 *   necesita el SDK de Apple y `codesign`, que no existen fuera de macOS y no se pueden
 *   redistribuir. No hay forma de sortearlo desde Linux o Windows.
 *
 * Por eso este script empaqueta lo que puede y **dice explícitamente qué salteó y por
 * qué**, en vez de terminar en verde dejando creer que salieron los tres. Para los tres de
 * verdad hay que compilar cada uno en su sistema: `.github/workflows/release.yml` hace eso
 * con una matriz de runners, que es el único camino real a un release completo.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.slice(2).includes("--release");
const HOST = process.platform;

/**
 * `NO_STRIP=true` viene del script original: el paso de strip del bundler de AppImage
 * falla en varias distros. No es una optimización, es lo que hace que el AppImage salga.
 */
const BASE_ENV = { ...process.env, NO_STRIP: "true" };

const TARGETS = [
  {
    id: "linux",
    label: "Linux (deb, rpm, AppImage)",
    triple: "x86_64-unknown-linux-gnu",
    bundles: ["deb", "rpm", "appimage"],
    nativeOn: "linux",
  },
  {
    id: "windows",
    label: "Windows (nsis, msi)",
    triple: "x86_64-pc-windows-msvc",
    bundles: ["nsis", "msi"],
    nativeOn: "win32",
    // Cruce soportado desde Linux: cargo-xwin trae el toolchain MSVC y NSIS arma el
    // instalador. Ambos tienen que estar; sin NSIS compila pero no empaqueta.
    crossFrom: {
      linux: {
        runner: "cargo-xwin",
        requires: [
          { cmd: "cargo-xwin", how: "cargo install cargo-xwin" },
          { cmd: "makensis", how: "instalá NSIS (dnf install mingw32-nsis / apt install nsis)" },
        ],
      },
    },
  },
  {
    id: "macos",
    label: "macOS (app, dmg)",
    // Universal: un solo bundle para Intel y Apple Silicon. Requiere los dos targets.
    triple: "universal-apple-darwin",
    bundles: ["app", "dmg"],
    nativeOn: "darwin",
  },
];

function run(command, args, env = BASE_ENV) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", env });
}

function has(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function rustTargetInstalled(triple) {
  // El universal de macOS no es un target de rustup, son dos.
  const needed =
    triple === "universal-apple-darwin"
      ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
      : [triple];
  try {
    const installed = execFileSync("rustup", ["target", "list", "--installed"], {
      encoding: "utf8",
    });
    return needed.every((t) => installed.includes(t));
  } catch {
    // Sin rustup (toolchain del sistema) no se puede saber: se intenta igual y que falle
    // el compilador con su propio mensaje, que va a ser más preciso que el nuestro.
    return true;
  }
}

/** Decide cómo (o si) se puede construir un target desde esta máquina. */
function planFor(target) {
  if (target.nativeOn === HOST) {
    if (!rustTargetInstalled(target.triple)) {
      return {
        skip: `falta el target de Rust — corré: rustup target add ${target.triple}`,
      };
    }
    return { runner: null };
  }

  const cross = target.crossFrom?.[HOST];
  if (!cross) {
    return {
      skip:
        target.id === "macos"
          ? `solo se puede empaquetar desde macOS (necesita el SDK de Apple y codesign)`
          : `no hay forma soportada de compilarlo desde ${HOST}`,
    };
  }

  const missing = cross.requires.filter((r) => !has(r.cmd));
  if (missing.length > 0) {
    return { skip: `falta ${missing.map((m) => `${m.cmd} (${m.how})`).join(" y ")}` };
  }
  if (!rustTargetInstalled(target.triple)) {
    return { skip: `falta el target de Rust — corré: rustup target add ${target.triple}` };
  }
  return { runner: cross.runner };
}

function buildOnlyTheApp() {
  console.log("\n▶ Compilando Control Code para esta máquina (sin empaquetar, sin CLI)\n");
  run("bunx", ["tauri", "build", "--no-bundle"], { ...BASE_ENV, CC_CLI_SKIP: "1" });

  const exe = join(root, "src-tauri", "target", "release", HOST === "win32" ? "controlcode.exe" : "controlcode");
  console.log(`\n✔ Listo: ${exe}`);
  console.log("  Para instaladores y la CLI: bun run app:build --release\n");
}

function buildEverything() {
  console.log("\n▶ Build completo: app + CLI, empaquetado para todo lo que esta máquina pueda\n");

  const done = [];
  const skipped = [];

  for (const target of TARGETS) {
    const plan = planFor(target);
    if (plan.skip) {
      skipped.push({ target, reason: plan.skip });
      console.log(`↷ ${target.label}: ${plan.skip}`);
      continue;
    }

    console.log(`\n▶ ${target.label}`);
    // Se anuncia porque es un requisito silencioso: si alguien lo saca, el AppImage deja
    // de salir en Fedora y el error del bundler no menciona la variable por ningún lado.
    if (target.bundles.includes("appimage")) console.log("  (NO_STRIP=true — lo necesita el AppImage)");
    console.log("");
    const args = ["tauri", "build", "--target", target.triple, "--bundles", ...target.bundles];
    if (plan.runner) args.push("--runner", plan.runner);

    try {
      run("bunx", args, {
        ...BASE_ENV,
        // La CLI se compila para el MISMO target, no para esta máquina (ver stage-cli).
        CC_CLI_TARGET: target.triple,
        CC_CLI_RUNNER: plan.runner || "cargo",
        // En un build de release, salir sin CLI es un release roto: acá sí corta.
        CC_CLI_STRICT: "1",
      });
      done.push(target);
    } catch {
      skipped.push({ target, reason: "el build falló (mirá el error de arriba)" });
      console.error(`\n✖ ${target.label}: falló\n`);
    }
  }

  summarize(done, skipped);
  // Que falle algo tiene que notarse en el código de salida: en CI, un release a medias
  // que termina en verde es peor que uno que no termina.
  if (skipped.some((s) => s.reason.startsWith("el build falló"))) process.exit(1);
}

function summarize(done, skipped) {
  console.log("\n──────────────────────────────────────────");
  if (done.length > 0) {
    console.log("Empaquetado:");
    for (const t of done) {
      console.log(`  ✔ ${t.label}`);
      console.log(`      src-tauri/target/${t.triple}/release/bundle/`);
    }
  }
  if (skipped.length > 0) {
    console.log("\nNo empaquetado:");
    for (const { target, reason } of skipped) console.log(`  ↷ ${target.label}: ${reason}`);
    console.log(
      "\nPara los tres sistemas hay que compilar cada uno en el suyo.\n" +
        "El workflow .github/workflows/release.yml lo hace con una matriz de runners."
    );
  }
  console.log("──────────────────────────────────────────\n");
}

if (!existsSync(join(root, "src-tauri", "tauri.conf.json"))) {
  console.error("No encuentro src-tauri/tauri.conf.json — ¿estás en la raíz del proyecto?");
  process.exit(1);
}

if (release) buildEverything();
else buildOnlyTheApp();
