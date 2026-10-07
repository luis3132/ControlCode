import type { SessionHistoryEntry } from "./types";

/** "7 oct 2026, 10:20" en el idioma del sistema. */
export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "40s", "12m", "3h", "5d" — corto como para caber al lado de "Cerrada hace". */
export function formatRelative(unixSeconds: number, nowMs = Date.now()): string {
  const diffSeconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  const units: [number, string][] = [
    [60, "s"], [60, "m"], [24, "h"], [30, "d"], [12, "mo"], [Infinity, "y"],
  ];
  let value = diffSeconds;
  let unit = "s";
  for (const [size, label] of units) {
    if (value < size) { unit = label; break; }
    value = Math.floor(value / size);
    unit = label;
  }
  return `${value}${unit}`;
}

/**
 * La hora de cierre tal como conviene leerla en una fila: la hora sola si fue hoy, el día
 * de la semana si fue esta semana, la fecha si es más viejo.
 */
export function formatClosedShort(unixSeconds: number, now = new Date()): string {
  const at = new Date(unixSeconds * 1000);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 7) {
    return at.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Nombre de archivo sugerido al exportar: legible y sin caracteres problemáticos. */
export function suggestedFileName(entry: SessionHistoryEntry): string {
  const base = (entry.title ?? entry.agentLabel)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const date = new Date(entry.closedAt * 1000).toISOString().slice(0, 10);
  return `${base || "sesion"}-${date}.md`;
}
