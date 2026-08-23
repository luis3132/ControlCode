/**
 * Punto de entrada de los builds. Tres modos:
 *
 *   bun run app:build                     Solo Control Code, para esta máquina, sin
 *                                         empaquetar. Es el build de todos los días:
 *                                         compila y deja el ejecutable en
 *                                         src-tauri/target/release/.
 *
 *   bun run app:build --release           Todo: la app + la CLI `ccode`, empaquetada en
 *                                         instaladores para cada sistema Y arquitectura
 *                                         que esta máquina pueda producir.
 *
 *   bun run app:build --release \
 *     --target aarch64-apple-darwin       Un solo target, elegido a mano. Es lo que usa
 *                                         CI: un runner por celda de la matriz.
 *                                         Acepta el triple o el id corto (macos-arm64).
 *
 *   bun run app:build --list              Muestra qué puede y qué no puede producir esta
 *                                         máquina, sin compilar nada.
 *
 * ## Por qué "cada sistema que esta máquina pueda producir" y no "todos"
 *
 * Empaquetar para los tres sistemas desde uno solo no es posible, y conviene saber
 * exactamente dónde está el límite:
 *
 * - **Linux**: nativo en Linux, y solo para la arquitectura de la máquina. Cruzar de
 *   amd64 a arm64 no está soportado acá: haría falta un sysroot arm64 completo con
 *   webkit2gtk, y el bundler de AppImage además exige correr en hardware ARM de verdad.
 *   Para el arm64 de Linux hay que compilar en una máquina arm64 (en CI, el runner
 *   `ubuntu-22.04-arm`).
 * - **Windows**: nativo en Windows; entre arquitecturas se cruza sin nada extra (el
 *   toolchain de MSVC ya trae el compilador para ARM64). Desde Linux se puede cruzar con
 *   `cargo-xwin` (compilador) y NSIS (instalador). Este script lo hace si están instalados.
 * - **macOS**: solo en macOS, pero ahí las dos arquitecturas se cruzan gratis (el SDK de
 *   Apple trae las dos slices). No es una limitación de este script: el bundle `.app`/`.dmg`
 *   necesita el SDK de Apple y `codesign`, que no existen fuera de macOS y no se pueden
 *   redistribuir. No hay forma de sortearlo desde Linux o Windows.
 *
 * Por eso este script empaqueta lo que puede y **dice explícitamente qué salteó y por
 * qué**, en vez de terminar en verde dejando creer que salieron todos. Para el set completo
 * hay que compilar cada sistema en el suyo: `.github/workflows/release.yml` hace eso
 * con una matriz de runners, que es el único camino real a un release completo.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * El host es (sistema, arquitectura), no solo el sistema: con arm64 en los tres sistemas
 * "puedo compilar esto" dejó de depender únicamente del SO.
 */
const HOST = `${process.platform}-${process.arch}`;

/**
 * `NO_STRIP=true` viene del script original: el paso de strip del bundler de AppImage
 * falla en varias distros. No es una optimización, es lo que hace que el AppImage salga.
 */
const BASE_ENV = { ...process.env, NO_STRIP: "true" };

/** Cruce dentro del mismo SO entre arquitecturas: no hace falta runner ni herramientas. */
const SAME_OS_CROSS = { runner: null, requires: [] };

/** Cruce a Windows desde Linux: cargo-xwin trae el toolchain MSVC y NSIS arma el instalador. */
const XWIN_CROSS = {
  runner: "cargo-xwin",
  requires: [
    { cmd: "cargo-xwin", how: "cargo install cargo-xwin" },
    { cmd: "makensis", how: "instalá NSIS (dnf install mingw32-nsis / apt install nsis)" },
  ],
};

const TARGETS = [
  {
    id: "linux-amd64",
    label: "Linux amd64 (deb, rpm, AppImage)",
    triple: "x86_64-unknown-linux-gnu",
    bundles: ["deb", "rpm", "appimage"],
    nativeOn: { os: "linux", arch: "x64" },
    // Sin crossFrom a propósito: ver el comentario de arriba sobre el arm64 de Linux.
  },
  {
    id: "linux-arm64",
    label: "Linux arm64 (deb, rpm, AppImage)",
    triple: "aarch64-unknown-linux-gnu",
    bundles: ["deb", "rpm", "appimage"],
    nativeOn: { os: "linux", arch: "arm64" },
  },
  {
    id: "windows-amd64",
    label: "Windows amd64 (nsis, msi)",
    triple: "x86_64-pc-windows-msvc",
    bundles: ["nsis", "msi"],
    nativeOn: { os: "win32", arch: "x64" },
    crossFrom: { "linux-x64": XWIN_CROSS },
  },
  {
    id: "windows-arm64",
    label: "Windows arm64 (nsis)",
    triple: "aarch64-pc-windows-msvc",
    // Solo NSIS: WiX (el que arma el .msi) no soporta arm64, y pedírselo no falla al
    // final sino que aborta el bundle entero — así que el .msi no existe para esta arch.
    bundles: ["nsis"],
    nativeOn: { os: "win32", arch: "arm64" },
    crossFrom: { "win32-x64": SAME_OS_CROSS, "linux-x64": XWIN_CROSS },
  },
  {
    id: "macos-arm64",
    label: "macOS arm64 / Apple Silicon (app, dmg)",
    triple: "aarch64-apple-darwin",
    bundles: ["app", "dmg"],
    nativeOn: { os: "darwin", arch: "arm64" },
    crossFrom: { "darwin-x64": SAME_OS_CROSS },
  },
  {
    id: "macos-amd64",
    label: "macOS amd64 / Intel (app, dmg)",
    triple: "x86_64-apple-darwin",
    bundles: ["app", "dmg"],
    nativeOn: { os: "darwin", arch: "x64" },
    crossFrom: { "darwin-arm64": SAME_OS_CROSS },
  },
  {
    id: "macos-universal",
    label: "macOS universal, Intel + Apple Silicon en un bundle (app, dmg)",
    triple: "universal-apple-darwin",
    bundles: ["app", "dmg"],
    nativeOn: { os: "darwin", arch: "*" },
    // Solo si se lo pide por --target: el default ya saca las dos arquitecturas por
    // separado, y el universal es un tercer build completo que las repite.
    optIn: true,
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

function isNative(target) {
  const { os, arch } = target.nativeOn;
  return os === process.platform && (arch === "*" || arch === process.arch);
}

/** Decide cómo (o si) se puede construir un target desde esta máquina. */
function planFor(target) {
  const cross = isNative(target) ? { runner: null, requires: [] } : target.crossFrom?.[HOST];

  if (!cross) {
    return {
      skip:
        target.nativeOn.os === "darwin"
          ? "solo se puede empaquetar desde macOS (necesita el SDK de Apple y codesign)"
          : target.nativeOn.os === "linux"
            ? `hay que compilarlo en una máquina ${target.nativeOn.arch} (no hay cruce soportado desde ${HOST})`
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

  const exe = join(root, "src-tauri", "target", "release", process.platform === "win32" ? "controlcode.exe" : "controlcode");
  console.log(`\n✔ Listo: ${exe}`);
  console.log("  Para instaladores y la CLI: bun run app:build --release\n");
}

function buildEverything(selection) {
  const what = selection.length === 1 ? selection[0].label : "todo lo que esta máquina pueda";
  console.log(`\n▶ Build completo: app + CLI, empaquetado para ${what}\n`);

  const done = [];
  const skipped = [];

  for (const target of selection) {
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
  // Pedir un target explícito y que se saltee no es "no había nada que hacer", es un
  // pedido incumplido: en CI eso tiene que romper la celda de la matriz, no pasarla.
  if (selection.length === 1 && skipped.length === 1) process.exit(1);
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
      "\nPara todos los sistemas y arquitecturas hay que compilar cada uno en el suyo.\n" +
        "El workflow .github/workflows/release.yml lo hace con una matriz de runners."
    );
  }
  console.log("──────────────────────────────────────────\n");
}

/** `--target x` y `--target=x` son la misma cosa; se acepta el id corto o el triple. */
function parseArgs(argv) {
  const flags = { release: false, list: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--release") flags.release = true;
    else if (arg === "--list") flags.list = true;
    else if (arg === "--target") flags.target = argv[++i];
    else if (arg.startsWith("--target=")) flags.target = arg.slice("--target=".length);
  }
  return flags;
}

function resolveTarget(name) {
  const target = TARGETS.find((t) => t.id === name || t.triple === name);
  if (target) return target;

  console.error(`No conozco el target "${name}". Los que hay:\n`);
  for (const t of TARGETS) console.error(`  ${t.id.padEnd(16)} ${t.triple}`);
  process.exit(1);
}

function list() {
  console.log(`\nDesde esta máquina (${HOST}):\n`);
  for (const target of TARGETS) {
    const plan = planFor(target);
    const how = plan.skip
      ? `↷ ${plan.skip}`
      : isNative(target)
        ? "✔ nativo"
        : `✔ cruzado${plan.runner ? ` (${plan.runner})` : ""}`;
    console.log(`  ${target.id.padEnd(16)} ${how}${target.optIn ? "  [solo con --target]" : ""}`);
  }
  console.log("");
}

if (!existsSync(join(root, "src-tauri", "tauri.conf.json"))) {
  console.error("No encuentro src-tauri/tauri.conf.json — ¿estás en la raíz del proyecto?");
  process.exit(1);
}

const flags = parseArgs(process.argv.slice(2));

if (flags.list) list();
else if (flags.target) buildEverything([resolveTarget(flags.target)]);
else if (flags.release) buildEverything(TARGETS.filter((t) => !t.optIn));
else buildOnlyTheApp();
