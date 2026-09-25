/**
 * El próximo tag que casi seguro se quiere: el último con forma de versión, con el último
 * número subido (`v1.7.3` → `v1.7.4`). Es solo la propuesta del campo; se edita.
 */
export function nextVersion(tags: string[]): string {
  const version = /^(v?)(\d+)\.(\d+)\.(\d+)$/;
  const parsed = tags
    .map((t) => version.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ prefix: m[1], parts: [Number(m[2]), Number(m[3]), Number(m[4])] }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  const latest = parsed[0];
  if (!latest) return "v0.1.0";
  const [major, minor, patch] = latest.parts;
  return `${latest.prefix}${major}.${minor}.${patch + 1}`;
}
