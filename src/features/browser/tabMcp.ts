import { invoke } from "@tauri-apps/api/core";

import { agentDef } from "@/features/agents/registry";

/** Lo que devuelve `tab_browser_mcp` (ver `src-tauri/src/ipc/mcp.rs`). */
export interface TabMcp {
  /** El archivo para `--mcp-config`. `null` = esta TUI no lo recibe así. */
  configPath: string | null;
  allowedTools: string[];
  /** Variables de entorno del proceso, para las TUIs que llevan el servidor en su config
   *  (OpenCode: `OPENCODE_CONFIG_CONTENT`). */
  env: Record<string, string>;
  /** Lo que esta TUI le antepone al nombre de cada tool. */
  toolPrefix: string;
}

/**
 * Si a esta TUI se le puede enchufar el navegador y la orquestación de la app.
 *
 * Sale del catálogo (`agent_registry`, espejo de `registry.rs`) y no de una lista acá: una
 * segunda tabla solo se nota cuando ya divergió, y esto lo decide quién verificó el
 * formato de cada CLI.
 */
export function hasBrowserMcp(agentId: string | null | undefined): boolean {
  const style = agentId ? agentDef(agentId)?.mcp : undefined;
  return style !== undefined && style !== "none";
}

/** El nombre del servidor MCP de la app (`SERVER_NAME` en `src-tauri/src/ipc/mcp.rs`). */
const SERVER_NAME = "controlcode";

/**
 * Con qué nombre tiene que llamar a las tools este agente.
 *
 * OpenCode registra las de un servidor MCP con el nombre del servidor de prefijo
 * (`controlcode_browser_marked`); Claude Code las deja como vienen. Va en todo texto que
 * mande al agente a usar una: el nombre que lee tiene que ser el que puede escribir.
 */
export function browserToolPrefix(agentId: string | null | undefined): string {
  return agentId && agentDef(agentId)?.mcp === "opencodeConfig" ? `${SERVER_NAME}_` : "";
}

const quote = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`);

/** Un valor de flag como se escribe en la línea de comandos: entre comillas o suelto. */
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;

/**
 * Un `--mcp-config` de Control Code que quedó de una corrida anterior, con el
 * `--allowedTools` que lo acompaña.
 *
 * Se reconoce por la carpeta (`.controlcode/mcp`), no por la ruta exacta: el nombre del
 * archivo cambió entre versiones, y compararlo con el de ahora dejaba pasar el viejo. El
 * `--allowedTools` solo se saca si viene pegado al config, que es como lo escribe esta
 * función — uno que el usuario haya puesto en otro lado es suyo y se respeta.
 */
const PREVIOUS = new RegExp(
  String.raw`\s*--mcp-config\s+(?:"[^"]*[/\\]mcp[/\\][^"]*"|'[^']*[/\\]mcp[/\\][^']*'|\S*[/\\]mcp[/\\]\S*)`
  + String.raw`(?:\s+--allowedTools\s+${VALUE})?`,
  "g"
);

/**
 * El comando de una tab de Claude Code con el navegador de la app enchufado: su
 * `--mcp-config` y las tools del navegador ya permitidas.
 *
 * Va al final a propósito: `--mcp-config` y `--allowedTools` aceptan varios valores, y
 * cualquier argumento suelto que viniera después se lo tragarían como si fuera suyo.
 *
 * Lo de una corrida anterior se SACA antes de poner lo de ahora. Así aplicarlo dos veces da
 * lo mismo que aplicarlo una, y una tab que venía con el config de una versión vieja —otra
 * ruta, otras tools— se pasa a la de ahora en vez de arrancar con las dos: la vieja apunta
 * a un archivo que el barrido del arranque ya borró.
 */
export function appendBrowserMcp(command: string, mcp: TabMcp): string {
  const clean = command.replace(PREVIOUS, "").trim();
  if (!mcp.configPath) return clean;
  return `${clean} --mcp-config ${quote(mcp.configPath)} --allowedTools ${quote(mcp.allowedTools.join(","))}`;
}

/** Un lanzamiento con el navegador enchufado: el comando y las variables del proceso. */
export interface BrowserLaunch {
  command: string;
  env: Record<string, string>;
}

/**
 * El lanzamiento de una tab con el navegador de la app enchufado, en el dialecto que
 * acepte esa TUI: flags para Claude Code, una variable de entorno para OpenCode.
 *
 * Si no se puede (una build sin `ccode`, o una TUI a la que todavía no se le verificó el
 * formato), la tab arranca como siempre: el navegador es un agregado, no una condición.
 */
export async function withBrowserMcp(
  command: string,
  cwd: string,
  tabId: string,
  agentId: string
): Promise<BrowserLaunch> {
  try {
    const mcp = await invoke<TabMcp | null>("tab_browser_mcp", { cwd, tabId, agentId });
    if (!mcp) return { command, env: {} };
    return {
      command: mcp.configPath ? appendBrowserMcp(command, mcp) : command,
      env: mcp.env ?? {},
    };
  } catch {
    return { command, env: {} };
  }
}
