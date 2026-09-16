import { describe, expect, it } from "vitest";

import { AGENT_PAINTS, agentPaint } from "../agentPaint";

describe("agentPaint", () => {
  /// El mismo agente tiene que pintarse igual en su tab y en la de su navegador, hoy y
  /// después de reabrir la app: por eso sale del id y no de un contador ni de un sorteo.
  it("el color de un id no cambia", () => {
    expect(agentPaint("tab-1")).toBe(agentPaint("tab-1"));
    expect(agentPaint("9f3a-…").name).toBe(agentPaint("9f3a-…").name);
  });

  /// Con dos agentes en la misma carpeta, dos colores iguales serían no decir nada.
  it("ids distintos reparten entre todos los colores", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `tarea-${i}`);
    const usados = new Set(ids.map((id) => agentPaint(id).name));
    expect(usados.size).toBe(AGENT_PAINTS.length);
  });

  it("siempre devuelve un color de la paleta", () => {
    for (const id of ["", "x", "muy-largo-".repeat(20)]) {
      expect(AGENT_PAINTS).toContain(agentPaint(id));
    }
  });
});
