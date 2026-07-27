import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabsStore } from "../store/tabs";
import { useSettingsStore } from "../store/settings";
import { flushPendingSave } from "../store/persistTabs";
import { registerPendingSkillSetup } from "./pendingSkillSetup";

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

/** Resuelve el agente pedido contra los detectados + las TUIs custom del usuario. */
function resolveAgent(agentId: string) {
  const { detectedAgents } = useTabsStore.getState();
  const { customAgents } = useSettingsStore.getState();

  const detected = detectedAgents.find((a) => a.id === agentId);
  if (detected) return detected;

  const custom = customAgents.find((a) => a.id === agentId || a.label === agentId);
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
    const known = useTabsStore.getState().detectedAgents.map((a) => a.id).join(", ");
    throw new Error(`Agente desconocido '${agentId}'. Disponibles: ${known}`);
  }

  const tabId = useTabsStore.getState().addTab({ cwd, agent });

  // Mismo gate que el wizard del "+": las skills tienen que estar en disco antes de que
  // el proceso arranque. Se espera acá (y no solo se registra) para que la CLI no
  // devuelva "listo" mientras los symlinks todavía se están escribiendo.
  const skillIds = Array.isArray(args.skills) ? (args.skills as string[]) : [];
  const workspaceId = useTabsStore.getState().workspaceId;
  const setup = (async () => {
    await flushPendingSave();
    for (const skillId of skillIds) {
      await invoke("attach_skill", { skillId, workspaceId, scope: "tab", tabId });
    }
    await invoke("sync_workspace_skills", { workspaceId }).catch(() => {});
  })();
  registerPendingSkillSetup(tabId, setup);
  await setup;

  return { tabId, cwd, agentId: agent.id, agentLabel: agent.label };
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

async function handle(command: string, args: Record<string, unknown>): Promise<unknown> {
  switch (command) {
    case "tab.create": return handleCreateTab(args);
    case "tab.close": return handleCloseTab(args);
    case "tab.ptyId": return handlePtyId(args);
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
      await invoke("cli_respond", { requestId, data, error: null });
    } catch (e) {
      // El error viaja como dato, no como excepción: la CLI tiene que poder imprimir un
      // motivo legible en vez de un timeout.
      await invoke("cli_respond", {
        requestId,
        data: null,
        error: e instanceof Error ? e.message : String(e),
      }).catch(console.error);
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
