/**
 * Rutas del árbol, sin React: a qué carpeta va algo, qué se puede soltar dónde y cómo
 * queda una ruta cuando se mueve la carpeta que la contiene.
 *
 * Las rutas son absolutas y vienen del sistema: en Windows con `\`, en el resto con `/`.
 * Se arma cada ruta nueva con el separador de la que se tiene, y se compara por
 * `comparablePath`, que es lo que usan las tabs.
 */
import { comparablePath } from "@/features/tabs/viewTabs";

function sepOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function parentDir(path: string): string {
  const s = sepOf(path);
  const trimmed = path.endsWith(s) && path.length > 1 ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf(s);
  if (i < 0) return trimmed;
  // `/a` → `/`, `C:\a` → `C:\`: la raíz conserva su separador.
  return i === 0 || /^[A-Za-z]:$/.test(trimmed.slice(0, i)) ? trimmed.slice(0, i + 1) : trimmed.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  const s = sepOf(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
}

/** `path` es `dir` o está adentro. */
export function isInside(path: string, dir: string): boolean {
  const p = comparablePath(path);
  const d = comparablePath(dir).replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`);
}

/** La carpeta a la que va lo que se crea o se suelta sobre una fila: la carpeta misma, o
 *  la que contiene al archivo. */
export function dirFor(entry: { path: string; isDir: boolean }): string {
  return entry.isDir ? entry.path : parentDir(entry.path);
}

/**
 * Soltar `source` en `dir` hace algo. No, si ya está ahí (moverlo no cambia nada) o si
 * `dir` es la carpeta misma o algo de adentro (no se puede meter en sí misma).
 *
 * Copiar a la misma carpeta sí vale: es duplicar.
 */
export function canDrop(source: string, dir: string, copy: boolean): boolean {
  if (isInside(dir, source)) return false;
  return copy || comparablePath(parentDir(source)) !== comparablePath(dir);
}

/** Dónde queda `path` si `from` pasó a llamarse `to`. `null` = no estaba adentro. */
export function remapPath(path: string, from: string, to: string): string | null {
  if (!isInside(path, from)) return null;
  const rest = path.slice(from.replace(/[\\/]+$/, "").length);
  return to.replace(/[\\/]+$/, "") + rest;
}

/**
 * `path` vista desde `from`, con `/` y `..` si hace falta: `../otro/a.ts`. `"."` si son la
 * misma. `null` si no hay camino relativo: en Windows, otra unidad (`D:` desde `C:`).
 */
export function relativePath(from: string, path: string): string | null {
  const split = (p: string) => comparablePath(p).split("/").filter(Boolean);
  const a = split(from);
  const b = split(path);
  // La unidad de Windows es la raíz: entre dos distintas no se puede subir y bajar.
  const drive = (parts: string[]) => (/^[a-z]:$/.test(parts[0] ?? "") ? parts[0] : "");
  if (drive(a) !== drive(b)) return null;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const rel = [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
  return rel || ".";
}

/**
 * Cómo se le nombra un archivo o carpeta a un agente: `@ruta` relativa a su carpeta, que
 * es la mención que entienden Claude Code, Codex, Gemini y OpenCode. Afuera de su carpeta
 * también va relativa (`@../otro/a.ts`), igual que la escribiría uno; la absoluta queda solo
 * para lo que no tiene camino relativo (otra unidad en Windows). Siempre `@ruta`, sin
 * comillas, aunque tenga espacios: es la forma que escribe uno y la que esperan las TUIs.
 */
export function fileMention(path: string, agentCwd: string, isDir: boolean): string {
  const rel = relativePath(agentCwd, path) ?? path;
  return `@${isDir && !/[\\/]$/.test(rel) ? `${rel}/` : rel}`;
}

/** Una ruta lista para un shell: entre comillas simples si hace falta (las de adentro se
 *  cierran y se escapan, `'\''`), tal cual si no tiene nada que el shell interprete. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Lo que se escribe en una terminal al soltarle archivos: a un agente, sus menciones
 * (`@src/a.ts`); a un shell pelado, las rutas absolutas citadas, que es lo que haría
 * cualquier terminal. Con un espacio al final, para seguir escribiendo la pregunta.
 */
export function dropText(files: { path: string; isDir: boolean }[], cwd: string, isShell: boolean): string {
  const parts = files.map((f) => (isShell ? shellQuote(f.path) : fileMention(f.path, cwd, f.isDir)));
  return parts.length ? `${parts.join(" ")} ` : "";
}
