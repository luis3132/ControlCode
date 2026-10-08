/**
 * El nombre de un repo, como lo aceptan GitHub, GitLab y Gitea: letras, números, `-`, `_`
 * y `.`, sin empezar con punto ni guion, hasta 100. La misma regla que
 * `forge::api::valid_repo_name` en Rust.
 */
export function validRepoName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && !/^[.-]/.test(name) && /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * El nombre que se propone para el repo de una carpeta: el de la carpeta, con lo que el
 * host no acepta (espacios, acentos, símbolos) cambiado por `-`. `Mi App (v2)` → `Mi-App-v2`.
 */
export function suggestRepoName(folder: string): string {
  const base = folder.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const plain = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const name = plain.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[.-]+|[-]+$/g, "");
  return name.slice(0, 100);
}
