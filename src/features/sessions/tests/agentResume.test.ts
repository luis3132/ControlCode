import { beforeEach, describe, expect, it } from "vitest";

// El fuente de Rust como texto. Va por `?raw` de Vite y no por `node:fs` para no meterle
// `@types/node` al proyecto solo por un test.
import registrySource from "../../../../src-tauri/src/agents/registry.rs?raw";

import { useAgentsStore } from "@/features/agents/store";
import { setAgentRegistry, type AgentRegistryEntry } from "@/features/agents/registry";
import type { CustomAgent } from "@/features/agents/types";

import { buildResumeCommand, isResumable } from "../agentResume";

/**
 * El catálogo salido de `src-tauri/src/agents/registry.rs`, leído del fuente.
 *
 * Se parsea el Rust en vez de escribir a mano las mismas filas acá porque si no este
 * archivo sería otra copia de la tabla — exactamente lo que el registro vino a eliminar—
 * y las aserciones de abajo pasarían aunque la tabla de Rust hubiera cambiado. Es el mismo
 * truco que usa `ipc/test.rs` para atar la CLI con su despachador: dos tablas en archivos
 * distintos no rompen la compilación cuando divergen, así que se las ata leyendo el fuente.
 */
function registryFromRust(): AgentRegistryEntry[] {
  // Solo el cuerpo de la tabla: la struct de arriba también tiene campos `id`/`resume`
  // en sus doc-comments y confundiría al parseo.
  const table = registrySource.slice(registrySource.indexOf("pub const AGENTS"));

  return table
    .split("AgentDef {")
    .slice(1)
    .map((block) => {
      const id = /\bid:\s*"([^"]+)"/.exec(block)?.[1];
      const command = /\bcommand:\s*"([^"]+)"/.exec(block)?.[1];
      const resume = /\bresume:\s*Some\("([^"]+)"\)/.exec(block)?.[1] ?? null;
      const skillsDir = /\bskills_dir:\s*Some\("([^"]+)"\)/.exec(block)?.[1] ?? null;
      if (!id || !command) throw new Error(`fila ilegible en registry.rs: ${block.slice(0, 80)}`);
      const mcp = /\bmcp:\s*McpStyle::(\w+)/.exec(block)?.[1];
      if (!mcp) throw new Error(`la fila '${id}' de registry.rs no declara su McpStyle`);
      return {
        id,
        label: /\blabel:\s*"([^"]+)"/.exec(block)?.[1] ?? id,
        command,
        skillsDir,
        resume,
        supportsAccounts: /\bprofile:\s*Some\(/.test(block),
        sessions: "",
        // `ClaudeFlags` en Rust sale como `claudeFlags` por el `rename_all` de serde.
        mcp: (mcp[0].toLowerCase() + mcp.slice(1)) as AgentRegistryEntry["mcp"],
      };
    });
}

const RUST_REGISTRY = registryFromRust();

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
  setAgentRegistry(RUST_REGISTRY);
});

/// Si el parseo del fuente de Rust se rompe (se renombró un campo, cambió el formato),
/// todas las aserciones de abajo pasarían contra un catálogo vacío sin que nadie se
/// entere. Esta es la que avisa.
it("el catálogo se pudo leer del registro de Rust", () => {
  expect(RUST_REGISTRY.length).toBeGreaterThanOrEqual(5);
  expect(RUST_REGISTRY.map((a) => a.id)).toContain("claude-code");
});

describe("isResumable", () => {
  it("reconoce a las TUIs de fábrica que saben reanudar", () => {
    const resumable = RUST_REGISTRY.filter((a) => a.resume).map((a) => a.id);
    expect(resumable).toHaveLength(5);
    for (const id of resumable) expect(isResumable(id)).toBe(true);
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
