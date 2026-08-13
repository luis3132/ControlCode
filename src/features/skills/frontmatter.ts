/**
 * Deja el SKILL.md con el nombre del campo.
 *
 * El nombre de una skill vive en su frontmatter, así que editarlo en un campo aparte
 * significa escribirlo dentro del archivo. Si el usuario ya lo cambió a mano en el YAML,
 * el campo gana: es lo que tiene delante al apretar guardar.
 */
export function applyName(content: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return content;
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return `---\nname: ${trimmed}\n---\n\n${content}`;
  const withName = match[1].match(/^name:/m)
    ? match[1].replace(/^name:.*$/m, `name: ${trimmed}`)
    : `name: ${trimmed}\n${match[1]}`;
  return `---\n${withName}\n---\n${content.slice(match[0].length)}`;
}
