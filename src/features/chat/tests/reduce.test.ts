import { describe, expect, it } from "vitest";

import { addUser, reduceAll, reduceChat, settleStreaming, unfinishedTools } from "../reduce";
import { emptyChat, type ChatEvent } from "../types";

const text = (t: string, parent: string | null = null): ChatEvent => ({ kind: "text", text: t, parent });
const delta = (t: string): ChatEvent => ({ kind: "textDelta", text: t, parent: null });
const toolUse = (id: string, parent: string | null = null): ChatEvent => ({
  kind: "toolUse", id, name: "Bash", input: { command: "ls" }, label: "Bash(ls)", parent,
});
const result = (id: string): ChatEvent => ({
  kind: "toolResult", toolUseId: id, content: "a.txt", isError: false, images: 0, truncated: false, parent: null,
});

describe("reduceChat", () => {
  it("el texto se va escribiendo y el bloque entero lo reemplaza", () => {
    let s = reduceAll(emptyChat(), [delta("Ho"), delta("la")]);
    expect(s.items).toEqual([{ kind: "text", id: 1, text: "Hola", streaming: true }]);
    s = reduceChat(s, text("Hola."));
    expect(s.items).toEqual([{ kind: "text", id: 1, text: "Hola.", streaming: false }]);
  });

  it("una herramienta se anuncia, recibe su input y después su resultado", () => {
    const s = reduceAll(emptyChat(), [
      { kind: "toolStart", id: "t1", name: "Bash", parent: null },
      toolUse("t1"),
      result("t1"),
    ]);
    expect(s.items).toHaveLength(1);
    const tool = s.items[0]!;
    expect(tool.kind === "tool" && tool.label).toBe("Bash(ls)");
    expect(tool.kind === "tool" && tool.result?.content).toBe("a.txt");
  });

  it("lo que hace un subagente queda adentro de su Task", () => {
    const s = reduceAll(emptyChat(), [
      { kind: "toolUse", id: "task", name: "Task", input: {}, label: "Task(x)", parent: null },
      toolUse("t2", "task"),
      result("t2"),
      text("listo", "task"),
    ]);
    expect(s.items).toHaveLength(1);
    const task = s.items[0]!;
    if (task.kind !== "tool") throw new Error("no es tool");
    expect(task.children.map((c) => c.kind)).toEqual(["tool", "text"]);
    expect(task.children[0]!.kind === "tool" && task.children[0]!.result?.content).toBe("a.txt");
    expect(unfinishedTools(s.items)).toEqual(["task"]);
  });

  it("un comando se junta con su salida y la compactación con su resumen", () => {
    const s = reduceAll(emptyChat(), [
      { kind: "compacted" },
      { kind: "summary", text: "resumen" },
      { kind: "command", name: "compact", args: "" },
      { kind: "commandOutput", text: "Compacted" },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["compacted", "command"]);
    expect(s.items[0]!.kind === "compacted" && s.items[0]!.summary).toBe("resumen");
    expect(s.items[1]!.kind === "command" && s.items[1]!.output).toBe("Compacted");
  });

  it("el cierre deja de escribir y limpia el estado", () => {
    let s = reduceAll(emptyChat(), [{ kind: "status", status: "requesting" }, delta("a")]);
    s = reduceChat(s, { kind: "result", ok: true, error: null, costUsd: 0.01, tokensIn: 10, tokensOut: 2, durationMs: 5 });
    expect(s.status).toBeNull();
    expect(s.items[0]!.kind === "text" && s.items[0]!.streaming).toBe(false);
    expect(s.items[1]!.kind).toBe("result");
  });

  it("lo que manda la persona corta lo que se venía escribiendo", () => {
    const s = addUser(reduceChat(emptyChat(), delta("medio")), "otra cosa", 1);
    expect(s.items).toEqual([
      { kind: "text", id: 1, text: "medio", streaming: false },
      { kind: "user", id: 2, text: "otra cosa", images: 1 },
    ]);
    expect(settleStreaming(s)).toBe(s);
  });
});
