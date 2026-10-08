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

import { chatDefaults, chatRunning, chatSend, chatSessionSettings, chatStop, chatTranscript } from "./ipc";
import { buildContent, parseSlash } from "./message";
import { loadEffort, loadMode, loadModel, rememberModel, saveCommands, saveEffort, saveMode, saveModel } from "./prefs";
import { addNotice, addUser, reduceAll, reduceChat, settleStreaming } from "./reduce";
import {
  EFFORTS, emptyChat, type ChatEnvelope, type ChatItem, type ChatState, type Effort, type ImageAttachment,
  type Outgoing, type PermissionMode,
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
  /** `null` = el esfuerzo de fábrica de la TUI. */
  effort: Effort | null;
  mode: PermissionMode;
  /** Si el turno en curso ya trajo su cierre (para no duplicar el error del final). */
  gotResult: boolean;
  /** Cuándo arrancó el turno en curso (epoch ms), para el reloj de "trabajando". */
  startedAt: number | null;
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
  setEffort: (tabId: string, effort: Effort | null) => void;
  setMode: (tabId: string, mode: PermissionMode) => void;
  /** `/btw`: una pregunta al margen, sobre una copia de la conversación. */
  askSide: (tabId: string, question: string) => void;
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
  effort: loadEffort(tabId, loadModel(tabId)),
  mode: loadMode(tabId),
  gotResult: false,
  startedAt: null,
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
      startedAt: Date.now(),
      // Lo gastado se pone en cero: es de ESTE turno, y arrastrar lo del anterior mostraría
      // un contador que ya venía corrido.
      chat: {
        ...(slash
          ? reduceChat(settleStreaming(c.chat), { kind: "command", name: slash.name, args: slash.args })
          : addUser(c.chat, msg.text, msg.images.length)),
        usage: null,
      },
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

      // El esfuerzo va SIEMPRE explícito: `claude -p` no lee el `effortLevel` de la
      // configuración ni hereda el de la sesión, y sin el flag cada turno corría en
      // `medium` mientras el chat mostraba otro.
      const effort = current.effort ?? (await chatDefaults(tab.cwd, tab.accountId ?? null).catch(() => null))?.effort ?? null;

      await chatSend({
        tabId,
        cwd: tab.cwd,
        sessionId,
        resume: !!known,
        model: current.model,
        effort,
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

  /** Mete lo que contesta una pregunta al margen en SU tarjeta, no en la conversación. */
  const reduceSide = (chat: ChatState, env: ChatEnvelope): ChatState => {
    const index = lastSideIndex(chat.items);
    if (index < 0) return chat;
    const item = chat.items[index] as Extract<ChatItem, { kind: "side" }>;
    const updated: ChatItem =
      env.type === "events"
        ? { ...item, inner: reduceAll(item.inner, env.events) }
        : {
            ...item,
            running: false,
            inner: endedInner(item.inner, env),
          };
    return { ...chat, items: chat.items.map((it, i) => (i === index ? updated : it)) };
  };

  const endedInner = (inner: ChatState, env: Extract<ChatEnvelope, { type: "ended" }>): ChatState => {
    const settled = { ...settleStreaming(inner), status: null };
    if (env.stopped) return addNotice(settled, "info", i18n.t("chat.stopped"));
    if (env.code !== 0 && !settled.items.some((i) => i.kind === "result")) {
      return addNotice(settled, "error", env.stderr.trim() || i18n.t("chat.exitCode", { code: env.code ?? "?" }));
    }
    return settled;
  };

  const endSide = (chat: ChatState, error: string): ChatState => {
    const index = lastSideIndex(chat.items);
    if (index < 0) return chat;
    const item = chat.items[index] as Extract<ChatItem, { kind: "side" }>;
    return {
      ...chat,
      items: chat.items.map((it, i) =>
        i === index ? { ...item, running: false, inner: addNotice(item.inner, "error", error) } : it
      ),
    };
  };

  const lastSideIndex = (items: ChatItem[]): number => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === "side") return i;
    }
    return -1;
  };

  /**
   * Deja el cambio escrito en la conversación, igual que si se hubiera tipeado el comando.
   *
   * Sin esto, elegir modelo o esfuerzo en el menú no deja ningún rastro: el cambio vale
   * recién en el mensaje siguiente —son flags del proceso, no algo que se le pueda decir al
   * turno en curso— y desde afuera parece que no se enteró.
   */
  const logChange = (chat: ChatState, name: "model" | "effort", value: string): ChatState =>
    reduceChat(
      reduceChat(settleStreaming(chat), { kind: "command", name, args: value }),
      { kind: "commandOutput", text: i18n.t("chat.appliesNext") }
    );

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
      const chat = reduceAll(emptyChat(), events);
      // Se sigue con lo que la sesión venía usando: si en la consola se cambió el modelo o
      // el esfuerzo, eso manda, no lo último que se eligió acá. Sin avisarlo en la
      // conversación: no es un cambio, es seguir igual.
      const adopted: Partial<TabChat> = {};
      if (settings?.model) {
        saveModel(tab.id, settings.model);
        adopted.model = settings.model;
      }
      const effort = settings?.effort;
      if (effort && (EFFORTS as string[]).includes(effort)) {
        saveEffort(tab.id, adopted.model ?? cur.model, effort as Effort);
        adopted.effort = effort as Effort;
      }
      // También del historial: una conversación vieja ya sabe con qué modelo corrió, y ese
      // es justo el que conviene tener a mano en el selector.
      if (chat.info?.model) rememberModel(tab.cwd, chat.info.model);
      patch(tab.id, () => ({ chat, loaded: true, running, ...adopted }));
    },

    onEnvelope: (tabId, env) => {
      if (env.side) {
        patch(tabId, (c) => ({ chat: reduceSide(c.chat, env) }));
        return;
      }
      if (env.type === "events") {
        for (const e of env.events) {
          if (e.kind !== "init") continue;
          // El modelo con el que corrió de verdad: de acá sale la lista del selector, para
          // no tener que tocar código cuando sale uno nuevo.
          const cwd = tabOf(tabId)?.cwd;
          if (cwd && e.model) rememberModel(cwd, e.model);
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
      const cur = get().get(tabId);
      if (cur.model === model) return;
      saveModel(tabId, model);
      // El esfuerzo es de la pareja (tab, modelo), PERO cambiar de modelo no puede borrar
      // un esfuerzo que se acaba de elegir: si el modelo nuevo no tiene uno guardado, se
      // lleva el que estaba puesto (y queda guardado para él).
      const effort = loadEffort(tabId, model) ?? cur.effort;
      if (effort !== null) saveEffort(tabId, model, effort);
      patch(tabId, (c) => ({ model, effort, chat: logChange(c.chat, "model", model ?? "default") }));
    },
    setEffort: (tabId, effort) => {
      const cur = get().get(tabId);
      if (cur.effort === effort) return;
      saveEffort(tabId, cur.model, effort);
      patch(tabId, (c) => ({ effort, chat: logChange(c.chat, "effort", effort ?? "default") }));
    },
    setMode: (tabId, mode) => {
      saveMode(tabId, mode);
      patch(tabId, () => ({ mode }));
    },

    askSide: (tabId, question) => {
      const tab = tabOf(tabId);
      const c = get().get(tabId);
      // Sin conversación no hay nada "al margen" de qué preguntar: sería un chat nuevo, y
      // para eso está el input de siempre.
      if (!tab || !tab.sessionId) {
        get().notice(tabId, "info", i18n.t("chat.btw.needsSession"));
        return;
      }
      if (c.chat.items.some((i) => i.kind === "side" && i.running)) {
        get().notice(tabId, "info", i18n.t("chat.btw.busy"));
        return;
      }
      patch(tabId, (cur) => ({
        chat: {
          ...cur.chat,
          nextId: cur.chat.nextId + 1,
          items: [...cur.chat.items, { kind: "side", id: cur.chat.nextId, question, inner: emptyChat(), running: true }],
        },
      }));

      void (async () => {
        try {
          const env = tab.accountId ? await accountEnv(tab.accountId) : {};
          await chatSend({
            tabId,
            cwd: tab.cwd,
            sessionId: tab.sessionId!,
            resume: true,
            model: c.model,
            effort: c.effort,
            permissionMode: c.mode,
            side: true,
            content: [{ type: "text", text: question }],
            env,
            prelaunch: [],
          });
        } catch (e) {
          patch(tabId, (cur) => ({ chat: endSide(cur.chat, i18n.t("chat.launchError", { error: e })) }));
        }
      })();
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
