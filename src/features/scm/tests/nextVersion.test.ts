import { describe, expect, it } from "vitest";

import { nextVersion } from "../nextVersion";

describe("nextVersion", () => {
  it("sube el último número del tag más alto, no del más nuevo por nombre", () => {
    expect(nextVersion(["v1.7.2", "v1.7.3", "v1.10.0", "algo"])).toBe("v1.10.1");
    expect(nextVersion(["2.0.9"])).toBe("2.0.10");
  });

  it("sin versiones, propone la primera", () => {
    expect(nextVersion([])).toBe("v0.1.0");
    expect(nextVersion(["release-a"])).toBe("v0.1.0");
  });
});
