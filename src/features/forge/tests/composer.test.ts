import { describe, expect, it } from "vitest";

import type { Branch } from "@/features/scm/types";
import { compareRef, hostBranches, titleFromBranch } from "../composer";

const branch = (name: string, remote: boolean, current = false, updatedAt = 0): Branch =>
  ({ name, remote, current, upstream: null, updatedAt });

describe("hostBranches", () => {
  it("fusiona la local y la del remoto del repo, e ignora otros remotos y HEAD", () => {
    const list = hostBranches([
      branch("main", false, false, 5),
      branch("origin/main", true, false, 5),
      branch("origin/HEAD", true),
      branch("feat", false, true, 1),
      branch("origin/solo-remota", true, false, 9),
      branch("upstream/otra", true),
    ], "origin");
    expect(list.map((b) => b.name)).toEqual(["feat", "solo-remota", "main"]);
    expect(list.find((b) => b.name === "main")).toMatchObject({ local: true, remote: true });
    expect(list.find((b) => b.name === "solo-remota")).toMatchObject({ local: false, remote: true });
    expect(list[0]).toMatchObject({ name: "feat", current: true, remote: false });
  });
});

describe("compareRef", () => {
  const main = { name: "main", local: true, remote: true, current: false, updatedAt: 0 };
  const feat = { name: "feat", local: true, remote: false, current: true, updatedAt: 0 };

  it("la base se compara como está en el remoto; la rama del PR, como está local", () => {
    expect(compareRef(main, "origin", "base")).toBe("origin/main");
    expect(compareRef(main, "origin", "head")).toBe("main");
    expect(compareRef(feat, "origin", "base")).toBe("feat");
    expect(compareRef({ ...feat, local: false, remote: true }, "origin", "head")).toBe("origin/feat");
    expect(compareRef(undefined, "origin", "base")).toBeNull();
  });
});

it("un nombre de rama da un título de partida", () => {
  expect(titleFromBranch("feat/nueva-ui_pr")).toBe("Feat nueva ui pr");
  expect(titleFromBranch("")).toBe("");
});
