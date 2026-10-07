/**
 * Los dos cortes de la lista de Sesiones: por cuándo se cerró o por proyecto.
 *
 * Por fecha es el de entrada porque es la pregunta más común al volver acá ("la de hace un
 * rato"). Por proyecto reusa `buildSessionTree` —el mismo mapa que el panel de workspaces—
 * pero aplanado: con el detalle a la derecha, la carpeta y la rama ya se leen en cada fila y
 * un segundo nivel de encabezados solo le robaba alto a la lista.
 */
import type { RepoInfo } from "@/features/explorer/types";

import { buildSessionTree } from "./sessionTree";
import type { SessionHistoryEntry } from "./types";

export type GroupMode = "date" | "project";

/** Tramos de antigüedad, en el orden en que se dibujan. */
export type DateBucket = "today" | "yesterday" | "week" | "month" | "older";

export interface SessionListGroup {
  key: string;
  /** Por fecha: el tramo (se traduce al dibujar). Por proyecto: el nombre del repo. */
  label: string;
  bucket: DateBucket | null;
  /** Por proyecto: dónde vive el repo, para distinguir dos homónimos. */
  sub: string | null;
  sessions: SessionHistoryEntry[];
}

const DAY_MS = 86_400_000;

/**
 * El tramo de una sesión cerrada en `closedAt` (epoch en segundos).
 *
 * "Hoy" y "ayer" son días de CALENDARIO, no ventanas de 24 h: algo cerrado anoche a las
 * 23:50 es de ayer aunque hayan pasado diez minutos.
 */
export function dateBucket(closedAt: number, now: Date): DateBucket {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = closedAt * 1000;
  if (at >= startOfToday) return "today";
  if (at >= startOfToday - DAY_MS) return "yesterday";
  if (at >= startOfToday - 7 * DAY_MS) return "week";
  if (at >= startOfToday - 30 * DAY_MS) return "month";
  return "older";
}

const BUCKETS: DateBucket[] = ["today", "yesterday", "week", "month", "older"];

export function groupByDate(entries: SessionHistoryEntry[], now: Date): SessionListGroup[] {
  const sorted = [...entries].sort((a, b) => b.closedAt - a.closedAt);
  const byBucket = new Map<DateBucket, SessionHistoryEntry[]>();
  for (const entry of sorted) {
    const bucket = dateBucket(entry.closedAt, now);
    const list = byBucket.get(bucket);
    if (list) list.push(entry);
    else byBucket.set(bucket, [entry]);
  }
  return BUCKETS.filter((b) => byBucket.has(b)).map((bucket) => ({
    key: bucket,
    label: bucket,
    bucket,
    sub: null,
    sessions: byBucket.get(bucket)!,
  }));
}

/** `/home/luis/proyectos/api` → `~/proyectos/`: la carpeta que contiene al repo. */
function parentOf(path: string): string {
  const cut = path.replace(/[\\/]+$/, "").replace(/[^\\/]+$/, "");
  return cut.replace(/^\/home\/[^/]+\//, "~/");
}

export function groupByProject(
  entries: SessionHistoryEntry[],
  repos: Map<string, RepoInfo>
): SessionListGroup[] {
  return buildSessionTree(entries, repos).map((group) => ({
    key: group.key,
    label: group.name,
    bucket: null,
    sub: parentOf(group.key),
    sessions: group.workspaces
      .flatMap((w) => w.sessions)
      .sort((a, b) => b.closedAt - a.closedAt),
  }));
}

export function groupSessions(
  mode: GroupMode,
  entries: SessionHistoryEntry[],
  repos: Map<string, RepoInfo>,
  now: Date
): SessionListGroup[] {
  return mode === "date" ? groupByDate(entries, now) : groupByProject(entries, repos);
}
