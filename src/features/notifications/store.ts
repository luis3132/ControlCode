import { create } from "zustand";

/**
 * Los avisos de la campana: lo que pasó mientras no se estaba mirando.
 *
 * Viven solo en esta ventana y en memoria. No son un registro (eso son Sesiones, la Flota y
 * Subprocesos): son "esto terminó, esto te espera, esto se cayó", y al reiniciar la app ya
 * no dicen nada que valga la pena.
 */

export type NoticeKind = "finished" | "approval" | "processFailed";

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** El texto, ya traducido: el aviso se arma cuando pasa, con los nombres de ese momento. */
  text: string;
  at: number;
  read: boolean;
  /** Adónde lleva tocarlo. */
  target: { tabId: string } | { path: string };
}

/** Los más viejos se descartan: la campana no es un historial. */
const MAX = 50;

interface NotificationsState {
  notices: Notice[];
  /** Las tabs que terminaron sin que nadie las viera, con cuándo. Se borran al mirarlas. */
  finished: Record<string, number>;
  push: (notice: Omit<Notice, "id" | "read">) => void;
  markAllRead: () => void;
  clear: () => void;
  markFinished: (tabId: string, at: number) => void;
  /** Ya se vio: se va el punto de la tab, y su aviso queda leído. */
  markSeen: (tabId: string) => void;
}

let seq = 0;

export const useNotificationsStore = create<NotificationsState>((set) => ({
  notices: [],
  finished: {},
  push: (notice) =>
    set((s) => ({
      notices: [{ ...notice, id: `n${++seq}`, read: false }, ...s.notices].slice(0, MAX),
    })),
  markAllRead: () =>
    set((s) => (s.notices.some((n) => !n.read) ? { notices: s.notices.map((n) => (n.read ? n : { ...n, read: true })) } : s)),
  clear: () => set({ notices: [] }),
  markFinished: (tabId, at) => set((s) => ({ finished: { ...s.finished, [tabId]: at } })),
  markSeen: (tabId) =>
    set((s) => {
      if (!(tabId in s.finished)) return s;
      const { [tabId]: _, ...finished } = s.finished;
      const notices = s.notices.map((n) =>
        !n.read && n.kind === "finished" && "tabId" in n.target && n.target.tabId === tabId ? { ...n, read: true } : n
      );
      return { finished, notices };
    }),
}));

export const unreadCount = (notices: Notice[]) => notices.filter((n) => !n.read).length;
