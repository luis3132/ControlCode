import { describe, expect, it } from "vitest";

import {
  baseName, buildWorkspaceTree, cwdsToResolve, flattenWorkspaces, fleetCounts,
} from "../workspaceTree";
import type { RepoGroup, WorkspaceNode } from "../workspaceTree";
import type { RepoInfo } from "@/features/explorer/types";
import type { Tab } from "@/features/tabs/types";

let seq = 0;
function tab(cwd: string, agentId = "claude-code", patch: Partial<Tab> = {}): Tab {
  seq += 1;
  return {
    id: `t${seq}`,
    title: `${agentId} — ${baseName(cwd)}`,
    cwd,
    agentId,
    agentLabel: agentId,
    command: agentId,
    ptyId: 100 + seq,
    openedAt: seq,
    ...patch,
  } as Tab;
}

function repo(root: string, branch: string | null, isWorktree = false, changed = 0): RepoInfo {
  return { root, branch, isWorktree, changes: {}, changedCount: changed };
}

describe("baseName", () => {
  it("toma el último segmento", () => {
    expect(baseName("/home/luis/ControlCode")).toBe("ControlCode");
    expect(baseName("/home/luis/ControlCode/")).toBe("ControlCode");
    expect(baseName("C:\\Users\\luis\\app")).toBe("app");
  });
});

describe("buildWorkspaceTree", () => {
  it("agrupa por root de repo, no por carpeta", () => {
    // Dos tabs en subcarpetas distintas del MISMO repo tienen que caer bajo un solo grupo.
    const tabs = [tab("/p/src"), tab("/p/src-tauri")];
    const repos = new Map([
      ["/p/src", repo("/p", "main")],
      ["/p/src-tauri", repo("/p", "main")],
    ]);
    const tree = buildWorkspaceTree(tabs, repos, null);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("p");
    expect(tree[0].workspaces.map((w) => w.cwd)).toEqual(["/p/src", "/p/src-tauri"]);
    expect(tree[0].agentCount).toBe(2);
  });

  it("dos tabs en la misma carpeta son UN workspace con dos agentes", () => {
    const tabs = [tab("/p", "claude-code"), tab("/p", "codex")];
    const repos = new Map([["/p", repo("/p", "main")]]);
    const tree = buildWorkspaceTree(tabs, repos, null);
    expect(tree[0].workspaces).toHaveLength(1);
    expect(tree[0].workspaces[0].agents.map((a) => a.agentId)).toEqual(["claude-code", "codex"]);
  });

  it("un worktree queda en el mismo grupo que su checkout principal", () => {
    // Es la razón de agrupar por root: si no, `feat/mcp` aparecería como otro proyecto.
    const tabs = [tab("/p"), tab("/wt/mcp")];
    const repos = new Map([
      ["/p", repo("/p", "main")],
      ["/wt/mcp", repo("/p", "feat/mcp", true)],
    ]);
    const tree = buildWorkspaceTree(tabs, repos, null);
    expect(tree).toHaveLength(1);
    expect(tree[0].workspaces.map((w) => w.title)).toEqual(["main", "feat/mcp"]);
    expect(tree[0].workspaces[1].subtitle).toBe("worktree · mcp");
  });

  it("el checkout principal va primero aunque alfabéticamente no le toque", () => {
    const tabs = [tab("/wt/a"), tab("/p")];
    const repos = new Map([
      ["/wt/a", repo("/p", "aaa", true)],
      ["/p", repo("/p", "zzz")],
    ]);
    const tree = buildWorkspaceTree(tabs, repos, null);
    expect(tree[0].workspaces.map((w) => w.title)).toEqual(["zzz", "aaa"]);
    expect(tree[0].workspaces[0].isPrimary).toBe(true);
  });

  it("solo el root del repo es PRIMARY", () => {
    // Una tab abierta en una subcarpeta comparte repo pero no es el checkout.
    const tabs = [tab("/p/src")];
    const repos = new Map([["/p/src", repo("/p", "main")]]);
    expect(buildWorkspaceTree(tabs, repos, null)[0].workspaces[0].isPrimary).toBe(false);
  });

  it("una carpeta sin repo es su propio grupo", () => {
    const tabs = [tab("/tmp/suelto")];
    const tree = buildWorkspaceTree(tabs, new Map(), null);
    expect(tree[0].isRepo).toBe(false);
    expect(tree[0].name).toBe("suelto");
    expect(tree[0].workspaces[0].title).toBe("suelto");
  });

  it("un cwd todavía sin resolver no rompe el árbol", () => {
    // git tarda; el panel se dibuja antes de que vuelvan todas las respuestas.
    const tabs = [tab("/p"), tab("/sin/resolver")];
    const repos = new Map([["/p", repo("/p", "main")]]);
    const tree = buildWorkspaceTree(tabs, repos, null);
    expect(tree).toHaveLength(2);
  });

  it("marca cuál agente es el activo", () => {
    const a = tab("/p");
    const b = tab("/p", "codex");
    const tree = buildWorkspaceTree([a, b], new Map(), b.id);
    const agents = tree[0].workspaces[0].agents;
    expect(agents.find((x) => x.tabId === b.id)!.isActive).toBe(true);
    expect(agents.find((x) => x.tabId === a.id)!.isActive).toBe(false);
  });

  it("sin PTY el agente está arrancando, no corriendo", () => {
    const tabs = [tab("/p", "claude-code", { ptyId: null })];
    const tree = buildWorkspaceTree(tabs, new Map(), null);
    expect(tree[0].workspaces[0].agents[0].status).toBe("starting");
  });

  it("los agentes salen en el orden en que se abrieron", () => {
    const viejo = tab("/p", "a", { openedAt: 10 });
    const nuevo = tab("/p", "b", { openedAt: 99 });
    const tree = buildWorkspaceTree([nuevo, viejo], new Map(), null);
    expect(tree[0].workspaces[0].agents.map((x) => x.agentId)).toEqual(["a", "b"]);
  });

  it("sin tabs, no hay árbol", () => {
    expect(buildWorkspaceTree([], new Map(), null)).toEqual([]);
  });
});

describe("cwdsToResolve", () => {
  it("pide solo los que faltan, sin repetir", () => {
    const tabs = [tab("/a"), tab("/a", "codex"), tab("/b")];
    const resolved = new Map([["/a", repo("/a", "main")]]);
    expect(cwdsToResolve(tabs, resolved)).toEqual(["/b"]);
  });
});

describe("fleetCounts", () => {
  it("cuenta corriendo y arrancando", () => {
    const tabs = [tab("/p"), tab("/p", "codex", { ptyId: null }), tab("/q")];
    const tree = buildWorkspaceTree(tabs, new Map(), null);
    expect(fleetCounts(tree)).toEqual({ running: 2, starting: 1 });
  });
});

describe("workspaces cerrados", () => {
  const snap = (cwd: string, tabs = 2) => ({
    cwd, workspaceId: "ws", closedAt: 0,
    tabs: Array.from({ length: tabs }, () => ({
      title: "t", agentId: "claude-code", agentLabel: "Claude Code", command: "claude",
      prelaunch: [], skillIds: [],
    })),
  });

  it("un workspace cerrado sigue en el panel", () => {
    // Sin esto desaparece al cerrar su última tab y no queda a qué volver.
    const tree = buildWorkspaceTree([], new Map(), null, [snap("/p")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].workspaces[0].closed).toBe(true);
    expect(tree[0].workspaces[0].savedAgents).toBe(2);
  });

  it("entra en el grupo de su repo, junto a los abiertos", () => {
    const abierta = tab("/p");
    const repos = new Map([
      ["/p", repo("/p", "main")],
      ["/wt", repo("/p", "feat", true)],
    ]);
    const tree = buildWorkspaceTree([abierta], repos, null, [snap("/wt")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].workspaces.map((w) => w.closed)).toEqual([false, true]);
  });

  it("lo cerrado va al fondo aunque sea PRIMARY", () => {
    const repos = new Map([
      ["/p", repo("/p", "main")],
      ["/wt", repo("/p", "feat", true)],
    ]);
    const tree = buildWorkspaceTree([tab("/wt")], repos, null, [snap("/p")]);
    expect(tree[0].workspaces.map((w) => w.cwd)).toEqual(["/wt", "/p"]);
  });

  it("una carpeta que se volvió a abrir no aparece dos veces", () => {
    // El recuerdo puede quedar si se reabrió por otro camino; manda lo que corre.
    const tree = buildWorkspaceTree([tab("/p")], new Map(), null, [snap("/p")]);
    expect(tree[0].workspaces).toHaveLength(1);
    expect(tree[0].workspaces[0].closed).toBe(false);
  });

  it("sin agentes vivos, el grupo no cuenta ninguno", () => {
    const tree = buildWorkspaceTree([], new Map(), null, [snap("/p", 3)]);
    expect(tree[0].agentCount).toBe(0);
  });
});

describe("cwdsToResolve con cerrados", () => {
  it("también resuelve las carpetas de los cerrados", () => {
    // Sin esto, un workspace cerrado nunca muestra su rama ni su grupo de repo.
    const snaps = [{ cwd: "/cerrada", workspaceId: "ws", closedAt: 0, tabs: [] }];
    expect(cwdsToResolve([tab("/viva")], new Map(), snaps).sort()).toEqual(["/cerrada", "/viva"]);
  });
});

describe("flattenWorkspaces", () => {
  const ws = (key: string, closed = false): WorkspaceNode => ({
    key, cwd: key, title: key, subtitle: key,
    isPrimary: false, isWorktree: false, changedCount: 0,
    agents: [], closed, savedAgents: 0,
  });
  const group = (name: string, workspaces: WorkspaceNode[]): RepoGroup => ({
    key: name, name, isRepo: true, workspaces, agentCount: 0,
  });

  it("mantiene juntos los workspaces del mismo repo", () => {
    const flat = flattenWorkspaces([
      group("alfa", [ws("alfa/main"), ws("alfa/fix")]),
      group("beta", [ws("beta/main")]),
    ]);
    expect(flat.map((w) => w.key)).toEqual(["alfa/main", "alfa/fix", "beta/main"]);
  });

  it("manda los cerrados al final de todo, no al final de su repo", () => {
    // Sin encabezados que separen los grupos, un apagado en el medio se lee como un hueco.
    const flat = flattenWorkspaces([
      group("alfa", [ws("alfa/main"), ws("alfa/viejo", true)]),
      group("beta", [ws("beta/main")]),
    ]);
    expect(flat.map((w) => w.key)).toEqual(["alfa/main", "beta/main", "alfa/viejo"]);
  });

  it("sin grupos devuelve una lista vacía", () => {
    expect(flattenWorkspaces([])).toEqual([]);
  });
});
