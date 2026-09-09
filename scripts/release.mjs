/**
 * Saca una versión: sube el número, commitea, taggea y empuja.
 *
 *   bun run release 1.5.0
 *   bun run release 1.5.0 --dry     Muestra lo que haría y no toca nada.
 *
 * El push del tag es lo que dispara `.github/workflows/release.yml`, que compila en los
 * tres sistemas y publica el release con los instaladores colgados. O sea que esto es
 * todo lo que hay que hacer a mano.
 *
 * ## Por qué un guion y no editar los archivos
 *
 * La versión vive en cuatro lugares (package.json, tauri.conf.json, Cargo.toml y el
 * Cargo.lock) y tienen que coincidir: el instalador saca su versión de tauri.conf.json y
 * `ccode --version` del Cargo.toml, así que un olvido produce una app que dice una cosa y
 * una CLI que dice otra. Es exactamente el error que un guion no comete.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const version = args.find((a) => !a.startsWith("-"));

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function run(cmd, argv) {
  if (dry) {
    console.log(`  [dry] ${cmd} ${argv.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

if (!version) die("Falta la versión.  Uso: bun run release 1.5.0 [--dry]");
// Sin la `v`: el tag la lleva, los archivos no. Aceptarla acá y quitarla sola invita a
// que un archivo termine con "v1.5.0" adentro.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`"${version}" no es una versión válida. Se espera 1.5.0 o 1.5.0-beta.1, sin la "v".`);
}

const tag = `v${version}`;

// El árbol tiene que estar limpio: si no, el commit de versión se lleva puesto trabajo a
// medio hacer y queda dentro del tag que después se compila.
const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.trim()) die("Hay cambios sin commitear. Guardalos o descartalos antes de sacar una versión.");

const existing = execFileSync("git", ["tag", "--list", tag], { cwd: root, encoding: "utf8" });
if (existing.trim()) die(`El tag ${tag} ya existe.`);

// ── Los cuatro lugares ───────────────────────────────────────────
/** ¿Se cambió algún archivo? Si no, no hay commit que hacer (ver más abajo). */
let cambios = false;

/**
 * Pone la versión en un archivo.
 *
 * Distingue tres casos, porque no son lo mismo: el patrón no aparece (el archivo cambió
 * de formato y hay que arreglar esto), ya estaba en la versión pedida (no es un error —
 * pasa al retaggear una versión cuyo bump se hizo a mano), o se actualizó.
 */
function bump(relPath, pattern, replacement) {
  const file = join(root, relPath);
  const before = readFileSync(file, "utf8");
  if (!pattern.test(before)) {
    die(`No encontré la versión en ${relPath} — ¿cambió su formato?`);
  }
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.log(`  = ${relPath} (ya estaba en ${version})`);
    return;
  }
  console.log(`  ✔ ${relPath}`);
  cambios = true;
  if (!dry) writeFileSync(file, after);
}

console.log(`\n▶ ${tag}\n`);
bump("package.json", /("version":\s*)"[^"]+"/, `$1"${version}"`);
bump("src-tauri/tauri.conf.json", /("version":\s*)"[^"]+"/, `$1"${version}"`);
// Solo el `[package]` de arriba de todo, no la versión de alguna dependencia: se ancla al
// `name = "controlcode"` que lo precede.
bump("src-tauri/Cargo.toml", /(name = "controlcode"\s*\nversion = )"[^"]+"/, `$1"${version}"`);

// El lock se regenera solo: escribirlo a mano es donde se desincroniza.
if (cambios) {
  console.log("  ⟳ Cargo.lock");
  run("cargo", ["update", "--workspace", "--manifest-path", "src-tauri/Cargo.toml"]);
}

// ── Commit, tag, push ────────────────────────────────────────────
// Sin cambios no hay commit: `git commit` sobre un árbol limpio falla, y taggear el commit
// que ya está es exactamente lo correcto cuando el bump se hizo por otro lado.
if (cambios) {
  const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
  run("git", ["add", ...files]);
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
} else {
  console.log(`\n  Los cuatro archivos ya estaban en ${version} — se taggea el commit actual.`);
}
run("git", ["tag", "-a", tag, "-m", tag]);

const notes = `.github/releases/${tag}.md`;
console.log(`\n▶ Empujando ${tag} — el workflow compila y publica\n`);
run("git", ["push"]);
run("git", ["push", "origin", tag]);

console.log(`
──────────────────────────────────────────
  ${tag} en camino.

  Seguilo:   https://github.com/luis3132/ControlCode/actions
  Notas:     ${notes}${dry ? "" : ""}
             (si ese archivo no existe, GitHub genera las notas solo)
──────────────────────────────────────────
`);
