/**
 * Lo que el resto de la app le escribe a una tab en modo HTML (soltar un archivo, mandar un
 * elemento del navegador, un pedido de Git o de graphify) va a su chat en vez de a xterm.
 */
import { useTabsStore } from "@/features/tabs/store";
import { setChatSink } from "@/features/terminal/terminalRegistry";

import { useChatStore } from "./store";

const composers = new Map<string, HTMLTextAreaElement>();

/** El input del chat de una tab, para poder darle el foco desde afuera. */
export function registerComposer(tabId: string, el: HTMLTextAreaElement): () => void {
  composers.set(tabId, el);
  return () => {
    if (composers.get(tabId) === el) composers.delete(tabId);
  };
}

const isChat = (tabId: string) => useTabsStore.getState().tabs.find((t) => t.id === tabId)?.mode === "html";

export function installChatSink() {
  setChatSink({
    paste: (tabId, text, submit) => {
      if (!isChat(tabId)) return false;
      const store = useChatStore.getState();
      if (submit) {
        store.send(tabId, { text, images: [] });
      } else {
        const draft = store.get(tabId).draft;
        store.setDraft(tabId, draft && !/\s$/.test(draft) ? `${draft} ${text}` : `${draft}${text}`);
      }
      return true;
    },
    focus: (tabId) => {
      if (!isChat(tabId)) return false;
      composers.get(tabId)?.focus();
      return true;
    },
  });
}
