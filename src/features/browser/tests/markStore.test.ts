import { beforeEach, describe, expect, it } from "vitest";

import type { AnnotatedCapture } from "../composeMessage";
import {
  batchById, batchesFor, consumeMarks, forgetAllMarks, newMarkId, pendingCount, rememberMarks, type SentBatch,
} from "../markStore";
import type { PickedElement } from "../protocol";

const captura = (id: string): AnnotatedCapture => ({ id, path: `/tmp/${id}.png`, url: "http://localhost:5173/" });

const envio = (over: Partial<SentBatch> = {}): SentBatch => ({
  id: newMarkId("m"), agentId: "tab-1", viewId: "view-1", at: 1000,
  picks: [] as PickedElement[], captures: [], note: "", ...over,
});

describe("lo que el usuario le mandó a cada agente", () => {
  beforeEach(forgetAllMarks);

  it("cada id es único y dice qué es", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMarkId("m")));
    expect(ids.size).toBe(200);
    expect(newMarkId("m").startsWith("m-")).toBe(true);
    expect(newMarkId("s").startsWith("s-")).toBe(true);
  });

  it("se busca por su id, y también por el de una de sus capturas", () => {
    // En el aviso van los dos ids; el agente no tiene por qué acertar cuál pegar.
    const uno = envio({ id: "m-1111", captures: [captura("s-aaaa")] });
    rememberMarks(uno);
    expect(batchById("m-1111")).toBe(uno);
    expect(batchById("s-aaaa")).toBe(uno);
    expect(batchById("m-9999")).toBeUndefined();
  });

  it("cada agente ve lo suyo, lo más nuevo primero", () => {
    rememberMarks(envio({ id: "m-1", agentId: "tab-1", at: 10 }));
    rememberMarks(envio({ id: "m-2", agentId: "tab-2", at: 20 }));
    rememberMarks(envio({ id: "m-3", agentId: "tab-1", at: 30 }));
    expect(batchesFor("tab-1").map((b) => b.id)).toEqual(["m-3", "m-1"]);
    expect(batchesFor("tab-2").map((b) => b.id)).toEqual(["m-2"]);
    expect(batchesFor("tab-9")).toEqual([]);
  });

  it("leerlo lo consume: no se sirve dos veces", () => {
    rememberMarks(envio({ id: "m-1" }));
    consumeMarks("m-1");
    expect(batchById("m-1")).toBeUndefined();
    expect(pendingCount()).toBe(0);
  });

  it("no se acumulan para siempre: se van los más viejos", () => {
    for (let i = 0; i < 20; i++) rememberMarks(envio({ id: `m-${i}`, at: i }));
    expect(pendingCount()).toBe(12);
    expect(batchById("m-0")).toBeUndefined();
    expect(batchById("m-19")).toBeDefined();
  });
});
