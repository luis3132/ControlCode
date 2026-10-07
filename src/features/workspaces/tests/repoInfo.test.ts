import { describe, expect, it } from "vitest";

import type { RepoInfo } from "@/features/explorer/types";

import { belongs, mergeRepoInfo } from "../useRepoInfo";

const repo = (branch: string): RepoInfo => ({ root: "/p", branch, isWorktree: false, changes: {}, changedCount: 0 });

describe("la caché de repos", () => {
  it("releer y recibir lo mismo no cambia la caché (no redibuja)", () => {
    const prev = new Map([["/p", repo("main")]]);
    expect(mergeRepoInfo(prev, [["/p", repo("main")]])).toBe(prev);
  });

  it("lo que cambió se reemplaza sin perder lo demás", () => {
    const prev = new Map([["/p", repo("main")], ["/q", repo("dev")]]);
    const next = mergeRepoInfo(prev, [["/p", repo("feat")]]);
    expect(next).not.toBe(prev);
    expect(next.get("/p")?.branch).toBe("feat");
    expect(next.get("/q")?.branch).toBe("dev");
  });

  it("una carpeta pertenece al repo por su raíz o por estar adentro", () => {
    expect(belongs("/p/src", undefined, "/p")).toBe(true);
    expect(belongs("C:\\p\\src", undefined, "C:\\p")).toBe(true);
    expect(belongs("/pq", undefined, "/p")).toBe(false);
    expect(belongs("/otra", repo("main"), "/p")).toBe(true);
  });
});
