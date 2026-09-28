import { describe, expect, it } from "vitest";

import { describeConnection, parsePort } from "../types";

describe("describeConnection", () => {
  it("muestra usuario y puerto solo cuando hacen falta", () => {
    expect(describeConnection({ host: "10.0.0.2", user: null, port: null })).toBe("10.0.0.2");
    expect(describeConnection({ host: "pc", user: "luis", port: 22 })).toBe("luis@pc");
    expect(describeConnection({ host: "pc", user: "luis", port: 2222 })).toBe("luis@pc:2222");
  });
});

describe("parsePort", () => {
  it("vacío es el de siempre, y lo que no es un puerto se marca", () => {
    expect(parsePort("  ")).toBeNull();
    expect(parsePort("2222")).toBe(2222);
    expect(parsePort("0")).toBe("invalid");
    expect(parsePort("70000")).toBe("invalid");
    expect(parsePort("22a")).toBe("invalid");
  });
});
