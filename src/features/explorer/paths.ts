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
 * Cómo se le nombra un archivo o carpeta a un agente: `@ruta` relativa a su carpeta, que
 * es la mención que entienden Claude Code, Codex, Gemini y OpenCode. Fuera de su carpeta va
 * la absoluta. Una ruta con espacios cortaría la mención: va entre comillas, sin `@`.
 */
export function fileMention(path: string, agentCwd: string, isDir: boolean): string {
  const rel = isInside(path, agentCwd)
    ? comparablePath(path).slice(comparablePath(agentCwd).replace(/\/+$/, "").length + 1) || "."
    : path;
  const shown = isDir && !/[\\/]$/.test(rel) ? `${rel}/` : rel;
  return /\s/.test(shown) ? `"${shown}"` : `@${shown}`;
}
