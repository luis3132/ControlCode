import { beforeEach, describe, expect, it } from "vitest";

import { useAgentsStore } from "@/features/agents/store";
import type { CustomAgent } from "@/features/agents/types";

import { buildResumeCommand, isResumable, RESUMABLE_AGENT_IDS } from "../agentResume";

function customAgent(patch: Partial<CustomAgent> = {}): CustomAgent {
  return {
    id: "mitui",
    label: "Mi TUI",
    command: "mitui",
    resumeArgs: null,
    skillsDir: null,
    sessionsDir: null,
    sessionIdFrom: "filename",
    env: {},
    ...patch,
  };
}

beforeEach(() => {
  useAgentsStore.setState({ customAgents: [], loaded: true });
});

describe("isResumable", () => {
  it("reconoce a las TUIs de fábrica que saben reanudar", () => {
    for (const id of RESUMABLE_AGENT_IDS) expect(isResumable(id)).toBe(true);
  });

  it("bash no reanuda nada", () => {
    expect(isResumable("bash")).toBe(false);
  });

  /// Una TUI custom solo reanuda si el usuario declaró CÓMO: sin `resumeArgs` no hay
  /// forma de construir el comando, y ofrecerlo igual abriría una sesión nueva sin avisar.
  it("una TUI custom reanuda solo si declaró sus argumentos", () => {
    useAgentsStore.setState({ customAgents: [customAgent()] });
    expect(isResumable("mitui")).toBe(false);

    useAgentsStore.setState({ customAgents: [customAgent({ resumeArgs: "--resume {session}" })] });
    expect(isResumable("mitui")).toBe(true);
  });
});

describe("buildResumeCommand", () => {
  it("sin id de sesión devuelve el comando tal cual", () => {
    expect(buildResumeCommand("claude-code", "claude")).toBe("claude");
    expect(buildResumeCommand("claude-code", "claude", undefined)).toBe("claude");
  });

  /// Cada CLI tiene su forma y no son intercambiables: codex usa un SUBCOMANDO y opencode
  /// un flag distinto. Pasarle a una la forma de la otra abre una sesión nueva en silencio.
  it("usa la forma documentada de cada CLI", () => {
    expect(buildResumeCommand("claude-code", "claude", "abc")).toBe("claude --resume abc");
    expect(buildResumeCommand("gemini-cli", "gemini", "abc")).toBe("gemini --resume abc");
    expect(buildResumeCommand("codex", "codex", "abc")).toBe("codex resume abc");
    expect(buildResumeCommand("opencode", "opencode", "abc")).toBe("opencode --session abc");
    expect(buildResumeCommand("kimi-code", "kimi", "abc")).toBe("kimi --session abc");
  });

  it("conserva los flags que ya traía el comando", () => {
    expect(buildResumeCommand("claude-code", "claude --model opus", "abc"))
      .toBe("claude --model opus --resume abc");
  });

  it("una TUI custom sustituye {session} en todas sus apariciones", () => {
    useAgentsStore.setState({
      customAgents: [customAgent({ resumeArgs: "--id {session} --log {session}.log" })],
    });
    expect(buildResumeCommand("mitui", "mitui", "abc"))
      .toBe("mitui --id abc --log abc.log");
  });

  /// Un agente desconocido (o uno custom sin `resumeArgs`) tiene que arrancar limpio en vez
  /// de con un comando inventado que la TUI no entiende.
  it("un agente que no sabe reanudar arranca sin argumentos de reanudación", () => {
    expect(buildResumeCommand("bash", "bash", "abc")).toBe("bash");
    useAgentsStore.setState({ customAgents: [customAgent()] });
    expect(buildResumeCommand("mitui", "mitui", "abc")).toBe("mitui");
  });
});
