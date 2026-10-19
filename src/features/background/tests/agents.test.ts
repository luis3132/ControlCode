import { describe, expect, it } from "vitest";

import type { TabChat } from "@/features/chat/store";
import type { PendingApproval, Task } from "@/features/runs/types";
import type { Tab } from "@/features/tabs/types";

import { backgroundAgents, type BackgroundInput } from "../agents";

const tab = (id: string, extra: Partial<Tab> = {}): Tab =>
  ({ id, title: `Claude — ${id}`, cwd: "/p", agentId: "claude-code", agentLabel: "Claude Code", command: "claude", ptyId: 1, openedAt: 0, ...extra });

const input = (extra: Partial<BackgroundInput>): BackgroundInput => ({
  tabs: [], visibleTabs: new Set(), chats: {}, tasks: [], approvals: [], fleetVisible: false, taskActivity: {}, ...extra,
});

describe("backgroundAgents", () => {
  it("una tab de terminal no se avisa nunca: que su TUI escriba no dice que esté trabajando", () => {
    expect(backgroundAgents(input({ tabs: [tab("a", { ptyId: 7 }), tab("b", { ptyId: 8 })] }))).toEqual([]);
  });

  it("una tab en modo chat que se está viendo, o sin turno, no se avisa", () => {
    const busy = { running: true, starting: false, chat: { items: [] } } as unknown as TabChat;
    const idle = { running: false, starting: false, chat: { items: [] } } as unknown as TabChat;
    const out = backgroundAgents(input({
      tabs: [tab("visible", { mode: "html" }), tab("quieta", { mode: "html" })],
      visibleTabs: new Set(["visible"]),
      chats: { visible: busy, quieta: idle },
    }));
    expect(out).toEqual([]);
  });

  it("una tab en modo chat trabaja mientras corre su turno, con su última herramienta", () => {
    const chat = { running: true, starting: false, chat: { items: [{ kind: "tool", id: 1, toolUseId: "t", name: "Edit", label: "Edit App.tsx", input: null, result: null, children: [] }] } } as unknown as TabChat;
    const out = backgroundAgents(input({ tabs: [tab("a", { mode: "html", ptyId: null })], chats: { a: chat } }));
    expect(out[0]).toMatchObject({ state: "working", detail: "Edit App.tsx" });
  });

  it("las tareas de la flota activas, las que esperan permiso primero; nada si se mira la flota", () => {
    const task = (id: string, status: Task["status"]) => ({ id, title: id, agentId: "codex", status }) as Task;
    const approvals = [{ id: "x", taskId: "b", tabId: null } as PendingApproval];
    const base = { tasks: [task("a", "running"), task("b", "running"), task("c", "done")], approvals, taskActivity: { a: ["Read x", "Edit y"] } };
    const out = backgroundAgents(input(base));
    expect(out.map((a) => [a.id, a.state, a.detail])).toEqual([["b", "waiting", null], ["a", "working", "Edit y"]]);
    expect(backgroundAgents(input({ ...base, fleetVisible: true }))).toEqual([]);
  });
});
