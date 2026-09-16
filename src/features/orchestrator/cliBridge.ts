import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "@/features/tabs/store";
import type { PrelaunchStep } from "@/features/prelaunch/types";
import { useAgentsStore } from "@/features/agents/store";
import { attachSkillsToTab } from "@/features/skills/attachSkills";
import { registerPendingSkillSetup } from "@/features/skills/pendingSkillSetup";
import { runBrowserRequest, type BrowserRequest } from "@/features/browser/agentBridge";
import type { ViewOwner } from "@/features/tabs/viewTabs";
import { useRunsStore } from "@/features/runs/store";
import { useAskStore } from "@/features/ask/askStore";
import { respondToCli } from "./ipc";

/**
 * Lado frontend del puente de la CLI (ver `ipc/bridge.rs`).
 *
 * Los comandos que tocan tabs no se pueden resolver en Rust mientras la app corre: la
 * fuente de verdad de las tabs es el store de Zustand, y SQLite es su reflejo escrito con
 * debounce. Escribir en la DB por atrás dejaría a la ventana mostrando lo de antes.
 *
 * Cada ventana escucha, pero solo actúa si el evento la nombra: el backend elige una y
 * pone su label en `targetLabel`.
 */

interface BridgeRequest {
  requestId: string;
  targetLabel: string;
  command: string;
  args: Record<string, unknown>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Forma canónica para comparar nombres de agente: sin mayúsculas ni separadores.
 *
 * Desde una terminal nadie recuerda si es `claude-code`, `claudecode` o "Claude Code", y
 * fallar por un guión es la clase de fricción que hace que un agente abandone el comando.
 * Así `claudecode`, `Claude Code` y `claude-code` son todos el mismo.
 */
function canonical(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Resuelve el agente pedido contra los detectados + las TUIs custom del usuario. */
function resolveAgent(requested: string) {
  const { detectedAgents } = useTabsStore.getState();
  const { customAgents } = useAgentsStore.getState();
  const wanted = canonical(requested);

  const detected = detectedAgents.find(
    (a) => canonical(a.id) === wanted || canonical(a.label) === wanted
  );
  if (detected) return detected;

  const custom = customAgents.find(
    (a) => canonical(a.id) === wanted || canonical(a.label) === wanted
  );
  if (custom) {
    return { id: custom.id, label: custom.label, command: custom.command, available: true };
  }
  return null;
}

async function handleCreateTab(args: Record<string, unknown>): Promise<unknown> {
  const cwd = str(args, "cwd");
  const agentId = str(args, "agent");
  if (!cwd) throw new Error("Falta --cwd");
  if (!agentId) throw new Error("Falta --agent");

  const agent = resolveAgent(agentId);
  if (!agent) {
    // Se listan también las custom: son justo las que nadie puede adivinar.
    const known = [
      ...useTabsStore.getState().detectedAgents.map((a) => a.id),
      ...useAgentsStore.getState().customAgents.map((a) => a.id),
    ].join(", ");
    throw new Error(`Agente desconocido '${agentId}'. Disponibles: ${known}`);
  }

  // El backend ya tradujo `--account <nombre>` a un id y falló si no existía (ver
  // `resolve_account_id`), así que acá solo se pasa. Ausente = la cuenta principal.
  const accountId = str(args, "accountId");
  // Ídem con `--pre`/`--pre-preset`: el backend ya resolvió los nombres de preset a ids y
  // falló si alguno no existía (ver `resolve_prelaunch_steps`).
  const prelaunch = Array.isArray(args.prelaunch) ? (args.prelaunch as PrelaunchStep[]) : [];
  const tabId = useTabsStore.getState().addTab({ cwd, agent, accountId, prelaunch });

  // Mismo gate que el wizard del "+": las skills tienen que estar en disco antes de que
  // el proceso arranque. Se espera acá (y no solo se registra) para que la CLI no
  // devuelva "listo" mientras los symlinks todavía se están escribiendo.
  const skillIds = Array.isArray(args.skills) ? (args.skills as string[]) : [];
  const workspaceId = useTabsStore.getState().workspaceId;
  const setup = attachSkillsToTab(tabId, workspaceId, skillIds);
  registerPendingSkillSetup(tabId, setup);
  // La CLI sí falla fuerte: quien automatiza necesita enterarse de que la tab quedó sin
  // las skills que pidió, no descubrirlo después mirando la terminal.
  const errors = await setup;
  if (errors.length > 0) throw new Error(errors.join(" · "));

  // `accountId` viaja de vuelta para que el orquestador pueda comprobar con qué cuenta
  // quedó la tab sin tener que consultarlo aparte.
  return { tabId, cwd, agentId: agent.id, agentLabel: agent.label, accountId: accountId ?? null };
}

function handleCloseTab(args: Record<string, unknown>): unknown {
  const tabId = str(args, "tab");
  if (!tabId) throw new Error("Falta --tab");

  const { tabs, closeTab } = useTabsStore.getState();
  if (!tabs.some((t) => t.id === tabId)) {
    throw new Error(`Esta ventana no tiene ninguna tab con id ${tabId}`);
  }
  closeTab(tabId);
  return { tabId, closed: true };
}

function handlePtyId(args: Record<string, unknown>): unknown {
  const tabId = str(args, "tabId");
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`Esta ventana no tiene ninguna tab con id ${tabId}`);
  if (tab.ptyId == null) throw new Error(`La tab ${tabId} todavía no tiene un proceso corriendo`);
  return { ptyId: tab.ptyId };
}

/**
 * Quién hace el pedido, con el nombre que la interfaz ya le da: la tab del agente o la
 * tarjeta de la flota. El backend manda el id; el nombre vive acá, que es donde está.
 *
 * Sin dueño (un `ccode mcp` viejo, sin `--tab`) el agente comparte el navegador del
 * usuario, como hasta ahora: es peor, pero sigue andando.
 */
function ownerOf(args: Record<string, unknown>): ViewOwner | null {
  const owner = args.owner as { kind?: unknown; id?: unknown } | null | undefined;
  if (!owner || typeof owner.id !== "string") return null;
  if (owner.kind === "task") {
    const task = useRunsStore.getState().tasks.find((t) => t.id === owner.id);
    return { kind: "task", id: owner.id, label: task?.title ?? owner.id };
  }
  const tab = useTabsStore.getState().tabs.find((t) => t.id === owner.id);
  if (!tab) return null;
  return { kind: "tab", id: owner.id, label: tab.title };
}

/** Un agente usando el navegador de su proyecto, desde el MCP (`ccode mcp`). */
async function handleBrowser(args: Record<string, unknown>): Promise<unknown> {
  const cwd = str(args, "cwd");
  if (!cwd) throw new Error("Falta la carpeta del proyecto");
  const request = args.request as BrowserRequest | undefined;
  if (!request || typeof request.op !== "string") throw new Error("Falta qué hacer en el navegador");
  return { text: await runBrowserRequest(cwd, request, ownerOf(args)) };
}

/**
 * Un agente preguntándole algo a la persona. Se resuelve cuando contesta (o cuando cierra
 * la tarjeta, que también es una respuesta) — del otro lado el agente está esperando.
 */
async function handleAsk(args: Record<string, unknown>): Promise<unknown> {
  const question = str(args, "question");
  if (!question) throw new Error("Falta la pregunta");
  const options = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string") : [];
  const timeoutMs = (typeof args.timeout_s === "number" ? args.timeout_s : 1800) * 1000;
  const owner = ownerOf(args);

  const answer = await new Promise<string | null>((resolve) => {
    const id = crypto.randomUUID();
    let done = false;
    const once = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Vence también de este lado: si nadie la mira, la tarjeta se va sola en vez de
    // quedarse para siempre ofreciendo contestar algo que ya no espera nadie.
    const timer = setTimeout(() => {
      useAskStore.getState().answer(id, null);
      once(null);
    }, timeoutMs);
    useAskStore.getState().add({
      id,
      question,
      options,
      placeholder: str(args, "placeholder"),
      from: owner?.label ?? str(args, "cwd") ?? "un agente",
      fromId: owner?.id ?? str(args, "cwd") ?? "?",
      expiresAt: Date.now() + timeoutMs,
      resolve: once,
    });
  });

  if (answer === null) {
    throw new Error("El usuario no contestó: seguí con lo que puedas decidir solo, o dejalo anotado en tu resultado.");
  }
  return { text: answer };
}

async function handle(command: string, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "tab.create": return handleCreateTab(args);
    case "tab.close": return handleCloseTab(args);
    case "tab.ptyId": return handlePtyId(args);
    case "browser.run": return handleBrowser(args);
    case "user.ask": return handleAsk(args);
    default: throw new Error(`El frontend no sabe atender '${command}'`);
  }
}

/** Engancha esta ventana al puente. Devuelve la función para desengancharla. */
export function initCliBridge(): () => void {
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  listen<BridgeRequest>("cc-cli-request", async (event) => {
    const { requestId, targetLabel, command, args } = event.payload;
    if (targetLabel !== getCurrentWindow().label) return;

    try {
      const data = await handle(command, args ?? {});
      await respondToCli(requestId, data, null);
    } catch (e) {
      // El error viaja como dato, no como excepción: la CLI tiene que poder imprimir un
      // motivo legible en vez de un timeout.
      await respondToCli(
        requestId,
        null,
        e instanceof Error ? e.message : String(e)
      ).catch(console.error);
    }
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
