const VERSION = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/**
 * El último tag con forma de versión y los tres que pueden seguirle: parche, menor y mayor
 * (`v1.7.3` → `v1.7.4`, `v1.8.0`, `v2.0.0`). Sin versiones todavía, las dos de arranque.
 */
export function versionSteps(tags: string[]): { latest: string | null; next: string[] } {
  const parsed = tags
    .map((tag) => ({ tag, m: VERSION.exec(tag) }))
    .filter((x): x is { tag: string; m: RegExpExecArray } => x.m !== null)
    .map(({ tag, m }) => ({ tag, prefix: m[1], parts: [Number(m[2]), Number(m[3]), Number(m[4])] }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  const last = parsed[0];
  if (!last) return { latest: null, next: ["v0.1.0", "v1.0.0"] };
  const [major, minor, patch] = last.parts;
  const p = last.prefix;
  return {
    latest: last.tag,
    next: [`${p}${major}.${minor}.${patch + 1}`, `${p}${major}.${minor + 1}.0`, `${p}${major + 1}.0.0`],
  };
}

/**
 * El próximo tag que casi seguro se quiere: el último con forma de versión, con el último
 * número subido (`v1.7.3` → `v1.7.4`). Es solo la propuesta del campo; se edita.
 */
export function nextVersion(tags: string[]): string {
  return versionSteps(tags).next[0];
}
