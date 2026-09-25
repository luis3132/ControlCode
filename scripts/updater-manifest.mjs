#!/usr/bin/env bun
/**
 * Arma `latest.json`: lo que lee el actualizador de la app para saber si hay una versión
 * nueva, de dónde bajarla y con qué firma verificarla.
 *
 *   bun scripts/updater-manifest.mjs <carpeta-con-instaladores> <tag> <owner/repo> [notas.md]
 *
 * Lo corre el workflow de release después de juntar los instaladores. Cada instalador
 * firmado (`X` + `X.sig`) entra con la clave `{sistema}-{arquitectura}-{formato}` que busca
 * el plugin (`linux-x86_64-rpm`, `windows-aarch64-nsis`, `darwin-aarch64-app`…): así cada
 * instalación se actualiza con su mismo formato — un .rpm con un .rpm, un AppImage con un
 * AppImage. Uno por sistema y arquitectura va además sin formato (`linux-x86_64`), que es
 * lo que busca el plugin si no sabe cómo se instaló.
 *
 * Sin ningún `.sig` (el build no se firmó: falta el secret) no escribe nada y sale bien:
 * el release se publica igual, solo que sin actualización automática.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** De un nombre de instalador a sus claves, según los nombres que produce el bundler. */
const RULES = [
  { re: /\.x86_64\.rpm$/, keys: ["linux-x86_64-rpm"] },
  { re: /\.aarch64\.rpm$/, keys: ["linux-aarch64-rpm"] },
  { re: /_amd64\.deb$/, keys: ["linux-x86_64-deb"] },
  { re: /_arm64\.deb$/, keys: ["linux-aarch64-deb"] },
  { re: /_amd64\.AppImage$/, keys: ["linux-x86_64-appimage", "linux-x86_64"] },
  { re: /_aarch64\.AppImage$/, keys: ["linux-aarch64-appimage", "linux-aarch64"] },
  { re: /_x64-setup\.exe$/, keys: ["windows-x86_64-nsis", "windows-x86_64"] },
  { re: /_arm64-setup\.exe$/, keys: ["windows-aarch64-nsis", "windows-aarch64"] },
  { re: /_x64_[\w-]+\.msi$/, keys: ["windows-x86_64-msi"] },
  { re: /_x64\.app\.tar\.gz$/, keys: ["darwin-x86_64-app", "darwin-x86_64"] },
  { re: /_aarch64\.app\.tar\.gz$/, keys: ["darwin-aarch64-app", "darwin-aarch64"] },
];

export function platformsFor(files, baseUrl, readSig) {
  const platforms = {};
  for (const file of files) {
    if (file.endsWith(".sig") || !files.includes(`${file}.sig`)) continue;
    const rule = RULES.find((r) => r.re.test(file));
    if (!rule) continue;
    const entry = { url: `${baseUrl}/${encodeURIComponent(file)}`, signature: readSig(`${file}.sig`).trim() };
    for (const key of rule.keys) platforms[key] = entry;
  }
  return platforms;
}

if (import.meta.main) {
  const [dir, tag, repo, notesFile] = process.argv.slice(2);
  if (!dir || !tag || !repo) {
    console.error("uso: bun scripts/updater-manifest.mjs <carpeta> <tag> <owner/repo> [notas.md]");
    process.exit(2);
  }
  const files = readdirSync(dir);
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
  const platforms = platformsFor(files, baseUrl, (f) => readFileSync(join(dir, f), "utf8"));
  if (Object.keys(platforms).length === 0) {
    console.log("No hay instaladores firmados: el release sale sin actualización automática.");
    process.exit(0);
  }
  const manifest = {
    version: tag.replace(/^v/, ""),
    notes: notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "",
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(platforms).sort().join(", ")}`);
}
