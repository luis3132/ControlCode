/**
 * Pasar una tab de Claude Code de la consola al chat y de vuelta, con la misma conversación.
 *
 * La regla que se cuida: nunca dos procesos sobre la misma sesión. Si la TUI y un turno
 * `claude -p --resume` escribieran a la vez el mismo transcript, se pisarían y cada uno
 * seguiría sin saber lo que hizo el otro. Por eso primero se mata lo que corre y recién
 * después arranca lo otro.
 */
import { discoverSessionId } from "@/features/sessions/ipc";
import { LOOKBACK_S } from "@/features/terminal/sessionDiscovery";
import { isHibernated, wake } from "@/features/terminal/hibernation";
import { ptyKill } from "@/features/terminal/ipc";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

import { chatRunning, chatStop } from "./ipc";
import { useChatStore } from "./store";

/** Las tabs que pueden cambiar de modo: el chat sabe hablar solo con Claude Code. */
export const supportsHtmlMode = (agentId: string) => agentId === "claude-code";

/** Lo que tarda la TUI en terminar de escribir su transcript después de que se la mata. */
const SETTLE_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function switchToHtml(tab: Tab): Promise<void> {
  // La sesión hace falta para cargar la conversación y para que el primer mensaje la
  // continúe en vez de empezar otra. Si la terminal todavía no la descubrió, se busca ya.
  let sessionId = tab.sessionId;
  if (!sessionId) {
    sessionId = (await discoverSessionId({
      agentId: tab.agentId,
      cwd: tab.cwd,
      startedAfter: tab.openedAt - LOOKBACK_S,
      accountId: tab.accountId ?? null,
    }).catch(() => null)) ?? undefined;
  }

  // Una hibernada no tiene `<Terminal>` que al desmontarse mate su proceso. Se despierta
  // DESPUÉS de cambiar de modo: antes, montaría una terminal que se reconecta a lo que se
  // está matando.
  const hibernated = isHibernated(tab.id);
  if (tab.ptyId != null && hibernated) ptyKill(tab.ptyId).catch(console.error);
  useTabsStore.getState().updateTab(tab.id, {
    mode: "html",
    ptyId: null,
    launchArgs: undefined,
    ...(sessionId ? { sessionId } : {}),
  });
  if (hibernated) wake(tab.id);

  await sleep(SETTLE_MS);
  const now = useTabsStore.getState().tabs.find((t) => t.id === tab.id);
  if (now) await useChatStore.getState().load(now, true);
}

export async function switchToTerminal(tab: Tab): Promise<void> {
  if (await chatRunning(tab.id).catch(() => false)) {
    await chatStop(tab.id).catch(console.error);
    for (let i = 0; i < 20 && (await chatRunning(tab.id).catch(() => false)); i++) await sleep(100);
  }
  // Sin `ptyId` y con otro nonce, la terminal se monta de cero y lanza `claude --resume`,
  // con el modelo y el esfuerzo del chat: `--resume` solo no los trae (el esfuerzo vuelve
  // al de fábrica), y cambiar de vista no puede cambiar con qué se está trabajando.
  const { model, effort } = useChatStore.getState().get(tab.id);
  useTabsStore.getState().updateTab(tab.id, {
    mode: undefined,
    ptyId: null,
    restartNonce: (tab.restartNonce ?? 0) + 1,
    launchArgs: [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])],
  });
}
