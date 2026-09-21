import { beforeEach, describe, expect, it } from "vitest";

import { setAgentRegistry, type AgentRegistryEntry } from "@/features/agents/registry";

import { appendBrowserMcp, browserToolPrefix, hasBrowserMcp, type TabMcp } from "../tabMcp";

const entry = (id: string, mcp: AgentRegistryEntry["mcp"]): AgentRegistryEntry => ({
  id, label: id, command: id, skillsDir: null, resume: null, supportsAccounts: false, sessions: "", mcp,
});

describe("appendBrowserMcp", () => {
  const mcp: TabMcp = {
    configPath: "/home/u/.controlcode/mcp/tab-abc.json",
    allowedTools: ["mcp__controlcode__browser_click", "mcp__controlcode__browser_snapshot"],
    env: {},
    toolPrefix: "",
  };

  /// Al final y no al principio: los dos flags aceptan varios valores, y un argumento
  /// suelto después (un prompt, un id de sesión) terminaría adentro de la lista.
  it("agrega el config y las tools al final del comando", () => {
    expect(appendBrowserMcp("claude --resume abc", mcp)).toBe(
      'claude --resume abc --mcp-config "/home/u/.controlcode/mcp/tab-abc.json" '
      + '--allowedTools "mcp__controlcode__browser_click,mcp__controlcode__browser_snapshot"'
    );
  });

  it("no lo duplica si ya está", () => {
    const once = appendBrowserMcp("claude", mcp);
    expect(appendBrowserMcp(once, mcp)).toBe(once);
  });

  /// El nombre del archivo cambió entre versiones. Una tab abierta desde antes traía el
  /// viejo, y compararlo con el de ahora no lo reconocía: el agente arrancaba con DOS
  /// servidores, uno apuntando a un archivo que el barrido del arranque ya borró.
  it("reemplaza el config de una versión anterior en vez de sumarle otro", () => {
    const viejo = 'claude --resume abc --mcp-config "/home/u/.controlcode/mcp/tab-9f2c1aa0.json" '
      + '--allowedTools "mcp__controlcode__browser_click"';
    const nuevo = appendBrowserMcp(viejo, mcp);
    expect(nuevo.match(/--mcp-config/g)).toHaveLength(1);
    expect(nuevo.match(/--allowedTools/g)).toHaveLength(1);
    expect(nuevo).toContain("tab-abc.json");
    expect(nuevo).not.toContain("tab-9f2c1aa0.json");
    expect(nuevo.startsWith("claude --resume abc ")).toBe(true);
  });

  /// Un `--mcp-config` del usuario apunta a otro lado y no se toca: es un MCP suyo, no uno
  /// que puso la app.
  it("no toca los MCP que puso el usuario", () => {
    const propio = 'claude --mcp-config "/home/u/mis-servidores.json"';
    const nuevo = appendBrowserMcp(propio, mcp);
    expect(nuevo).toContain("/home/u/mis-servidores.json");
    expect(nuevo.match(/--mcp-config/g)).toHaveLength(2);
  });
});

/// El catálogo es el que sabe cómo se le enchufa el MCP a cada TUI. Acá se prueba lo que la
/// app HACE con eso: si le pone el navegador, y con qué nombre le dice al agente que llame
/// a las tools.
describe("qué TUI recibe el navegador y cómo nombra sus tools", () => {
  beforeEach(() => {
    setAgentRegistry([
      entry("claude-code", "claudeFlags"),
      entry("opencode", "opencodeConfig"),
      entry("codex", "none"),
    ]);
  });

  it("lo reciben las TUIs con un formato verificado, no una sola", () => {
    expect(hasBrowserMcp("claude-code")).toBe(true);
    expect(hasBrowserMcp("opencode")).toBe(true);
    expect(hasBrowserMcp("codex")).toBe(false);
    // Una TUI que el usuario agregó a mano: no está en el catálogo, no se le inventa nada.
    expect(hasBrowserMcp("mitui")).toBe(false);
    expect(hasBrowserMcp(null)).toBe(false);
  });

  /// OpenCode registra las tools de un servidor MCP con el nombre del servidor de prefijo.
  /// Decirle "usá browser_marked" cuando lo que tiene se llama `controlcode_browser_marked`
  /// es mandarlo a una tool que no existe.
  it("OpenCode las nombra con el servidor delante; Claude Code no", () => {
    expect(browserToolPrefix("opencode")).toBe("controlcode_");
    expect(browserToolPrefix("claude-code")).toBe("");
    expect(browserToolPrefix("codex")).toBe("");
    expect(browserToolPrefix(null)).toBe("");
  });
});
