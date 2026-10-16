/**
 * Cómo un agente cambia un documento: lo reescribe, le agrega al final o al principio, o
 * cambia un fragmento que nombra. Puro: se prueba en Node.
 */

export type DocEditMode = "replace_all" | "append" | "prepend" | "replace" | "insert_after";

export const DOC_EDIT_MODES: DocEditMode[] = ["replace_all", "append", "prepend", "replace", "insert_after"];

export interface DocEdit {
  mode: DocEditMode;
  content: string;
  /** El fragmento exacto a cambiar o después del cual insertar (`replace`, `insert_after`). */
  find?: string;
}

/** Junta dos bloques de Markdown dejando una línea en blanco entre ellos. */
function joinBlocks(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a.replace(/\s+$/, "")}\n\n${b.replace(/^\s+/, "")}`;
}

function locate(text: string, find: string | undefined): number {
  if (!find) throw new Error("Falta 'find': el fragmento exacto del documento");
  const at = text.indexOf(find);
  if (at < 0) throw new Error("No encontré 'find' en el documento: tiene que ser un fragmento exacto, copiado tal cual");
  if (text.indexOf(find, at + 1) >= 0) throw new Error("'find' aparece más de una vez: agregá texto alrededor para que sea único");
  return at;
}

export function applyDocEdit(text: string, edit: DocEdit): string {
  let out: string;
  switch (edit.mode) {
    case "replace_all":
      out = edit.content;
      break;
    case "append":
      out = joinBlocks(text, edit.content);
      break;
    case "prepend":
      out = joinBlocks(edit.content, text);
      break;
    case "replace": {
      const at = locate(text, edit.find);
      out = text.slice(0, at) + edit.content + text.slice(at + edit.find!.length);
      break;
    }
    case "insert_after": {
      const at = locate(text, edit.find) + edit.find!.length;
      out = text.slice(0, at) + edit.content + text.slice(at);
      break;
    }
    default:
      throw new Error(`'mode' tiene que ser ${DOC_EDIT_MODES.join(", ")}`);
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Una imagen de Markdown que apunta de `fromDoc` a `asset`, con la ruta relativa entre los dos. */
export function relativeLink(fromDoc: string, asset: string): string {
  const a = fromDoc.replace(/\\/g, "/").split("/").slice(0, -1);
  const b = asset.replace(/\\/g, "/").split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return [...Array(up).fill(".."), ...b.slice(i)].join("/") || b[b.length - 1]!;
}
