import { describe, expect, it } from "vitest";

import { formatAgo, formatRemaining, formatTokens, isUsageFresh, planLabel, totalOf } from "../usage";

describe("formatTokens", () => {
  it("deja los números chicos como están", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("usa un decimal hasta 10k y ninguno después", () => {
    // 1.2k se lee; 9999 como "10.0k" miente por redondeo hacia arriba en la frontera.
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10.0k");
    expect(formatTokens(12_400)).toBe("12k");
  });

  it("pasa a millones", () => {
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("totalOf", () => {
  it("suma las cuatro clases de token", () => {
    expect(totalOf({
      key: "5h", inputTokens: 1, outputTokens: 2,
      cacheWriteTokens: 4, cacheReadTokens: 8, messages: 0, sessions: 0,
    })).toBe(15);
  });
});

describe("planLabel", () => {
  it("traduce los planes conocidos", () => {
    expect(planLabel("default_claude_max_20x")).toBe("Max 20×");
    expect(planLabel("default_claude_pro")).toBe("Pro");
  });

  it("muestra tal cual un plan que no conoce", () => {
    // Un identificador crudo dice más que una etiqueta vacía o un "desconocido".
    expect(planLabel("default_claude_futuro")).toBe("default_claude_futuro");
  });

  it("sin plan no inventa ninguno", () => {
    expect(planLabel(null)).toBeNull();
  });
});

describe("formatRemaining", () => {
  it("minutos abajo de la hora, redondeando hacia arriba", () => {
    // Hacia arriba: decir "0 min" cuando quedan 30 segundos es peor que decir "1 min".
    expect(formatRemaining(30)).toBe("1 min");
    expect(formatRemaining(59 * 60)).toBe("59 min");
  });

  it("horas y minutos", () => {
    expect(formatRemaining(2 * 3600 + 14 * 60)).toBe("2 h 14 min");
    expect(formatRemaining(3 * 3600)).toBe("3 h");
  });

  it("una ventana vencida no muestra negativos", () => {
    expect(formatRemaining(-500)).toBe("0 min");
    expect(formatRemaining(0)).toBe("0 min");
  });
});

describe("formatAgo", () => {
  it("lo muy reciente no lleva número", () => {
    // "hace 0 min" se lee raro y no dice nada más que "recién".
    expect(formatAgo(0)).toEqual({ unit: "now", value: 0 });
    expect(formatAgo(44)).toEqual({ unit: "now", value: 0 });
  });

  it("minutos y horas", () => {
    expect(formatAgo(45)).toEqual({ unit: "min", value: 1 });
    expect(formatAgo(5 * 60)).toEqual({ unit: "min", value: 5 });
    expect(formatAgo(90 * 60)).toEqual({ unit: "h", value: 2 });
  });

  it("no arma texto: eso es cosa de i18n", () => {
    expect(typeof formatAgo(300)).toBe("object");
  });
});

describe("isUsageFresh", () => {
  const now = 1_800_000_000;

  it("lo recién consultado sirve", () => {
    expect(isUsageFresh(now, now)).toBe(true);
    expect(isUsageFresh(now - 299, now)).toBe(true);
  });

  it("a los cinco minutos se vuelve a preguntar", () => {
    expect(isUsageFresh(now - 300, now)).toBe(false);
    expect(isUsageFresh(now - 3600, now)).toBe(false);
  });

  it("un reloj corrido hacia atrás no deja la entrada viva para siempre", () => {
    // Pasa con NTP o al volver de suspensión: si solo se compara contra el plazo, una
    // diferencia negativa nunca vence.
    expect(isUsageFresh(now + 500, now)).toBe(false);
  });

  it("lo que nunca se consultó está vencido", () => {
    expect(isUsageFresh(0, now)).toBe(false);
  });
});
