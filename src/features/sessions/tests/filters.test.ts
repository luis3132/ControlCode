import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTERS,
  filterSessions,
  hasActiveFilters,
  shortenPath,
  type SessionFilterState,
} from "../filters";
import type { SessionHistoryEntry } from "../types";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function entry(patch: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    id: "h1",
    workspaceId: "ws",
    agentId: "claude-code",
    agentLabel: "Claude Code",
    command: "claude",
    cwd: "/home/u/proyecto",
    title: "Arreglar el parser",
    sessionId: "sess-1",
    skills: [],
    siblingTabs: [],
    accountId: null,
    prelaunch: [],
    openedAt: NOW - DAY,
    closedAt: NOW - 60,
    ...patch,
  };
}

const filters = (patch: Partial<SessionFilterState> = {}): SessionFilterState => ({
  ...EMPTY_FILTERS,
  ...patch,
});

describe("hasActiveFilters", () => {
  it("no considera activo un filtro vacío", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    // Espacios sueltos en el buscador no son una búsqueda: si contaran, el botón de
    // limpiar aparecería solo por apoyar la barra espaciadora.
    expect(hasActiveFilters(filters({ query: "   " }))).toBe(false);
  });

  it("detecta cualquier filtro puesto", () => {
    expect(hasActiveFilters(filters({ query: "parser" }))).toBe(true);
    expect(hasActiveFilters(filters({ agentId: "codex" }))).toBe(true);
    expect(hasActiveFilters(filters({ cwd: "/tmp" }))).toBe(true);
    expect(hasActiveFilters(filters({ skill: "git" }))).toBe(true);
    expect(hasActiveFilters(filters({ dateRange: "week" }))).toBe(true);
  });
});

describe("filterSessions", () => {
  it("sin filtros devuelve todo", () => {
    const all = [entry(), entry({ id: "h2" })];
    expect(filterSessions(all, EMPTY_FILTERS)).toHaveLength(2);
  });

  it("busca en título, agente y carpeta, sin distinguir mayúsculas", () => {
    const all = [
      entry({ id: "titulo", title: "Arreglar el PARSER" }),
      entry({ id: "agente", title: null, agentLabel: "OpenCode" }),
      entry({ id: "carpeta", title: null, agentLabel: "X", cwd: "/home/u/wallet" }),
    ];
    expect(filterSessions(all, filters({ query: "parser" })).map((e) => e.id)).toEqual(["titulo"]);
    expect(filterSessions(all, filters({ query: "opencode" })).map((e) => e.id)).toEqual(["agente"]);
    expect(filterSessions(all, filters({ query: "WALLET" })).map((e) => e.id)).toEqual(["carpeta"]);
  });

  /// Un título nulo (sesión que nunca resolvió uno) no puede romper la búsqueda.
  it("tolera entradas sin título", () => {
    expect(filterSessions([entry({ title: null })], filters({ query: "claude" }))).toHaveLength(1);
  });

  it("filtra por agente, carpeta y skill de forma exacta", () => {
    const all = [
      entry({ id: "a", agentId: "claude-code", skills: [{ id: "s", name: "git", scope: "tab" }] }),
      entry({ id: "b", agentId: "codex", cwd: "/otro" }),
    ];
    expect(filterSessions(all, filters({ agentId: "codex" })).map((e) => e.id)).toEqual(["b"]);
    expect(filterSessions(all, filters({ cwd: "/otro" })).map((e) => e.id)).toEqual(["b"]);
    expect(filterSessions(all, filters({ skill: "git" })).map((e) => e.id)).toEqual(["a"]);
    // Coincidencia exacta, no por prefijo: "gi" no es la skill "git".
    expect(filterSessions(all, filters({ skill: "gi" }))).toHaveLength(0);
  });

  it("el rango de fechas corta por el cierre, no por la apertura", () => {
    // Se abrió hace 40 días pero se cerró hace una hora: "esta semana" tiene que incluirla.
    const vieja = entry({ id: "vieja", openedAt: NOW - 40 * DAY, closedAt: NOW - 3600 });
    const cerrada = entry({ id: "cerrada", closedAt: NOW - 10 * DAY });

    const week = filterSessions([vieja, cerrada], filters({ dateRange: "week" }));
    expect(week.map((e) => e.id)).toEqual(["vieja"]);
    expect(filterSessions([vieja, cerrada], filters({ dateRange: "month" }))).toHaveLength(2);
  });

  it("los filtros se acumulan", () => {
    const all = [
      entry({ id: "a", agentId: "codex", title: "parser" }),
      entry({ id: "b", agentId: "codex", title: "otra cosa" }),
      entry({ id: "c", agentId: "claude-code", title: "parser" }),
    ];
    expect(filterSessions(all, filters({ agentId: "codex", query: "parser" })).map((e) => e.id))
      .toEqual(["a"]);
  });
});

describe("shortenPath", () => {
  it("deja los últimos segmentos y marca el recorte", () => {
    expect(shortenPath("/home/luis/proyectos/api")).toBe("…/proyectos/api");
    expect(shortenPath("/home/luis/proyectos/api", 1)).toBe("…/api");
  });

  it("no toca una ruta que ya es corta", () => {
    expect(shortenPath("/home/luis")).toBe("/home/luis");
    expect(shortenPath("/tmp")).toBe("/tmp");
  });
});
