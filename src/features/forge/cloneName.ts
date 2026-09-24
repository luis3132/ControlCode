/**
 * El nombre de carpeta que git le daría al clon: el último tramo de la URL, sin `.git`.
 * Es la misma regla que `forge::commands::clone_dir_name` en Rust; acá solo sirve para
 * proponerlo en el campo antes de clonar.
 */
export function cloneDirName(url: string): string | null {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name && name !== "." && name !== ".." ? name : null;
}
