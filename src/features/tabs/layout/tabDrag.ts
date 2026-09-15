import type React from "react";

import { useTabsStore } from "@/features/tabs/store";

import { isNoop, stripSlot, zoneAt, zoneBox } from "./dropTarget";
import { currentLayout, moveItemTo, splitGroup, useLayoutStore, type DropTarget } from "./layoutStore";
import { allGroups, findGroup, groupOf, isAgentKey, keyId } from "./layoutTree";

/**
 * Arrastrar una tab: a otra posición de su tira, a la tira de otro grupo, o sobre el
 * contenido de un grupo —el centro la muda ahí, un borde divide—.
 *
 * ## Con el puntero y no con el drag & drop de HTML
 *
 * El de HTML depende de cada webview: en Windows, Tauri se queda con los arrastres de la
 * ventana para recibir archivos y la página no ve ni uno; y sobre un `<iframe>` (el
 * navegador de las tabs) los eventos le llegan a la página de adentro, no a la app. Con
 * `setPointerCapture` todo el movimiento le llega a la tab que se arrastra, pase por encima
 * de lo que pase, en los tres sistemas.
 */

/** Cuánto hay que mover antes de que un click pase a ser un arrastre. */
const THRESHOLD = 6;

export const EDITOR_AREA_SELECTOR = "[data-editor-area]";

function hitTest(x: number, y: number, key: string): DropTarget | null {
  const layout = currentLayout();
  if (!layout) return null;
  const source = groupOf(layout, key);

  const strip = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tab-strip]");
  if (strip) {
    const groupId = strip.dataset.tabStrip ?? "";
    if (!findGroup(layout, groupId)) return null;
    const tabs = [...strip.querySelectorAll<HTMLElement>("[data-tab-key]")].map((el) => el.getBoundingClientRect());
    const box = strip.getBoundingClientRect();
    const { index, lineX } = stripSlot(x, tabs.map((r) => ({ left: r.left, width: r.width })));
    return { kind: "strip", groupId, index, lineX, top: box.top, height: box.height };
  }

  const area = document.querySelector<HTMLElement>(EDITOR_AREA_SELECTOR)?.getBoundingClientRect();
  if (!area) return null;
  const { slots } = useLayoutStore.getState();
  for (const group of allGroups(layout.root)) {
    const slot = slots[group.id];
    if (!slot) continue;
    const box = { left: area.left + slot.left, top: area.top + slot.top, width: slot.width, height: slot.height };
    if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) continue;
    const side = zoneAt((x - box.left) / box.width, (y - box.top) / box.height);
    if (isNoop(side, group.id === source?.id, group.items.length)) return null;
    return { kind: "zone", groupId: group.id, side, rect: zoneBox(box, side) };
  }
  return null;
}

/** Los agentes del workspace quedan en el store en el orden en que se ven, grupo por grupo:
 *  es el orden con que se guardan y con que los lista el panel de la izquierda. */
function syncAgentOrder(): void {
  const layout = currentLayout();
  if (!layout) return;
  const ids = allGroups(layout.root).flatMap((g) => g.items).filter(isAgentKey).map(keyId);
  useTabsStore.getState().arrangeTabs(ids);
}

function applyDrop(key: string, target: DropTarget): void {
  if (target.kind === "strip") moveItemTo(key, target.groupId, target.index);
  else if (target.side === "center") moveItemTo(key, target.groupId);
  else splitGroup(target.groupId, target.side, key);
  if (isAgentKey(key)) syncAgentOrder();
}

/** Después de soltar, el navegador igual dispara el click sobre la tab: no es un click. */
function swallowNextClick(): void {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Para el `onPointerDown` de una tab. Si el puntero no se mueve, es un click común. */
export function beginTabDrag(e: React.PointerEvent<HTMLElement>, key: string, label: string): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
  const el = e.currentTarget;
  const { pointerId, clientX: startX, clientY: startY } = e;
  let started = false;

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      started = true;
      try {
        el.setPointerCapture(pointerId);
      } catch {
        /* el puntero ya se soltó: el próximo pointerup termina igual */
      }
    }
    useLayoutStore.setState({ drag: { key, label, x: ev.clientX, y: ev.clientY, target: hitTest(ev.clientX, ev.clientY, key) } });
  };

  const finish = (drop: PointerEvent | null) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, { capture: true });
    if (!started) return;
    useLayoutStore.setState({ drag: null });
    swallowNextClick();
    const target = drop ? hitTest(drop.clientX, drop.clientY, key) : null;
    if (target) applyDrop(key, target);
  };
  const onUp = (ev: PointerEvent) => ev.pointerId === pointerId && finish(ev);
  const onCancel = (ev: PointerEvent) => ev.pointerId === pointerId && finish(null);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(null);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, { capture: true });
}
