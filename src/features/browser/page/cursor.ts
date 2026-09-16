/**
 * El puntero del agente: lo que hace que ver a un modelo usando la página sea mirar algo y
 * no adivinar por qué cambió.
 *
 * Vive adentro de la página (lo empaqueta `runtime.ts`), encima de todo y sin recibir
 * eventos, así que no cambia en nada lo que la página hace ni lo que el usuario puede
 * tocar. Tampoco sale en el snapshot ni en el selector: va colgado de `<html>` (no del
 * `<body>` que se recorre), marcado como decorativo.
 *
 * Cuando nadie está mirando la tab no se anima: esperar 300 ms por acción para dibujar algo
 * que nadie ve sería pagar el doble por cada click de un agente que corre solo.
 */

const MARK = "data-controlcode-agent";
/** Uno menos que el selector de elementos: si los dos están, el del usuario va arriba. */
const LAYER = "2147483646";

/** Cuánto tarda en llegar al elemento, y cuánto se queda antes de actuar. */
const TRAVEL_MS = 220;
const SETTLE_MS = 110;
const IDLE_MS = 1600;

export interface AgentCursor {
  /** Lo lleva al elemento y espera a que se vea. No espera nada si nadie mira. */
  toElement: (el: Element, label: string) => Promise<void>;
  /** El pulso de un click, donde está parado. */
  click: () => void;
  /** Cambia el rótulo sin moverse (una tecla, un scroll). */
  say: (label: string) => void;
  hide: () => void;
  /** Si la tab del navegador está a la vista. */
  setWatched: (watched: boolean) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute(MARK, "");
  node.setAttribute("aria-hidden", "true");
  Object.assign(node.style, style);
  return node;
}

export function createCursor(): AgentCursor {
  let root: HTMLDivElement | null = null;
  let arrow: HTMLDivElement | null = null;
  let chip: HTMLDivElement | null = null;
  let ripple: HTMLDivElement | null = null;
  let watched = true;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let at = { x: 0, y: 0 };

  function build(): { root: HTMLDivElement; arrow: HTMLDivElement; chip: HTMLDivElement; ripple: HTMLDivElement } {
    if (root && arrow && chip && ripple) return { root, arrow, chip, ripple };
    root = el("div", {
      position: "fixed", left: "0", top: "0", zIndex: LAYER, pointerEvents: "none",
      transition: `transform ${TRAVEL_MS}ms cubic-bezier(.22,.61,.36,1), opacity 160ms ease-out`,
      opacity: "0", willChange: "transform",
    });
    ripple = el("div", {
      position: "absolute", left: "-14px", top: "-14px", width: "28px", height: "28px",
      borderRadius: "50%", border: "2px solid rgba(124,58,237,.9)", opacity: "0", transform: "scale(.4)",
    });
    arrow = el("div", {
      position: "absolute", left: "-2px", top: "-2px", width: "22px", height: "22px",
      // Una flecha de puntero, dibujada como SVG para que se vea igual en los tres motores.
      backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='22' height='22'><path d='M5 2l14 8.5-6.2 1.3L9.8 19z' fill='white' stroke='rgb(88,28,135)' stroke-width='1.6' stroke-linejoin='round'/></svg>\")",
      filter: "drop-shadow(0 2px 4px rgba(0,0,0,.35))",
    });
    chip = el("div", {
      position: "absolute", left: "18px", top: "18px", padding: "2px 7px", borderRadius: "999px",
      background: "rgb(124,58,237)", color: "white", whiteSpace: "nowrap",
      font: "600 11px/17px ui-monospace, SFMono-Regular, Menlo, monospace",
      boxShadow: "0 2px 8px rgba(0,0,0,.28)",
    });
    root.append(ripple, arrow, chip);
    document.documentElement.append(root);
    return { root, arrow, chip, ripple };
  }

  function place(x: number, y: number): void {
    const parts = build();
    at = { x, y };
    parts.root.style.transform = `translate(${x}px, ${y}px)`;
    parts.root.style.opacity = "1";
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (root) root.style.opacity = "0";
    }, IDLE_MS);
  }

  return {
    toElement: async (target, label) => {
      const rect = target.getBoundingClientRect();
      // El centro, salvo que sea enorme: en un contenedor a pantalla completa el puntero
      // quedaría en el medio de la nada en vez de sobre lo que se va a tocar.
      const x = rect.left + Math.min(rect.width / 2, 120);
      const y = rect.top + Math.min(rect.height / 2, 60);
      const parts = build();
      parts.chip.textContent = label;
      // Sin transición la primera vez: aparecer viajando desde la esquina es ruido.
      if (at.x === 0 && at.y === 0) parts.root.style.transition = "opacity 160ms ease-out";
      place(x, y);
      if (!watched) return;
      await new Promise((r) => setTimeout(r, TRAVEL_MS + SETTLE_MS));
      parts.root.style.transition = `transform ${TRAVEL_MS}ms cubic-bezier(.22,.61,.36,1), opacity 160ms ease-out`;
    },
    click: () => {
      const parts = build();
      const ring = parts.ripple;
      ring.style.transition = "none";
      ring.style.opacity = "0.95";
      ring.style.transform = "scale(.4)";
      // Dos cuadros: sin esto el navegador junta las dos escrituras y no hay animación.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ring.style.transition = "transform 420ms ease-out, opacity 420ms ease-out";
        ring.style.opacity = "0";
        ring.style.transform = "scale(2.1)";
      }));
    },
    say: (label) => {
      const parts = build();
      parts.chip.textContent = label;
      place(at.x, at.y);
    },
    hide: () => {
      if (root) root.style.opacity = "0";
    },
    setWatched: (next) => {
      watched = next;
      if (!next && root) root.style.opacity = "0";
    },
  };
}
