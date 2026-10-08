import { beforeEach, describe, expect, it } from "vitest";

import type { Subprocess } from "@/features/processes/types";
import type { PendingApproval } from "@/features/runs/types";

import { busyMap, failedProcesses, finishedTurns, newApprovals } from "../diff";
import { unreadCount, useNotificationsStore } from "../store";

const chat = (running: boolean, starting = false) => ({ running, starting });

function proc(id: string, status: Subprocess["status"], exitCode: number | null = null): Subprocess {
  return {
    id, name: `proc ${id}`, command: "npm run dev", cwd: "/p", workspace: "/p",
    owner: { tabId: null, taskId: null }, status, exitCode, ptyId: 1, startedAt: 0, endedAt: null, restarts: 0,
  };
}

const approval = (id: string) => ({ id, taskId: null, tabId: "t1", toolName: "Bash" }) as PendingApproval;

describe("finishedTurns", () => {
  it("avisa de la tab que dejó de trabajar", () => {
    const prev = busyMap({ a: chat(true), b: chat(true), c: chat(false) });
    const next = busyMap({ a: chat(false), b: chat(true), c: chat(false) });
    expect(finishedTurns(prev, next)).toEqual(["a"]);
  });

  it("arrancar el turno ya cuenta como trabajar", () => {
    const prev = busyMap({ a: chat(false, true) });
    expect(finishedTurns(prev, busyMap({ a: chat(false) }))).toEqual(["a"]);
    // Pasar de arrancando a corriendo no es terminar.
    expect(finishedTurns(prev, busyMap({ a: chat(true) }))).toEqual([]);
  });

  it("una tab que se cerró a mitad del turno no terminó", () => {
    expect(finishedTurns(busyMap({ a: chat(true) }), busyMap({}))).toEqual([]);
  });
});

describe("newApprovals", () => {
  it("solo los permisos que no estaban", () => {
    expect(newApprovals([approval("x")], [approval("x"), approval("y")]).map((a) => a.id)).toEqual(["y"]);
    expect(newApprovals([approval("x")], [])).toEqual([]);
  });
});

describe("failedProcesses", () => {
  it("el que corría y salió con error", () => {
    const prev = [proc("a", "running"), proc("b", "running"), proc("c", "running")];
    const next = [proc("a", "exited", 1), proc("b", "exited", 0), proc("c", "stopped", 143)];
    expect(failedProcesses(prev, next).map((p) => p.id)).toEqual(["a"]);
  });

  it("uno que ya había salido no vuelve a avisar", () => {
    expect(failedProcesses([proc("a", "exited", 1)], [proc("a", "exited", 1)])).toEqual([]);
  });
});

describe("store de avisos", () => {
  beforeEach(() => {
    useNotificationsStore.setState({ notices: [], finished: {} });
  });

  it("lo más nuevo arriba, y abrir la campana los da por leídos", () => {
    const { push } = useNotificationsStore.getState();
    push({ kind: "processFailed", text: "uno", at: 1, target: { path: "/processes" } });
    push({ kind: "approval", text: "dos", at: 2, target: { path: "/fleet" } });
    expect(useNotificationsStore.getState().notices.map((n) => n.text)).toEqual(["dos", "uno"]);
    expect(unreadCount(useNotificationsStore.getState().notices)).toBe(2);
    useNotificationsStore.getState().markAllRead();
    expect(unreadCount(useNotificationsStore.getState().notices)).toBe(0);
  });

  it("no guarda más de 50", () => {
    const { push } = useNotificationsStore.getState();
    for (let i = 0; i < 60; i++) push({ kind: "approval", text: `${i}`, at: i, target: { path: "/fleet" } });
    const notices = useNotificationsStore.getState().notices;
    expect(notices).toHaveLength(50);
    expect(notices[0]!.text).toBe("59");
  });

  it("mirar la tab le quita el punto y deja leído su aviso, no los demás", () => {
    const s = useNotificationsStore.getState();
    s.markFinished("t1", 5);
    s.push({ kind: "finished", text: "t1 terminó", at: 5, target: { tabId: "t1" } });
    s.push({ kind: "approval", text: "t1 pide permiso", at: 6, target: { tabId: "t1" } });
    useNotificationsStore.getState().markSeen("t1");
    const after = useNotificationsStore.getState();
    expect(after.finished).toEqual({});
    expect(after.notices.map((n) => [n.text, n.read])).toEqual([["t1 pide permiso", false], ["t1 terminó", true]]);
  });
});
