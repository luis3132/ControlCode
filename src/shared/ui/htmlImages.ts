/**
 * Las `<img>` de HTML crudo, pasadas a imágenes de Markdown.
 *
 * GitHub, al arrastrar una captura a un issue, no escribe `![](url)` sino
 * `<img width="759" alt="…" src="…">`. El renderer no interpreta HTML crudo a propósito (ver
 * `Markdown.tsx`), así que sin esto la imagen se veía como la etiqueta en texto. Se
 * rescatan solo `src` y `alt`: el resto del HTML sigue sin interpretarse.
 */
export function htmlImagesToMarkdown(text: string): string {
  // Lo que está en código se muestra tal cual: es justamente cómo se escribe una etiqueta
  // para que se lea.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : convert(part)))
    .join("");
}

function convert(text: string): string {
  return text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, "src");
    if (!src) return tag;
    const alt = (attr(tag, "alt") ?? "").replace(/[[\]]/g, "");
    return `![${alt}](<${src.replace(/[<>]/g, encodeURIComponent)}>)`;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&");
}
