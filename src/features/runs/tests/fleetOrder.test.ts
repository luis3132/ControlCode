import { describe, expect, it } from "vitest";

import { countByGroup, filterFleet, fleetSummary, groupOf, isLive, liveInFolder, sortFleet } from "../fleetOrder";
import { lineOf } from "../store";
import type { PendingApproval, Task, TaskStatus } from "../types";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    runId: "r",
    title: "una tarea",
    prompt: "hacé algo",
    agentId: "claude-code",
    accountId: null,
    model: null,
    cwd: "/tmp/proy",
    budgetUsd: null,
    status: "running" as TaskStatus,
    sessionId: null,
    attempt: 1,
    result: null,
    error: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    eventsPath: null,
    worktreePath: null,
    branch: null,
    worktreeRemoved: false,
    startedAt: null,
    endedAt: null,
    createdAt: 0,
    ...patch,
  };
}

describe("groupOf", () => {
  /// Una tarea creada pero todavía sin proceso es, para quien mira, una que está
  /// arrancando. Ponerla en un grupo propio partiría la flota en categorías que no
  /// significan nada distinto desde afuera.
  it("lista y corriendo son lo mismo para la consola", () => {
    expect(groupOf(task({ id: "a", status: "ready" }))).toBe("running");
    expect(groupOf(task({ id: "b", status: "running" }))).toBe("running");
  });

  it("todo lo terminado cae en el mismo grupo", () => {
    for (const status of ["done", "failed", "cancelled"] as TaskStatus[]) {
      expect(groupOf(task({ id: status, status }))).toBe("idle");
    }
  });
});

describe("sortFleet", () => {
  /// Es el orden del que depende que la consola sirva: si el que está trabado queda
  /// enterrado entre los que trabajan, es un agente parado que nadie ve.
  it("primero los que trabajan, después los terminados", () => {
    const orden = sortFleet([
      task({ id: "vieja", status: "done", endedAt: 100 }),
      task({ id: "corriendo", status: "running", startedAt: 50 }),
      task({ id: "reciente", status: "failed", endedAt: 900 }),
    ]).map((t) => t.id);

    expect(orden).toEqual(["corriendo", "reciente", "vieja"]);
  });

  /// El que lleva más tiempo corriendo es el que más probablemente se colgó, así que es a
  /// quien conviene mirar primero.
  it("entre los que trabajan va primero el que arrancó hace más", () => {
    const orden = sortFleet([
      task({ id: "nueva", status: "running", startedAt: 900 }),
      task({ id: "antigua", status: "running", startedAt: 100 }),
    ]).map((t) => t.id);

    expect(orden).toEqual(["antigua", "nueva"]);
  });

  it("no muta el arreglo que recibe", () => {
    const original = [task({ id: "b", status: "done" }), task({ id: "a", status: "running" })];
    const copia = [...original];
    sortFleet(original);
    expect(original.map((t) => t.id)).toEqual(copia.map((t) => t.id));
  });

  /// Una tarea que nunca arrancó no tiene `startedAt`; sin el respaldo en `createdAt` el
  /// orden se volvería arbitrario justo con las que fallaron al lanzarse.
  it("una tarea sin arrancar igual se ordena", () => {
    const orden = sortFleet([
      task({ id: "sin-fecha", status: "running", startedAt: null, createdAt: 500 }),
      task({ id: "con-fecha", status: "running", startedAt: 100 }),
    ]).map((t) => t.id);

    expect(orden).toEqual(["con-fecha", "sin-fecha"]);
  });
});

describe("countByGroup", () => {
  it("cuenta los tres grupos aunque alguno esté vacío", () => {
    const counts = countByGroup([
      task({ id: "a", status: "running" }),
      task({ id: "b", status: "done" }),
      task({ id: "c", status: "cancelled" }),
    ]);
    expect(counts).toEqual({ needsYou: 0, running: 1, idle: 2 });
  });
});

describe("filterFleet", () => {
  const flota = [
    task({ id: "a", title: "arreglar el cgroup", cwd: "/home/u/ControlCode" }),
    task({ id: "b", title: "auditar tokens", cwd: "/home/u/ui-lib", status: "done" }),
  ];

  it("sin filtro ni búsqueda devuelve todo", () => {
    expect(filterFleet(flota, null, "").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("filtra por grupo", () => {
    expect(filterFleet(flota, "idle", "").map((t) => t.id)).toEqual(["b"]);
  });

  /// Se busca también por carpeta porque con varios proyectos abiertos "el de la ui" es
  /// como uno se refiere a un agente, no por el título que le puso.
  it("busca por título, carpeta y agente, sin distinguir mayúsculas", () => {
    expect(filterFleet(flota, null, "CGROUP").map((t) => t.id)).toEqual(["a"]);
    expect(filterFleet(flota, null, "ui-lib").map((t) => t.id)).toEqual(["b"]);
    expect(filterFleet(flota, null, "claude").map((t) => t.id)).toEqual(["a", "b"]);
    expect(filterFleet(flota, null, "   ").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("el grupo y la búsqueda se combinan", () => {
    expect(filterFleet(flota, "running", "auditar")).toEqual([]);
  });
});

describe("isLive", () => {
  it("solo lista y corriendo siguen cambiando solas", () => {
    expect(isLive("ready")).toBe(true);
    expect(isLive("running")).toBe(true);
    expect(isLive("done")).toBe(false);
    expect(isLive("failed")).toBe(false);
    expect(isLive("cancelled")).toBe(false);
  });
});

describe("lineOf", () => {
  it("muestra el texto y la etiqueta de la herramienta", () => {
    expect(lineOf({ kind: "text", text: "Voy a mirar" })).toBe("Voy a mirar");
    expect(lineOf({ kind: "tool", name: "Bash", label: "Bash(cargo test)" }))
      .toBe("Bash(cargo test)");
  });

  /// Arrancar y terminar ya se ven en el badge de la tarjeta: repetirlos como línea
  /// gastaría uno de los cinco renglones en algo que no dice nada nuevo.
  it("arrancar y terminar no gastan un renglón", () => {
    expect(lineOf({ kind: "started", sessionId: "abc" })).toBeNull();
    expect(
      lineOf({
        kind: "finished",
        outcome: { ok: true, result: null, error: null, costUsd: null, tokensIn: null, tokensOut: null },
      })
    ).toBeNull();
  });
});

describe("needsYou", () => {
  const flota = [
    task({ id: "trabajando", status: "running", startedAt: 10 }),
    task({ id: "trabada", status: "running", startedAt: 900 }),
    task({ id: "lista", status: "done", endedAt: 999 }),
  ];
  const bloqueadas = new Set(["trabada"]);

  /// Una tarea con un permiso esperando sigue en `running` para el backend, pero desde
  /// afuera no está trabajando: está parada por culpa del usuario.
  it("una tarea con un permiso esperando deja de contar como trabajando", () => {
    expect(groupOf(task({ id: "trabada", status: "running" }), bloqueadas)).toBe("needsYou");
    expect(groupOf(task({ id: "otra", status: "running" }), bloqueadas)).toBe("running");
  });

  /// Es el orden del que depende que la consola sirva: la que pide algo va arriba de todo,
  /// aunque haya arrancado después que las demás.
  it("la trabada va primera aunque sea la más nueva", () => {
    expect(sortFleet(flota, bloqueadas).map((t) => t.id))
      .toEqual(["trabada", "trabajando", "lista"]);
  });

  it("el contador la mueve de grupo", () => {
    expect(countByGroup(flota, bloqueadas)).toEqual({ needsYou: 1, running: 1, idle: 1 });
  });

  it("el filtro de 'te necesita' deja solo a las trabadas", () => {
    expect(filterFleet(flota, "needsYou", "", bloqueadas).map((t) => t.id)).toEqual(["trabada"]);
  });

  /// Sin el conjunto, todo se comporta como antes: es lo que permite que la consola pinte
  /// aunque la cola de permisos todavía no haya llegado.
  it("sin datos de bloqueo nada cambia", () => {
    expect(countByGroup(flota)).toEqual({ needsYou: 0, running: 2, idle: 1 });
  });
});

describe("handed_off", () => {
  /// Pasada a una terminal, la tarea deja de ser trabajo en segundo plano: no está parada
  /// esperando ni avanzando sola, así que va con las terminadas y no suma a "trabajando".
  it("una tarea pasada a terminal cuenta como terminada y ya no está viva", () => {
    expect(groupOf(task({ id: "t", status: "handed_off" }))).toBe("idle");
    expect(isLive("handed_off")).toBe(false);
  });
});

function pedido(taskId: string): PendingApproval {
  return { id: `ap-${taskId}`, taskId, toolName: "Edit", input: {}, askedAt: 0, suggestedRule: null };
}

describe("fleetSummary", () => {
  const flota = [
    task({ id: "a", status: "running", costUsd: 0.1 }),
    task({ id: "b", status: "running", costUsd: 0.25 }),
    task({ id: "c", status: "done", costUsd: 0.05 }),
  ];

  /// Una tarea trabada no puede contar dos veces: está en "te espera", no en "trabajando".
  /// Sumarla a los dos lados haría que la barra prometa más agentes de los que hay.
  it("la trabada cuenta como que te espera, no como trabajando", () => {
    expect(fleetSummary(flota, [pedido("a")])).toMatchObject({ running: 1, needsYou: 1 });
  });

  /// La cola de permisos es de toda la app, pero la barra lleva a la consola de ESTE
  /// workspace: contar un pedido que al abrirla no aparece sería mentirle al que hace click.
  it("no cuenta pedidos de tareas que no están en la lista", () => {
    expect(fleetSummary(flota, [pedido("de-otro-workspace")]).needsYou).toBe(0);
  });

  it("varios pedidos de la misma tarea son una sola tarea esperando", () => {
    expect(fleetSummary(flota, [pedido("a"), { ...pedido("a"), id: "otro" }]).needsYou).toBe(1);
  });

  it("suma lo gastado de toda la flota, terminadas incluidas", () => {
    expect(fleetSummary(flota, []).spentUsd).toBeCloseTo(0.4);
  });

  it("sin flota no hay nada que mostrar", () => {
    expect(fleetSummary([], [])).toEqual({ running: 0, needsYou: 0, spentUsd: 0 });
  });
});

describe("liveInFolder", () => {
  /// Es lo que decide si el siguiente agente arranca aislado: uno solo en la carpeta no
  /// choca con nadie, un segundo editaría los mismos archivos.
  it("cuenta solo los que trabajan sobre la carpeta misma", () => {
    const flota = [
      task({ id: "a", status: "running", cwd: "/p" }),
      task({ id: "b", status: "ready", cwd: "/p" }),
      // En su worktree: no toca la carpeta, no choca.
      task({ id: "c", status: "running", cwd: "/w/ab12", worktreePath: "/w/ab12" }),
      // Terminado: ya no edita nada.
      task({ id: "d", status: "done", cwd: "/p" }),
      // Otra carpeta.
      task({ id: "e", status: "running", cwd: "/otra" }),
    ];
    expect(liveInFolder(flota, "/p")).toBe(2);
    expect(liveInFolder(flota, "/nadie")).toBe(0);
  });
});
