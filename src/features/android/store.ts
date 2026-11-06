import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { useRunsStore } from "@/features/runs/store";
import { useTabsStore } from "@/features/tabs/store";
import { useViewTabsStore } from "@/features/tabs/viewStore";
import { comparablePath } from "@/features/tabs/viewTabs";

import { androidStatus, type AndroidStatus } from "./ipc";

/** Un gesto de un agente sobre el dispositivo, como lo manda el backend. */
export interface AgentTouch {
  serial: string;
  kind: "tap" | "hold" | "swipe" | "key" | "text";
  x: number | null;
  y: number | null;
  x2: number | null;
  y2: number | null;
  label: string | null;
}

/** Un gesto para dibujar: de quién y cuándo. */
export interface ShownTouch {
  id: number;
  touch: AgentTouch;
  /** El id de la tab o tarea que lo hizo (`null` = la persona). Da el color. */
  ownerId: string | null;
  ownerLabel: string;
  at: number;
}

/** Cuánto queda dibujado un gesto. */
export const TOUCH_MS = 1600;

interface AndroidState {
  /** `null` = todavía no se preguntó. */
  status: AndroidStatus | null;
  touches: ShownTouch[];
  /** `devices`: también qué hay conectado (levanta el daemon de adb). */
  refresh: (devices?: boolean) => Promise<AndroidStatus | null>;
  addTouch: (touch: AgentTouch, ownerId: string | null, ownerLabel: string) => void;
}

let nextTouch = 1;

export const useAndroidStore = create<AndroidState>((set) => ({
  status: null,
  touches: [],
  refresh: async (devices = true) => {
    try {
      const status = await androidStatus(devices);
      set({ status });
      return status;
    } catch (e) {
      console.error("android_status", e);
      return null;
    }
  },
  addTouch: (touch, ownerId, ownerLabel) => {
    const shown: ShownTouch = { id: nextTouch++, touch, ownerId, ownerLabel, at: Date.now() };
    set((s) => ({ touches: [...s.touches.filter((t) => Date.now() - t.at < TOUCH_MS), shown] }));
    setTimeout(() => set((s) => ({ touches: s.touches.filter((t) => t.id !== shown.id) })), TOUCH_MS + 50);
  },
}));

/** Si este equipo tiene adb: es lo que decide si se ofrece la vista. */
export const useHasAdb = () => useAndroidStore((s) => Boolean(s.status?.adb));

interface Owner {
  kind?: string;
  id?: string;
}

/** Cómo se llama en la interfaz quien hizo el gesto. */
function ownerLabel(owner: Owner | null | undefined): string {
  if (!owner?.id) return "";
  if (owner.kind === "task") return useRunsStore.getState().tasks.find((t) => t.id === owner.id)?.title ?? owner.id;
  return useTabsStore.getState().tabs.find((t) => t.id === owner.id)?.title ?? owner.id;
}

/**
 * Engancha la ventana a lo que hacen los agentes en el dispositivo: que aparezca la vista
 * del proyecto si no estaba —sin sacar a la persona de lo que mira— y que cada toque se
 * dibuje con el color del agente. Devuelve la función para desengancharla.
 */
export function initAndroidEvents(): () => void {
  const unlisteners: Promise<() => void>[] = [];
  // Solo si hay adb: los dispositivos los pide la vista cuando se abre.
  useAndroidStore.getState().refresh(false);

  unlisteners.push(
    listen<{ cwd: string | null; serial: string }>("android-agent", ({ payload }) => {
      const cwd = payload.cwd;
      if (!cwd) return;
      // Solo la ventana que tiene ese proyecto: el evento puede llegar a todas.
      const mine = useTabsStore.getState().tabs.some((t) => comparablePath(t.cwd) === comparablePath(cwd));
      if (!mine) return;
      const views = useViewTabsStore.getState();
      const id = views.openAndroid(cwd, { activate: false });
      const view = views.views.find((v) => v.id === id);
      if (view?.kind === "android" && !view.serial) views.updateView(id, { serial: payload.serial });
    })
  );

  unlisteners.push(
    listen<{ touch: AgentTouch; owner: Owner | null }>("android-touch", ({ payload }) => {
      useAndroidStore.getState().addTouch(payload.touch, payload.owner?.id ?? null, ownerLabel(payload.owner));
    })
  );

  return () => {
    for (const p of unlisteners) p.then((off) => off()).catch(() => {});
  };
}
