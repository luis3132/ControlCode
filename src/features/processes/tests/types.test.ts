import { describe, expect, it } from "vitest";

import { byWorkspace, formatMemory, formatUptime, sameFolder, visibleProcesses, type Subprocess } from "../types";

const proc = (id: string, workspace: string, status: Subprocess["status"], startedAt: number): Subprocess => ({
  id, name: id, command: "x", cwd: workspace, workspace, owner: { tabId: null, taskId: null },
  status, exitCode: null, ptyId: 1, startedAt, endedAt: null, restarts: 0,
});

describe("subprocesos", () => {
  const procs = [proc("p1", "/a", "exited", 1), proc("p2", "/a/", "running", 2), proc("p3", "/b", "running", 3)];

  it("por defecto, solo los del workspace actual, los vivos primero", () => {
    expect(visibleProcesses(procs, "/a", false).map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(visibleProcesses(procs, null, false)).toEqual([]);
  });

  it("con «Mostrar todos», los de todos los workspaces, agrupados", () => {
    const all = visibleProcesses(procs, "/a", true);
    expect(all.map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
    expect(byWorkspace(all).map(([ws, list]) => [ws, list.map((p) => p.id)])).toEqual([["/b", ["p3"]], ["/a", ["p2", "p1"]]]);
  });

  it("compara carpetas sin la barra final", () => {
    expect(sameFolder("/a/", "/a")).toBe(true);
    expect(sameFolder("/a", "/ab")).toBe(false);
  });

  it("formatea tiempo y memoria", () => {
    expect(formatUptime(42_000)).toBe("42s");
    expect(formatUptime(185_000)).toBe("3m 05s");
    expect(formatUptime(7_800_000)).toBe("2h 10m");
    expect(formatMemory(312 * 1024 * 1024)).toBe("312 MB");
    expect(formatMemory(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});
