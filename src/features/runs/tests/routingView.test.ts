import { describe, expect, it } from "vitest";

import {
  addToTier, describeAssignment, fiveHourPercent, launchableAgents, moveEarlier, parseRefKey, refKey,
  removeFromTier,
} from "../routingView";
import type { Assignment, ModelRef, Quota, Roster, RosterAccount } from "../types";

const quota = (utilization: number, resetsAt: number | null): Quota => ({
  fiveHour: { utilization, resetsAt },
  sevenDay: null,
  rejected: false,
  rejectedUntil: null,
  overage: false,
  observedAt: 0,
});

const account = (accountId: string | null, name: string, q: Quota | null = null): RosterAccount => ({
  accountId, key: accountId ?? "system:claude-code", name, label: null, loggedIn: true, quota: q, running: 0,
});

const roster = (accounts: RosterAccount[]): Roster => ({
  agents: [
    {
      agentId: "claude-code", label: "Claude Code", installed: true, launchable: true, unavailable: null,
      models: [{ id: "sonnet", label: "Sonnet", toolcall: true, local: false, costIn: 2, costOut: 10, context: null, unavailable: null }],
      accounts,
    },
    {
      agentId: "opencode", label: "OpenCode", installed: true, launchable: false,
      unavailable: "todavía no se sabe correr OpenCode sin terminal", models: [], accounts: [],
    },
  ],
});

const assigned = (patch: Partial<Assignment> = {}): Assignment => ({
  agentId: "claude-code", model: "sonnet", accountId: null, routedBy: "policy", notes: [], ...patch,
});

describe("fiveHourPercent", () => {
  it("una ventana que ya se reinició vale cero, diga lo que diga el dato viejo", () => {
    expect(fiveHourPercent(quota(0.9, 100), 99)).toBe(90);
    expect(fiveHourPercent(quota(0.9, 100), 100)).toBe(0);
  });

  it("sin dato no inventa un cero", () => {
    expect(fiveHourPercent(null, 0)).toBeNull();
  });
});

describe("describeAssignment", () => {
  it("usa los nombres del roster y el cupo de la cuenta asignada", () => {
    const r = roster([account(null, "principal", quota(0.2, 9_999)), account("t", "trabajo", quota(0.345, 9_999))]);
    expect(describeAssignment(r, assigned({ accountId: "t" }), 0)).toEqual({
      agentLabel: "Claude Code", model: "Sonnet", account: { system: false, name: "trabajo" }, percent: 35,
    });
    expect(describeAssignment(r, assigned(), 0).account).toEqual({ system: true });
  });

  it("con una sola cuenta no la nombra", () => {
    const r = roster([account(null, "Claude Code")]);
    expect(describeAssignment(r, assigned(), 0).account).toBeNull();
  });

  it("sin roster todavía, muestra lo que vino en la asignación", () => {
    expect(describeAssignment(null, assigned({ model: "claude-sonnet-5" }), 0)).toEqual({
      agentLabel: "claude-code", model: "claude-sonnet-5", account: null, percent: null,
    });
  });
});

describe("launchableAgents", () => {
  it("deja afuera lo instalado sin adaptador", () => {
    expect(launchableAgents(roster([])).map((a) => a.agentId)).toEqual(["claude-code"]);
    expect(launchableAgents(null)).toEqual([]);
  });
});

describe("tramos", () => {
  const haiku: ModelRef = { agentId: "claude-code", model: "haiku" };
  const local: ModelRef = { agentId: "opencode", model: "ollama/qwen2.5-coder:14b" };

  it("la clave sobrevive a modelos con dos puntos y barras", () => {
    expect(parseRefKey(refKey(local))).toEqual(local);
    expect(parseRefKey("")).toBeNull();
  });

  it("agregar no repite", () => {
    expect(addToTier([haiku], haiku)).toEqual([haiku]);
    expect(addToTier([haiku], local)).toEqual([haiku, local]);
  });

  it("mover antes cambia la preferencia y no se sale de la lista", () => {
    expect(moveEarlier([haiku, local], 1)).toEqual([local, haiku]);
    expect(moveEarlier([haiku, local], 0)).toEqual([haiku, local]);
  });

  it("quitar nunca deja el tramo vacío", () => {
    expect(removeFromTier([haiku, local], 0)).toEqual([local]);
    expect(removeFromTier([haiku], 0)).toEqual([haiku]);
  });
});
