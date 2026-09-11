import { describe, expect, it } from "vitest";

import { elapsed } from "../useRepoInfo";

describe("elapsed", () => {
  const now = 1_000_000_000_000;
  const ago = (ms: number) => elapsed(now - ms, now);

  it("segundos abajo del minuto", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(45_000)).toBe("45s");
  });

  it("minutos, horas y días", () => {
    expect(ago(60_000)).toBe("1m");
    expect(ago(59 * 60_000)).toBe("59m");
    expect(ago(60 * 60_000)).toBe("1h");
    expect(ago(23 * 3600_000)).toBe("23h");
    expect(ago(24 * 3600_000)).toBe("1d");
  });

  it("un reloj que se corrió hacia atrás no muestra negativos", () => {
    // Pasa de verdad con NTP o al despertar de suspensión.
    expect(elapsed(now + 5000, now)).toBe("0s");
  });
});
