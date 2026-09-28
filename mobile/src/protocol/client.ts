/**
 * Una conexión al relay: se presenta con la clave del teléfono y habla cifrado con los PCs.
 *
 * No reconecta sola: eso lo decide quien la usa (`lib/connection.ts`), que sabe si la app
 * está en primer plano. Tampoco depende de React Native: se prueba con `bun test` contra
 * el relay de verdad.
 */
import { type Keys } from "./crypto";
import {
  type ClientFrame, type Inner, ReplayGuard, type Role, type ServerFrame, hello, openInner, request, sealInner,
} from "./frames";

export type ClientState = "idle" | "connecting" | "ready" | "closed";

export interface IncomingEvent {
  from: string;
  name: string;
  data: unknown;
}

export class RelayError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

type Listener<T> = (value: T) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
  url: string;
  keys: Keys;
  token?: string;
  role?: Role;
  /** Para los tests (o una plataforma sin WebSocket global). */
  WebSocketImpl?: typeof WebSocket;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

export class RelayClient {
  state: ClientState = "idle";
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private guard = new ReplayGuard();
  private listeners = {
    state: new Set<Listener<ClientState>>(),
    event: new Set<Listener<IncomingEvent>>(),
    presence: new Set<Listener<{ id: string; online: boolean }>>(),
    request: new Set<Listener<{ from: string; msg: Inner & { k: "req" } }>>(),
  };

  constructor(private readonly options: ClientOptions) {}

  on<K extends keyof RelayClient["listeners"]>(
    kind: K,
    fn: RelayClient["listeners"][K] extends Set<infer L> ? L : never,
  ): () => void {
    const set = this.listeners[kind] as Set<typeof fn>;
    set.add(fn);
    return () => set.delete(fn);
  }

  private setState(state: ClientState) {
    this.state = state;
    this.listeners.state.forEach((fn) => fn(state));
  }

  /** Se conecta y se autentica. Resuelve cuando el relay contesta `ready`. */
  connect(): Promise<void> {
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    this.setState("connecting");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(error);
      };
      const timer = setTimeout(() => fail(new RelayError("El relay no contestó.")), HANDSHAKE_TIMEOUT_MS);

      let ws: WebSocket;
      try {
        ws = new Impl(this.options.url);
      } catch (e) {
        fail(new RelayError(`Dirección de relay inválida: ${String(e)}`));
        return;
      }
      this.ws = ws;
      ws.onerror = () => fail(new RelayError("No se pudo conectar con el relay."));
      ws.onclose = () => {
        fail(new RelayError("El relay cerró la conexión."));
        this.dropPending("Se cortó la conexión.");
        this.setState("closed");
      };
      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!settled) {
          if (frame.t === "challenge") {
            this.sendFrame(hello(this.options.keys, this.options.role ?? "device", frame.relay, frame.challenge, this.options.token));
          } else if (frame.t === "ready") {
            settled = true;
            clearTimeout(timer);
            this.setState("ready");
            resolve();
          } else if (frame.t === "error") {
            fail(new RelayError(frame.code === "token" ? "El relay rechazó el token." : frame.message, frame.code));
          }
          return;
        }
        this.handle(frame);
      };
    });
  }

  private handle(frame: ServerFrame) {
    switch (frame.t) {
      case "msg": {
        const msg = openInner(frame.body, frame.from, this.options.keys);
        if (!msg || !this.guard.check(msg)) return;
        if (msg.k === "res") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.r);
          else p.reject(new RelayError(msg.e ?? "Error"));
        } else if (msg.k === "evt") {
          this.listeners.event.forEach((fn) => fn({ from: frame.from, name: msg.e, data: msg.d }));
        } else {
          this.listeners.request.forEach((fn) => fn({ from: frame.from, msg }));
        }
        return;
      }
      case "presence":
        this.listeners.presence.forEach((fn) => fn({ id: frame.id, online: frame.online }));
        return;
      case "undelivered":
        // El PC no está conectado: lo que se le pidió no va a tener respuesta.
        this.listeners.presence.forEach((fn) => fn({ id: frame.to, online: false }));
        return;
    }
  }

  private sendFrame(frame: ClientFrame) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  /** Observa la presencia de estos ids (reemplaza la lista anterior). */
  watch(ids: string[]) {
    this.sendFrame({ t: "watch", ids });
  }

  /** Manda un mensaje ya armado (una respuesta, un evento). */
  sendInner(to: string, msg: Inner) {
    this.sendFrame({ t: "send", to, body: sealInner(msg, to, this.options.keys) });
  }

  /** Un pedido cifrado a `to`, y su respuesta. */
  request<T = unknown>(to: string, method: string, params: unknown = {}, timeoutMs = 20_000): Promise<T> {
    if (this.state !== "ready") return Promise.reject(new RelayError("Sin conexión con el relay."));
    const msg = request(method, params);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new RelayError("La computadora no contestó a tiempo."));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sendInner(to, msg);
    });
  }

  private dropPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RelayError(reason));
    }
    this.pending.clear();
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ya estaba cerrado
      }
    }
    this.dropPending("Se cerró la conexión.");
    if (this.state !== "idle") this.setState("closed");
  }
}
