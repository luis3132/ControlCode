/**
 * La conexión con un PC emparejado.
 *
 * Una por PC, compartida por todas las pantallas que lo muestran (ver `connectionFor`).
 * Se conecta al relay, observa si el PC está conectado, trae su estado entero cuando
 * aparece y lo mantiene al día con los eventos que manda (permisos, preguntas). Si se
 * corta, reintenta con espera creciente; en segundo plano se cierra (ver `_layout.tsx`),
 * y así el PC sabe que tiene que avisar por notificación.
 */
import { useSyncExternalStore } from "react";

import { RelayClient } from "@/protocol/client";
import { wsUrl } from "@/protocol/frames";
import type { Keys } from "@/protocol/crypto";
import { pushToken } from "./push";
import type { Approval, Ask, Attached, Desktop, DesktopState, LaunchOptions, TabEvent } from "./types";

export type ConnStatus = "connecting" | "online" | "pc-offline" | "error";

export interface Snapshot {
  status: ConnStatus;
  error: string | null;
  state: DesktopState | null;
}

const MAX_RETRY_MS = 30_000;

export class DesktopConnection {
  snapshot: Snapshot = { status: "connecting", error: null, state: null };
  private client: RelayClient | null = null;
  private listeners = new Set<() => void>();
  private tabListeners = new Map<string, Set<(e: TabEvent) => void>>();
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pushSent = false;

  constructor(readonly desktop: Desktop, private readonly keys: Keys) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private patchState(patch: Partial<DesktopState>) {
    if (this.snapshot.state) this.set({ state: { ...this.snapshot.state, ...patch } });
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  /** Cierra la conexión (la app pasó a segundo plano, o se desemparejó). */
  stop() {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close();
    this.client = null;
  }

  private scheduleRetry() {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private async connect() {
    if (!this.running) return;
    this.client?.close();
    this.set({ status: "connecting", error: null });
    const client = new RelayClient({ url: wsUrl(this.desktop.relay), keys: this.keys, token: this.desktop.token });
    this.client = client;

    client.on("state", (state) => {
      if (state === "closed" && this.client === client) {
        this.set({ status: "error", error: "Se cortó la conexión con el relay." });
        this.scheduleRetry();
      }
    });
    client.on("presence", ({ id, online }) => {
      if (id !== this.desktop.id) return;
      if (online) void this.refresh();
      else this.set({ status: "pc-offline", error: null });
    });
    client.on("event", ({ from, name, data }) => {
      if (from === this.desktop.id) this.onEvent(name, data);
    });

    try {
      await client.connect();
      this.retryMs = 1000;
      // La presencia del PC llega enseguida, y si está conectado dispara `refresh`.
      client.watch([this.desktop.id]);
    } catch (e) {
      if (this.client !== client) return;
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      this.scheduleRetry();
    }
  }

  /** Trae el estado entero del PC. */
  async refresh() {
    try {
      const state = await this.request<DesktopState>("state");
      this.set({ status: "online", error: null, state });
      // Las tabs que alguna pantalla está mirando se vuelven a enganchar: una conexión
      // nueva del lado del PC no se acuerda de las suscripciones de la anterior.
      for (const tabId of this.tabListeners.keys()) this.emitTab(tabId, { kind: "reattach" });
      void this.registerPush();
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async registerPush() {
    if (this.pushSent) return;
    const token = await pushToken();
    if (!token) return;
    this.pushSent = true;
    this.request("push.register", { token }).catch(() => {
      this.pushSent = false;
    });
  }

  private onEvent(name: string, data: unknown) {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (name) {
      case "approvals":
        this.patchState({ approvals: (d.list as Approval[]) ?? [] });
        break;
      case "asks":
        this.patchState({ asks: (d.list as Ask[]) ?? [] });
        break;
      case "tab.data":
        this.emitTab(String(d.tabId), { kind: "data", data: String(d.data ?? "") });
        break;
      case "tab.exit":
        this.emitTab(String(d.tabId), { kind: "exit", code: Number(d.code ?? 0) });
        break;
      case "tab.resize":
        this.emitTab(String(d.tabId), { kind: "resize", cols: Number(d.cols), rows: Number(d.rows) });
        break;
    }
  }

  private emitTab(tabId: string, event: TabEvent) {
    this.tabListeners.get(tabId)?.forEach((fn) => fn(event));
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (!this.client) return Promise.reject(new Error("Sin conexión."));
    return this.client.request<T>(this.desktop.id, method, params, timeoutMs);
  }

  /** Escucha la salida de una tab. El que llama hace el `tab.attach`. */
  onTab(tabId: string, fn: (e: TabEvent) => void): () => void {
    let set = this.tabListeners.get(tabId);
    if (!set) this.tabListeners.set(tabId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) {
        this.tabListeners.delete(tabId);
        this.request("tab.detach", { tabId }).catch(() => {});
      }
    };
  }

  attach(tabId: string) {
    return this.request<Attached>("tab.attach", { tabId });
  }

  launchOptions() {
    return this.request<LaunchOptions>("launch.options");
  }
}

const registry = new Map<string, DesktopConnection>();

export function connectionFor(desktop: Desktop, keys: Keys): DesktopConnection {
  let conn = registry.get(desktop.id);
  if (!conn) {
    conn = new DesktopConnection(desktop, keys);
    registry.set(desktop.id, conn);
  }
  conn.start();
  return conn;
}

export function allConnections(): DesktopConnection[] {
  return [...registry.values()];
}

export function dropConnection(id: string) {
  registry.get(id)?.stop();
  registry.delete(id);
}

export function useSnapshot(conn: DesktopConnection | null): Snapshot | null {
  return useSyncExternalStore(
    (fn) => (conn ? conn.subscribe(fn) : () => {}),
    () => conn?.snapshot ?? null,
  );
}
