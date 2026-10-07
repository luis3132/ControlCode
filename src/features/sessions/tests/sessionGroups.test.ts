import { describe, expect, it } from "vitest";

import type { RepoInfo } from "@/features/explorer/types";
import type { SessionHistoryEntry } from "@/features/sessions/types";
import { dateBucket, groupByDate, groupByProject } from "@/features/sessions/sessionGroups";

function entry(over: Partial<SessionHistoryEntry> & { cwd: string; closedAt: number }): SessionHistoryEntry {
  return {
    id: `${over.cwd}:${over.closedAt}`,
    workspaceId: "default",
    agentId: "claude-code",
    agentLabel: "Claude Code",
    command: "claude",
    title: null,
    sessionId: null,
    skills: [],
    siblingTabs: [],
    accountId: null,
    prelaunch: [],
    openedAt: over.closedAt - 100,
    ...over,
  };
}

function repo(over: Partial<RepoInfo>): RepoInfo {
  return { root: null, branch: null, isWorktree: false, changes: {}, changedCount: 0, ...over };
}

/** Miércoles 7 de octubre de 2026, 10:00 hora local. */
const NOW = new Date(2026, 9, 7, 10, 0, 0);
const at = (d: Date) => Math.floor(d.getTime() / 1000);

describe("dateBucket", () => {
  it("usa días de calendario, no ventanas de 24 h", () => {
    // Anoche a las 23:50: pasaron diez horas, pero es de ayer.
    expect(dateBucket(at(new Date(2026, 9, 6, 23, 50)), NOW)).toBe("yesterday");
    expect(dateBucket(at(new Date(2026, 9, 7, 0, 5)), NOW)).toBe("today");
  });

  it("separa la última semana, el último mes y lo más viejo", () => {
    expect(dateBucket(at(new Date(2026, 9, 2, 12, 0)), NOW)).toBe("week");
    expect(dateBucket(at(new Date(2026, 8, 20, 12, 0)), NOW)).toBe("month");
    expect(dateBucket(at(new Date(2026, 6, 1, 12, 0)), NOW)).toBe("older");
  });
});

describe("groupByDate", () => {
  it("ordena los tramos y las sesiones por lo más reciente", () => {
    const groups = groupByDate(
      [
        entry({ cwd: "/a", closedAt: at(new Date(2026, 9, 6, 15, 0)) }),
        entry({ cwd: "/b", closedAt: at(new Date(2026, 9, 7, 8, 0)) }),
        entry({ cwd: "/c", closedAt: at(new Date(2026, 9, 7, 9, 0)) }),
      ],
      NOW
    );
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday"]);
    expect(groups[0].sessions.map((s) => s.cwd)).toEqual(["/c", "/b"]);
  });

  it("no inventa tramos vacíos", () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});

describe("groupByProject", () => {
  it("junta los worktrees bajo su repo y aplana las carpetas", () => {
    const repos = new Map<string, RepoInfo>([
      ["/home/luis/p/main", repo({ root: "/home/luis/p/main", branch: "main" })],
      ["/home/luis/p/fix", repo({ root: "/home/luis/p/main", branch: "fix", isWorktree: true })],
    ]);
    const groups = groupByProject(
      [
        entry({ cwd: "/home/luis/p/main", closedAt: 100 }),
        entry({ cwd: "/home/luis/p/fix", closedAt: 300 }),
        entry({ cwd: "/home/luis/p/main", closedAt: 200 }),
      ],
      repos
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("main");
    expect(groups[0].sub).toBe("~/p/");
    expect(groups[0].sessions.map((s) => s.closedAt)).toEqual([300, 200, 100]);
  });
});
