import { describe, expect, it } from "vitest";

import { formatTokens, totalOf } from "../usage";

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
