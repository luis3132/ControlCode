import { describe, expect, it } from "vitest";

import { keyName } from "../keyboard";

describe("nombre de la tecla", () => {
  it("Shift+Tab en WebKitGTK es Tab", () => {
    expect(keyName({ key: "Unidentified", code: "Tab" })).toBe("Tab");
  });

  it("lo demás queda como viene", () => {
    expect(keyName({ key: "Tab", code: "Tab" })).toBe("Tab");
    expect(keyName({ key: "a", code: "KeyA" })).toBe("a");
    expect(keyName({ key: "Unidentified", code: "KeyA" })).toBe("Unidentified");
    expect(keyName({ key: "Unidentified" })).toBe("Unidentified");
  });
});
