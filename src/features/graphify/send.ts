/**
 * A dónde va cada comando de graphify cuando no se ejecuta con la salida capturada.
 *
 * Son dos destinos distintos y la diferencia no es de comodidad:
 *
 * - Un comando de shell largo (`graphify watch`, el servidor MCP) no termina nunca. Correrlo
 *   con la salida capturada dejaría a la app esperando hasta el tope de tiempo, sin
 *   mostrar nada. Va a una **terminal**, donde se lo ve correr y se lo puede cortar.
 * - Una línea del asistente (`/graphify .`) **no existe** como binario: es la skill, y la
 *   corre el modelo. En un shell daría "command not found". Va a la **terminal de un
 *   agente**, escrita como si la hubiera tipeado la persona.
 */
import type { AgentInfo } from "@/features/tabs/types";
import { pasteIntoTab } from "@/features/terminal/terminalRegistry";
import { useTabsStore } from "@/features/tabs/store";

/** La TUI de emergencia: una terminal pelada, que es donde corre un comando del sistema. */
const SHELL_AGENT: AgentInfo = {
  id: "bash",
  label: "Terminal (bash)",
  command: "bash",
  available: true,
};

/**
 * Abre una terminal en `cwd` con el comando ya corriendo, y deja el shell abierto después.
 *
 * Va como paso de pre-lanzamiento y no como comando de la tab por el PATH: un paso de
 * pre-lanzamiento corre dentro de un shell de **login** (ver `terminal::pty_manager`), que
 * es de donde sale `~/.local/bin` — donde `uv tool install` deja el ejecutable. Como
 * comando pelado de la tab, `graphify` no se encontraría.
 *
 * Devuelve el id de la tab nueva.
 */
export function runInTerminal(command: string, cwd: string, title: string): string {
  return useTabsStore.getState().addTab({
    cwd,
    agent: SHELL_AGENT,
    title,
    titleIsCustom: true,
    prelaunch: [{ command }],
  });
}

/** Las tabs de agente de una carpeta: a un `bash` no se le manda una línea del asistente. */
export function agentTabs(cwd: string) {
  return useTabsStore
    .getState()
    .tabs.filter((tab) => tab.agentId !== "bash" && (!cwd || tab.cwd === cwd));
}

/**
 * Escribe la línea en la terminal de un agente y la envía.
 *
 * `false` = esa tab no tiene una terminal viva (todavía no arrancó, o ya salió), y lo que
 * se escriba se perdería sin aviso.
 */
export function sendToAgent(tabId: string, line: string): boolean {
  return pasteIntoTab(tabId, line, true);
}
