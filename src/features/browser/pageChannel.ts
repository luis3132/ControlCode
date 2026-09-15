import type { AppMessage, PageCommand, PageOp, PageReply } from "./protocol";

/** Las órdenes que pueden hacer navegar a la página: si el documento cambia antes de que
 *  contesten, es que funcionaron. */
const MAY_NAVIGATE = new Set<PageOp>(["click", "press", "type", "select"]);

interface Pending {
  op: PageOp;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Las órdenes en vuelo hacia el runtime de una página, cada una esperando su respuesta.
 *
 * `postMessage` no tiene respuesta: se manda con un id y se espera un `page:reply` con el
 * mismo. Si la página no contesta —navegó a otro sitio, se colgó, el runtime no se
 * inyectó— el tope corta en vez de dejar al agente esperando para siempre.
 */
export class PageChannel {
  private pending = new Map<string, Pending>();

  constructor(private readonly target: () => { window: Window | null; origin: string } | null) {}

  run(command: PageCommand, timeoutMs = 10_000): Promise<unknown> {
    const target = this.target();
    if (!target?.window) return Promise.reject(new Error("No hay ninguna página cargada en el navegador."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`La página no respondió en ${Math.round(timeoutMs / 1000)} s. `
          + "¿Sigue cargando, o navegó a un sitio que no pasa por el proxy?"));
      }, timeoutMs);
      this.pending.set(id, { op: command.op, resolve, reject, timer });
      target.window!.postMessage({ source: "controlcode", type: "page:run", id, command } satisfies AppMessage, target.origin);
    });
  }

  reply(reply: PageReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error));
  }

  /** Cargó otro documento: lo que esperaba respuesta del anterior no la va a tener. */
  documentChanged(url: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (MAY_NAVIGATE.has(pending.op)) pending.resolve({ navigated: true, url });
      else pending.reject(new Error("La página cambió mientras se leía; volvé a intentarlo."));
    }
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Se cerró la tab del navegador."));
    }
    this.pending.clear();
  }
}
