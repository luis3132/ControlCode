/**
 * El estado de cada tab en modo HTML: la conversación, el turno en curso, la cola y lo que
 * se está escribiendo.
 *
 * Global y no adentro de `ChatView` porque lo leen otras partes: el punto de la tab, el
 * aviso de permisos y `pasteIntoTab` (soltar un archivo, mandar un elemento del navegador),
 * que escriben en el input aunque el chat no esté a la vista.
 */
import { create } from "zustand";

import i18n from "@/i18n";
import { accountEnv } from "@/features/accounts/ipc";
import { resolvePrelaunch } from "@/features/prelaunch/ipc";
import { useRunsStore } from "@/features/runs/store";
import { reconcileTabSkills } from "@/features/skills/ipc";
import { awaitSkillSetup } from "@/features/skills/pendingSkillSetup";
import { useTabsStore } from "@/features/tabs/store";
import type { Tab } from "@/features/tabs/types";

import { chatRunning, chatSend, chatSessionSettings, chatStop, chatTranscript } from "./ipc";
import { buildContent, parseSlash } from "./message";
import { loadMode, loadModel, saveCommands, saveMode, saveModel } from "./prefs";
import { addNotice, addUser, reduceAll, reduceChat, settleStreaming } from "./reduce";
import {
  emptyChat, type ChatEnvelope, type ChatState, type ImageAttachment, type Outgoing, type PermissionMode,
} from "./types";

export interface TabChat {
  chat: ChatState;
  /** Hay un `claude -p` corriendo para esta tab. */
  running: boolean;
  /** Arrancando el turno (skills, cuenta, pasos previos), todavía sin proceso. */
  starting: boolean;
  /** Lo que se mandó mientras trabajaba: sale cuando termina. */
  queue: Outgoing[];
  draft: string;
  images: ImageAttachment[];
  /** Ya se cargó el historial del `.jsonl`. */
  loaded: boolean;
  /** El id con el que se creó la sesión, hasta que el `init` la confirma. */
  pendingSession: string | null;
  model: string | null;
  mode: PermissionMode;
  /** Si el turno en curso ya trajo su cierre (para no duplicar el error del final). */
  gotResult: boolean;
}

interface ChatStore {
  chats: Record<string, TabChat>;
  get: (tabId: string) => TabChat;
  /** Carga la conversación guardada. Con `force`, aunque ya estuviera (al volver de la
   *  consola, donde siguió). */
  load: (tab: Tab, force?: boolean) => Promise<void>;
  onEnvelope: (tabId: string, env: ChatEnvelope) => void;
  send: (tabId: string, msg: Outgoing) => void;
  stop: (tabId: string) => Promise<void>;
  /** Otra conversación: la de ahora queda en Sesiones. */
  newConversation: (tabId: string) => Promise<void>;
  setDraft: (tabId: string, draft: string) => void;
  addImages: (tabId: string, images: ImageAttachment[]) => void;
  removeImage: (tabId: string, index: number) => void;
  dropQueued: (tabId: string, index: number) => void;
  setModel: (tabId: string, model: string | null) => void;
  setMode: (tabId: string, mode: PermissionMode) => void;
  notice: (tabId: string, tone: "info" | "error", text: string) => void;
  forget: (tabId: string) => void;
}

const fresh = (tabId: string): TabChat => ({
  chat: emptyChat(),
  running: false,
  starting: false,
  queue: [],
  draft: "",
  images: [],
  loaded: false,
  pendingSession: null,
  model: loadModel(tabId),
  mode: loadMode(tabId),
  gotResult: false,
});

const tabOf = (tabId: string) => useTabsStore.getState().tabs.find((t) => t.id === tabId);

export const useChatStore = create<ChatStore>((set, get) => {
  const patch = (tabId: string, fn: (c: TabChat) => Partial<TabChat>) =>
    set((s) => {
      const cur = s.chats[tabId] ?? fresh(tabId);
      return { chats: { ...s.chats, [tabId]: { ...cur, ...fn(cur) } } };
    });

  /** Lanza el turno: lo mismo que hace `Terminal.tsx` antes de la TUI, y después el proceso. */
  const launch = async (tabId: string, msg: Outgoing) => {
    const tab = tabOf(tabId);
    if (!tab) return;
    // Un comando (`/compact`, una skill) se dibuja como el historial lo va a mostrar
    // después: como comando, no como un mensaje.
    const slash = msg.images.length === 0 ? parseSlash(msg.text) : null;
    patch(tabId, (c) => ({
      starting: true,
      gotResult: false,
      chat: slash
        ? reduceChat(settleStreaming(c.chat), { kind: "command", name: slash.name, args: slash.args })
        : addUser(c.chat, msg.text, msg.images.length),
    }));
    const fail = (text: string) =>
      patch(tabId, (c) => ({ starting: false, chat: addNotice(c.chat, "error", text) }));

    try {
      for (const err of await awaitSkillSetup(tabId)) {
        get().notice(tabId, "error", i18n.t("terminal.skillSetupFailed", { error: err }));
      }
      await reconcileTabSkills(tabId).catch(console.error);

      let env: Record<string, string> = {};
      if (tab.accountId) {
        try {
          env = await accountEnv(tab.accountId);
        } catch (e) {
          return fail(i18n.t("terminal.accountMissing", { error: e }));
        }
      }
      let prelaunch: string[] = [];
      if (tab.prelaunch?.length) {
        try {
          prelaunch = await resolvePrelaunch(tab.prelaunch);
        } catch (e) {
          return fail(i18n.t("terminal.prelaunchError", { error: e }));
        }
      }

      // La sesión de la tab si ya existe; si no, una nueva con un id que se decide acá y
      // se confirma con el `init`. Si el turno falla antes, el siguiente reusa el mismo.
      const current = get().get(tabId);
      const known = tabOf(tabId)?.sessionId;
      const sessionId = known ?? current.pendingSession ?? crypto.randomUUID();
      patch(tabId, () => ({ pendingSession: known ? null : sessionId }));

      await chatSend({
        tabId,
        cwd: tab.cwd,
        sessionId,
        resume: !!known,
        model: current.model,
        permissionMode: current.mode,
        content: buildContent(msg),
        env,
        prelaunch,
      });
      patch(tabId, () => ({ starting: false, running: true }));
    } catch (e) {
      fail(i18n.t("chat.launchError", { error: e }));
    }
  };

  const next = (tabId: string) => {
    const c = get().get(tabId);
    if (c.running || c.starting || c.queue.length === 0) return;
    const [first, ...rest] = c.queue;
    patch(tabId, () => ({ queue: rest }));
    void launch(tabId, first!);
  };

  return {
    chats: {},

    get: (tabId) => get().chats[tabId] ?? fresh(tabId),

    load: async (tab, force = false) => {
      const cur = get().get(tab.id);
      if (cur.loaded && !force) return;
      const [events, running, settings] = await Promise.all([
        tab.sessionId
          ? chatTranscript(tab.cwd, tab.sessionId, tab.accountId ?? null).catch((e) => {
              console.error(e);
              return [];
            })
          : Promise.resolve([]),
        chatRunning(tab.id).catch(() => false),
        tab.sessionId
          ? chatSessionSettings(tab.cwd, tab.sessionId, tab.accountId ?? null).catch(() => null)
          : Promise.resolve(null),
      ]);
      // Se sigue con el modelo que la sesión venía usando: si en la consola se cambió, eso
      // manda, no lo último que se eligió acá. Sin avisarlo en la conversación: no es un
      // cambio, es seguir igual.
      const model = settings?.model ?? null;
      if (model) saveModel(tab.id, model);
      patch(tab.id, (c) => ({ chat: reduceAll(emptyChat(), events), loaded: true, running, model: model ?? c.model }));
    },

    onEnvelope: (tabId, env) => {
      if (env.type === "events") {
        for (const e of env.events) {
          if (e.kind !== "init") continue;
          // La sesión ya existe en disco: desde acá es la de la tab, y la consola la reanuda.
          const tab = tabOf(tabId);
          if (e.sessionId && tab && tab.sessionId !== e.sessionId) {
            useTabsStore.getState().setSessionId(tabId, e.sessionId);
          }
          if (tab) saveCommands(tab.cwd, e.slashCommands, e.terminalCommands);
        }
        patch(tabId, (c) => ({
          chat: reduceAll(c.chat, env.events),
          pendingSession: env.events.some((e) => e.kind === "init") ? null : c.pendingSession,
          gotResult: c.gotResult || env.events.some((e) => e.kind === "result"),
        }));
        return;
      }

      patch(tabId, (c) => {
        let chat: ChatState = { ...settleStreaming(c.chat), status: null };
        if (env.stopped) {
          chat = addNotice(chat, "info", i18n.t("chat.stopped"));
        } else if (env.code !== 0 && !c.gotResult) {
          const detail = env.stderr.trim() || i18n.t("chat.exitCode", { code: env.code ?? "?" });
          chat = addNotice(chat, "error", detail);
        }
        return { chat, running: false, starting: false };
      });
      // Los permisos que esperaba este turno se descartaron en el backend.
      useRunsStore.getState().loadApprovals().catch(console.error);
      next(tabId);
    },

    send: (tabId, msg) => {
      const c = get().get(tabId);
      if (c.running || c.starting) {
        patch(tabId, (cur) => ({ queue: [...cur.queue, msg] }));
        return;
      }
      void launch(tabId, msg);
    },

    stop: async (tabId) => {
      // Parar también vacía la cola: lo que estaba esperando era para seguir ESTE turno.
      patch(tabId, () => ({ queue: [] }));
      await chatStop(tabId);
    },

    newConversation: async (tabId) => {
      const c = get().get(tabId);
      if (c.running) await get().stop(tabId);
      useTabsStore.getState().updateTab(tabId, { sessionId: undefined });
      patch(tabId, () => ({ chat: emptyChat(), pendingSession: null, queue: [], loaded: true }));
    },

    setDraft: (tabId, draft) => patch(tabId, () => ({ draft })),
    addImages: (tabId, images) => patch(tabId, (c) => ({ images: [...c.images, ...images] })),
    removeImage: (tabId, index) => patch(tabId, (c) => ({ images: c.images.filter((_, i) => i !== index) })),
    dropQueued: (tabId, index) => patch(tabId, (c) => ({ queue: c.queue.filter((_, i) => i !== index) })),

    setModel: (tabId, model) => {
      saveModel(tabId, model);
      patch(tabId, () => ({ model }));
    },
    setMode: (tabId, mode) => {
      saveMode(tabId, mode);
      patch(tabId, () => ({ mode }));
    },

    notice: (tabId, tone, text) => patch(tabId, (c) => ({ chat: addNotice(c.chat, tone, text) })),

    forget: (tabId) =>
      set((s) => {
        const { [tabId]: _, ...rest } = s.chats;
        return { chats: rest };
      }),
  };
});

/** Cómo está el chat de una tab, para el punto de la barra de tabs. */
export type ChatActivity = "idle" | "working" | "approval";

export function useChatActivity(tabId: string): ChatActivity {
  const working = useChatStore((s) => {
    const c = s.chats[tabId];
    return !!c && (c.running || c.starting);
  });
  const asking = useRunsStore((s) => s.approvals.some((a) => a.tabId === tabId));
  return asking ? "approval" : working ? "working" : "idle";
}
