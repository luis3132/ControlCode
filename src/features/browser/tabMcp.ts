import { invoke } from "@tauri-apps/api/core";

/** Lo que devuelve `tab_browser_mcp` (ver `src-tauri/src/ipc/mcp.rs`). */
export interface TabMcp {
  configPath: string;
  allowedTools: string[];
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
  return `${clean} --mcp-config ${quote(mcp.configPath)} --allowedTools ${quote(mcp.allowedTools.join(","))}`;
}

/**
 * Lo mismo, pidiéndole a la app el config de esta carpeta. Si no se puede (una build sin
 * `ccode`), la tab arranca como siempre: el navegador es un agregado, no una condición.
 */
export async function withBrowserMcp(command: string, cwd: string, tabId: string): Promise<string> {
  try {
    const mcp = await invoke<TabMcp | null>("tab_browser_mcp", { cwd, tabId });
    return mcp ? appendBrowserMcp(command, mcp) : command;
  } catch {
    return command;
  }
}
