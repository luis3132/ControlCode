import { describe, expect, it } from "vitest";

import { formatCountdown } from "../types";

describe("formatCountdown", () => {
  it("minutos y segundos, sin negativos", () => {
    expect(formatCountdown(300)).toBe("5:00");
    expect(formatCountdown(61.7)).toBe("1:01");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});
