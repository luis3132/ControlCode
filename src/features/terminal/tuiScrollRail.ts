import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Carril de scroll para las TUIs de pantalla alternativa (Claude Code en modo fullscreen,
 * OpenCode, vim, less…).
 *
 * ## Por qué la barra de xterm no alcanza
 *
 * En la pantalla alternativa xterm no guarda historial: la TUI redibuja la pantalla entera
 * y lleva ella misma su propio scroll. Para xterm no hay nada que recorrer, así que su barra
 * no tiene qué mostrar (ver `terminalScrollbar.ts`), y lo único que llega a la TUI es la
 * rueda, un par de líneas por muesca. En una conversación larga eso es girar y girar.
 *
 * ## Qué hace
 *
 * Ocupa el carril que `fit` ya reserva a la derecha de la grilla (el ancho de la barra de
 * xterm) y lo vuelve una perilla:
 *
 * - Arrastrar el pulgar manda a la TUI ruedas sintéticas en proporción a lo recorrido, y
 *   sostenerlo contra un extremo sigue avanzando solo.
 * - Un click en el carril, arriba o abajo del pulgar, es Re Pág / Av Pág.
 * - La rueda sobre el carril se reenvía a la terminal, como si estuviera sobre el texto.
 *
 * El pulgar NO marca dónde se está: la TUI no informa su posición ni el largo de su
 * contenido, y dibujar un mapa inventado sería peor que no dibujar ninguno. Por eso vuelve
 * al centro al soltarlo.
 *
 * ## Por qué ruedas sintéticas y no secuencias escritas a mano
 *
 * Qué bytes representan una muesca depende de lo que la TUI haya pedido: reportes de mouse
 * SGR, X10, flechas si no pidió mouse… xterm ya resuelve todo eso para cada `wheel` que
 * recibe sobre su pantalla. Despachar el evento ahí es reusar exactamente el camino de la
 * rueda real, sin duplicar el protocolo.
 */
export const RAIL_ON_CLASS = "cc-tui-rail-on";

/** Píxeles de arrastre por muesca de rueda. */
const PX_PER_NOTCH = 8;
/** Zona contra cada extremo del carril donde sostener el pulgar sigue avanzando. */
const EDGE_PX = 20;
const EDGE_REPEAT_MS = 40;

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

export function installTuiScrollRail(
  term: Terminal,
  container: HTMLElement,
  label: string,
): () => void {
  const rail = document.createElement("div");
  rail.className = "cc-tui-rail";
  rail.title = label;
  rail.setAttribute("aria-hidden", "true");
  // El mismo ancho que `fit` le descuenta a la grilla: ni tapa texto ni deja un hueco.
  rail.style.width = `${term.options.scrollbar?.width ?? 14}px`;
  const thumb = document.createElement("div");
  thumb.className = "cc-tui-rail-thumb";
  rail.appendChild(thumb);
  container.appendChild(rail);

  const wheel = (direction: 1 | -1, notches = 1) => {
    const screen = term.element?.querySelector(".xterm-screen");
    if (!screen) return;
    const box = screen.getBoundingClientRect();
    for (let i = 0; i < notches; i++) {
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: direction,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          // Los reportes de mouse llevan la celda: tiene que caer dentro de la grilla.
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };

  // ── Arrastre del pulgar ─────────────────────────────────
  let drag: { pointerId: number; startY: number; lastY: number; sent: number } | null = null;
  let edgeTimer: ReturnType<typeof setInterval> | null = null;

  const moveThumb = (offset: number) => {
    const room = (rail.clientHeight - thumb.offsetHeight) / 2;
    const clamped = Math.max(-room, Math.min(room, offset));
    thumb.style.transform = `translateY(calc(-50% + ${clamped}px))`;
  };

  const endDrag = () => {
    if (edgeTimer) clearInterval(edgeTimer);
    edgeTimer = null;
    drag = null;
    rail.classList.remove("dragging");
    thumb.style.transform = "";
  };

  const onThumbDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    // Sin esto el mousedown se lleva el foco y lo siguiente que se tipea no va a la TUI.
    ev.preventDefault();
    ev.stopPropagation();
    thumb.setPointerCapture(ev.pointerId);
    drag = { pointerId: ev.pointerId, startY: ev.clientY, lastY: ev.clientY, sent: 0 };
    rail.classList.add("dragging");
    edgeTimer = setInterval(() => {
      if (!drag) return;
      const box = rail.getBoundingClientRect();
      if (drag.lastY < box.top + EDGE_PX) wheel(-1);
      else if (drag.lastY > box.bottom - EDGE_PX) wheel(1);
    }, EDGE_REPEAT_MS);
  };

  const onThumbMove = (ev: PointerEvent) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    drag.lastY = ev.clientY;
    const offset = ev.clientY - drag.startY;
    moveThumb(offset);
    const due = Math.trunc(offset / PX_PER_NOTCH);
    const pending = due - drag.sent;
    if (pending !== 0) {
      wheel(pending > 0 ? 1 : -1, Math.abs(pending));
      drag.sent = due;
    }
  };

  const onThumbUp = (ev: PointerEvent) => {
    if (drag && ev.pointerId === drag.pointerId) endDrag();
  };

  // ── Click en el carril: una página ──────────────────────
  const onRailDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || ev.target !== rail) return;
    ev.preventDefault();
    const thumbBox = thumb.getBoundingClientRect();
    const above = ev.clientY < thumbBox.top + thumbBox.height / 2;
    term.input(above ? PAGE_UP : PAGE_DOWN, true);
  };

  // ── Rueda sobre el carril ───────────────────────────────
  // El carril está fuera del elemento de xterm, así que la rueda ahí no le llegaba a nadie.
  const onRailWheel = (ev: WheelEvent) => {
    if (ev.deltaY === 0) return;
    ev.preventDefault();
    wheel(ev.deltaY > 0 ? 1 : -1);
  };

  thumb.addEventListener("pointerdown", onThumbDown);
  thumb.addEventListener("pointermove", onThumbMove);
  thumb.addEventListener("pointerup", onThumbUp);
  thumb.addEventListener("pointercancel", onThumbUp);
  rail.addEventListener("pointerdown", onRailDown);
  rail.addEventListener("wheel", onRailWheel, { passive: false });

  // Solo en la pantalla alternativa: en la normal hay historial de verdad y manda la barra
  // de xterm, que sí sabe dónde se está.
  const update = () => {
    const on = term.buffer.active.type === "alternate";
    container.classList.toggle(RAIL_ON_CLASS, on);
    if (!on && drag) endDrag();
  };
  const sub: IDisposable = term.buffer.onBufferChange(update);
  update();

  return () => {
    sub.dispose();
    endDrag();
    rail.remove();
    container.classList.remove(RAIL_ON_CLASS);
  };
}
