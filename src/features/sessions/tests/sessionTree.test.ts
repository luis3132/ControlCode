import { describe, expect, it } from "vitest";

import type { RepoInfo } from "@/features/explorer/types";
import type { SessionHistoryEntry } from "@/features/sessions/types";
import { buildSessionTree, flatSessionOrder } from "@/features/sessions/sessionTree";

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

describe("buildSessionTree", () => {
  it("junta dos worktrees del mismo repo bajo un solo grupo", () => {
    const repos = new Map<string, RepoInfo>([
      ["/p/main", repo({ root: "/p/main", branch: "main" })],
      ["/p/fix", repo({ root: "/p/main", branch: "fix-usage", isWorktree: true })],
    ]);

    const groups = buildSessionTree(
      [entry({ cwd: "/p/main", closedAt: 200 }), entry({ cwd: "/p/fix", closedAt: 100 })],
      repos
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("main");
    expect(groups[0].isRepo).toBe(true);
    expect(groups[0].sessionCount).toBe(2);
    // Los títulos son las CARPETAS (`/p/main`, `/p/fix`), no las ramas.
    expect(groups[0].workspaces.map((w) => w.title)).toEqual(["main", "fix"]);
    expect(groups[0].workspaces.map((w) => w.branch)).toEqual(["main", "fix-usage"]);
  });

  it("distingue el worktree del checkout principal", () => {
    const repos = new Map<string, RepoInfo>([
      ["/p/main", repo({ root: "/p/main", branch: "main" })],
      ["/p/fix", repo({ root: "/p/main", branch: "fix", isWorktree: true })],
    ]);

    const [group] = buildSessionTree(
      [entry({ cwd: "/p/main", closedAt: 2 }), entry({ cwd: "/p/fix", closedAt: 1 })],
      repos
    );

    const main = group.workspaces.find((w) => w.cwd === "/p/main")!;
    const fix = group.workspaces.find((w) => w.cwd === "/p/fix")!;
    expect(main.isPrimary).toBe(true);
    expect(main.title).toBe("main");
    expect(main.branch).toBe("main");
    expect(fix.isPrimary).toBe(false);
    // El título es la carpeta (`fix`), no la rama que también se llama `fix`.
    expect(fix.title).toBe("fix");
    expect(fix.isWorktree).toBe(true);
  });

  it("ordena por lo más reciente en los tres niveles", () => {
    const groups = buildSessionTree(
      [
        entry({ cwd: "/viejo", closedAt: 10 }),
        entry({ cwd: "/nuevo", closedAt: 900 }),
        entry({ cwd: "/nuevo", closedAt: 400 }),
        entry({ cwd: "/medio", closedAt: 500 }),
      ],
      new Map()
    );

    expect(groups.map((g) => g.name)).toEqual(["nuevo", "medio", "viejo"]);
    expect(groups[0].workspaces[0].sessions.map((s) => s.closedAt)).toEqual([900, 400]);
    expect(flatSessionOrder(groups).map((s) => s.closedAt)).toEqual([900, 400, 500, 10]);
  });

  it("una carpeta sin resolver contra git es su propio grupo y no se pierde", () => {
    // Es el estado real del primer render: `useRepoInfo` todavía no contestó.
    const groups = buildSessionTree([entry({ cwd: "/sin/resolver", closedAt: 1 })], new Map());

    expect(groups).toHaveLength(1);
    expect(groups[0].isRepo).toBe(false);
    expect(groups[0].name).toBe("resolver");
    expect(groups[0].workspaces[0].title).toBe("resolver");
  });

  it("el orden plano es exactamente el orden en que se dibujan las filas", () => {
    // De esto depende que la flecha abajo vaya a la fila de abajo y no a otra parte.
    const repos = new Map<string, RepoInfo>([
      ["/p/a", repo({ root: "/p", branch: "a" })],
      ["/p/b", repo({ root: "/p", branch: "b" })],
    ]);
    const groups = buildSessionTree(
      [
        entry({ cwd: "/p/a", closedAt: 5 }),
        entry({ cwd: "/p/b", closedAt: 9 }),
        entry({ cwd: "/otro", closedAt: 1 }),
      ],
      repos
    );

    const drawn = groups.flatMap((g) => g.workspaces.flatMap((w) => w.sessions.map((s) => s.id)));
    expect(flatSessionOrder(groups).map((s) => s.id)).toEqual(drawn);
  });

  it("sin sesiones no hay grupos", () => {
    expect(buildSessionTree([], new Map())).toEqual([]);
  });
});
