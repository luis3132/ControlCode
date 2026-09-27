import { describe, expect, it } from "vitest";

import { fullRef, logRefs, parseGraphRefs } from "../GraphBranchFilter";

describe("las ramas del grafo", () => {
  it("se piden al backend como refs completas, o nada para la actual", () => {
    expect(logRefs("current")).toBeNull();
    expect(logRefs([])).toBeNull();
    expect(logRefs("all")).toEqual(["*"]);
    expect(logRefs(["refs/heads/main", "refs/remotes/origin/feat"])).toEqual(["refs/heads/main", "refs/remotes/origin/feat"]);
  });

  it("una rama local y una remota dan refs distintas aunque se llamen igual", () => {
    const b = { name: "main", remote: false, current: true, upstream: null, updatedAt: 0 };
    expect(fullRef(b)).toBe("refs/heads/main");
    expect(fullRef({ ...b, name: "origin/main", remote: true })).toBe("refs/remotes/origin/main");
  });

  it("lo guardado se lee aunque esté roto", () => {
    expect(parseGraphRefs(null)).toBe("current");
    expect(parseGraphRefs("all")).toBe("all");
    expect(parseGraphRefs('["refs/heads/a"]')).toEqual(["refs/heads/a"]);
    expect(parseGraphRefs("{roto")).toBe("current");
    expect(parseGraphRefs("[]")).toBe("current");
    expect(parseGraphRefs("[1,2]")).toBe("current");
  });
});
