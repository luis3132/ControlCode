import { describe, expect, it } from "vitest";

import { cloneDirName } from "../cloneName";

describe("cloneDirName", () => {
  it("toma el último tramo de la URL, sin .git", () => {
    expect(cloneDirName("https://github.com/o/repo.git")).toBe("repo");
    expect(cloneDirName("git@github.com:o/repo.git")).toBe("repo");
    expect(cloneDirName("https://gitlab.com/g/sub/proj/")).toBe("proj");
  });

  it("no propone nombres que no son carpetas", () => {
    expect(cloneDirName("")).toBeNull();
    expect(cloneDirName("https://h/..")).toBeNull();
  });
});
