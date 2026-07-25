import {
  ClaudeIcon,
  GeminiIcon,
  OpenAIIcon,
  StackIcon,
  MoonIcon,
  MonitorIcon,
  BoxIcon,
} from "neogestify-ui-components";

type AgentIconComponent = (props: { className: string }) => React.JSX.Element;

/**
 * Icono de cada agente soportado, por el `id` que les asigna la auto-detección
 * (ver `agents/detector.rs`). Los que no tienen logo propio en la librería usan uno
 * genérico con sentido: OpenCode → capas (multi-provider), Kimi → luna (Moonshot AI),
 * terminal pura → monitor.
 */
const BY_ID: Record<string, AgentIconComponent> = {
  "claude-code": ClaudeIcon,
  "gemini-cli": GeminiIcon,
  codex: OpenAIIcon,
  opencode: StackIcon,
  "kimi-code": MoonIcon,
  bash: MonitorIcon,
};

/** Agentes custom: no tienen un id conocido, así que se infiere por su comando. */
const BY_COMMAND_HINT: [string, AgentIconComponent][] = [
  ["claude", ClaudeIcon],
  ["gemini", GeminiIcon],
  ["codex", OpenAIIcon],
  ["opencode", StackIcon],
  ["kimi", MoonIcon],
  ["bash", MonitorIcon],
  ["zsh", MonitorIcon],
  ["fish", MonitorIcon],
  ["sh", MonitorIcon],
];

/**
 * Icono a mostrar para un agente. Nunca devuelve `null`: un agente desconocido
 * (custom con un comando que no reconocemos) cae en un icono neutro, para que la grilla
 * del Home no quede con huecos desalineados.
 */
export function agentIcon(agentId: string, command?: string): AgentIconComponent {
  const byId = BY_ID[agentId];
  if (byId) return byId;

  const haystack = `${agentId} ${command ?? ""}`.toLowerCase();
  const hit = BY_COMMAND_HINT.find(([hint]) => haystack.includes(hint));
  return hit ? hit[1] : BoxIcon;
}
