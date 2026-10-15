import { fileStat } from "@/features/editor/ipc";

/** Dónde van los diagramas nuevos, relativo al proyecto. */
export const DIAGRAMS_DIR = "docs/diagrams";

const isAbsolute = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** Una ruta que escribió un agente (relativa al proyecto o absoluta), como absoluta. */
export function resolveInProject(cwd: string, path: string): string {
  if (isAbsolute(path)) return path;
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${path.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep)}`;
}

/** Con la extensión de diagrama, se la hayan puesto o no. */
export function withDiagramExtension(path: string): string {
  if (/\.diagram\.json$/i.test(path)) return path;
  return `${path.replace(/\.json$/i, "")}.diagram.json`;
}

/** "Arquitectura del backend" → "arquitectura-del-backend". */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "diagrama";
}

/** Una ruta libre en `docs/diagrams/` para un diagrama con ese nombre. */
export async function freeDiagramPath(cwd: string, name: string): Promise<string> {
  const base = resolveInProject(cwd, `${DIAGRAMS_DIR}/${slugify(name)}`);
  for (let i = 1; i < 1000; i++) {
    const path = `${base}${i === 1 ? "" : `-${i}`}.diagram.json`;
    if (!(await fileStat(path).catch(() => null))) return path;
  }
  throw new Error("No hay un nombre libre para el diagrama");
}
