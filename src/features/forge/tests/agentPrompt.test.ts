import { describe, expect, it } from "vitest";

import { itemPrompt } from "../agentPrompt";
import type { ForgeItemDetail } from "../types";

const base: ForgeItemDetail = {
  number: 13, title: "Refresh quota", state: "open", draft: false, author: "someone",
  webUrl: "https://github.com/o/r/issues/13", createdAt: null, updatedAt: null, comments: 1,
  labels: ["bug"], sourceBranch: null, targetBranch: null,
  body: "It breaks.", thread: [{ author: "luis", body: "Confirmed.", createdAt: "2026-09-01" }],
};

describe("itemPrompt", () => {
  it("lleva el issue entero: título, enlace, descripción e hilo", () => {
    const p = itemPrompt(base, false);
    expect(p).toContain("Resolve issue #13");
    expect(p).toContain("URL: https://github.com/o/r/issues/13");
    expect(p).toContain("Labels: bug");
    expect(p).toContain("It breaks.");
    expect(p).toContain("### @luis (2026-09-01)");
    expect(p).toContain("git_issue_view");
  });

  it("en un PR nombra las ramas y pide estar en la suya", () => {
    const p = itemPrompt({ ...base, sourceBranch: "feat/x", targetBranch: "main", body: null }, true);
    expect(p).toContain("pull request #13");
    expect(p).toContain("Branches: feat/x → main");
    expect(p).toContain("`feat/x` branch");
    expect(p).toContain("(no description)");
  });

  it("corta un hilo enorme y dice cuántos quedaron afuera", () => {
    const thread = Array.from({ length: 20 }, (_, i) => ({ author: "a", body: "x".repeat(3000) + i, createdAt: null }));
    const p = itemPrompt({ ...base, thread }, false);
    expect(p).toMatch(/\[\d+ more comments omitted/);
    expect(p.length).toBeLessThan(40_000);
  });
});
