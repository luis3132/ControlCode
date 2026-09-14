/**
 * Selector de elementos. NO es parte del bundle de la app: se compila a un script suelto
 * (`import pickerScript from "./picker.ts?script"`) y el proxy de la vista previa lo
 * inyecta en cada página HTML del proyecto.
 *
 * Vive adentro del iframe, así que ve la página; la app no puede (es otro origen). Todo lo
 * que sabe lo cuenta por `postMessage`, y solo actúa cuando la app se lo pide.
 *
 * Por eso no puede importar nada en tiempo de ejecución: solo `import type`, que se borra
 * al compilar.
 */
import type { AppMessage, PageMessage, PickedComponent, PickedElement } from "./protocol";

declare global {
  interface Window {
    __controlcodePicker?: boolean;
  }
}

/** Lo mínimo de un fiber de React que hace falta para subir hasta el componente. */
interface Fiber {
  type: unknown;
  return: Fiber | null;
}

type Named = { displayName?: string; name?: string; __name?: string; render?: Named };

(() => {
  // Fuera de un iframe (alguien abrió la URL del proxy en su navegador) no hay app con
  // quien hablar.
  if (window.__controlcodePicker || window.parent === window) return;
  window.__controlcodePicker = true;

  const ATTRIBUTES = ["role", "aria-label", "name", "type", "href", "src", "alt", "placeholder", "title", "data-testid"];
  const MARK = "data-controlcode-picker";

  let parentOrigin: string | null = null;
  let active = false;
  let current: Element | null = null;
  let box: HTMLDivElement | null = null;
  let label: HTMLDivElement | null = null;

  function post(message: Omit<PageMessage, "source">) {
    const full = { source: "controlcode-preview", ...message } as PageMessage;
    // El origen de la app se aprende del primer mensaje que manda. Hasta entonces (o si el
    // motor lo serializa como "null") no hay a quién apuntar con precisión.
    const target = parentOrigin && parentOrigin !== "null" ? parentOrigin : "*";
    try {
      window.parent.postMessage(full, target);
    } catch {
      window.parent.postMessage(full, "*");
    }
  }

  function describe(el: Element): string {
    const name = el.tagName.toLowerCase();
    if (el.id) return `${name}#${el.id}`;
    const classes = Array.from(el.classList).slice(0, 2);
    return classes.length ? `${name}.${classes.join(".")}` : name;
  }

  function overlay(): { box: HTMLDivElement; label: HTMLDivElement } {
    if (box && label) return { box, label };
    box = document.createElement("div");
    label = document.createElement("div");
    box.setAttribute(MARK, "");
    label.setAttribute(MARK, "");
    Object.assign(box.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none",
      border: "2px solid #3b82f6", background: "rgba(59,130,246,0.12)", borderRadius: "3px",
      boxSizing: "border-box", transition: "all 60ms ease-out",
    });
    Object.assign(label.style, {
      position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none",
      background: "#1d4ed8", color: "#fff", borderRadius: "3px", padding: "0 6px",
      font: "600 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap",
    });
    document.documentElement.append(box, label);
    return { box, label };
  }

  function highlight(el: Element | null) {
    current = el;
    const o = overlay();
    if (!el) {
      o.box.style.display = "none";
      o.label.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(o.box.style, {
      display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    });
    o.label.textContent = `${describe(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    Object.assign(o.label.style, {
      display: "block",
      left: `${Math.max(0, r.left)}px`,
      top: `${r.top > 22 ? r.top - 20 : r.bottom + 2}px`,
    });
  }

  const isOurs = (el: Element | null) => !!el?.hasAttribute(MARK);

  /** Un selector que vuelva a encontrar el elemento, lo más corto posible. Las clases con
   *  `:`, `[` o `/` (Tailwind) se saltean: válidas, pero ilegibles como referencia. */
  function selectorOf(el: Element): string {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList)
        .filter((c) => c.length < 32 && !/[:[\]/]/.test(c))
        .slice(0, 2);
      if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const tag = node.tagName;
        const same = Array.from(parent.children).filter((c) => c.tagName === tag);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (parts.length >= 5) break;
    }
    return parts.join(" > ");
  }

  const nameOf = (type: unknown): string | undefined => {
    if (!type || (typeof type !== "function" && typeof type !== "object")) return undefined;
    const t = type as Named;
    return t.displayName || t.name || t.render?.displayName || t.render?.name;
  };

  /** El componente que dibujó el elemento, si la página corre en modo desarrollo: para un
   *  agente, "LoginForm" dice más que una cadena de divs. */
  function componentOf(el: Element): PickedComponent | null {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bag = node as unknown as Record<string, unknown>;
      const fiberKey = Object.keys(bag).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (fiberKey) {
        for (let fiber = bag[fiberKey] as Fiber | null; fiber; fiber = fiber.return) {
          const name = nameOf(fiber.type);
          // Con mayúscula: las etiquetas de host (`div`) también tienen `type`, como string.
          if (name && /^[A-Z]/.test(name)) return { framework: "React", name };
        }
        return null;
      }
      const vue = bag.__vueParentComponent as { type?: Named } | undefined;
      const vueName = vue?.type && (vue.type.name || vue.type.__name);
      if (vueName) return { framework: "Vue", name: vueName };
      const svelte = bag.__svelte_meta as { loc?: { file: string; line: number } } | undefined;
      if (svelte?.loc) return { framework: "Svelte", name: `${svelte.loc.file}:${svelte.loc.line + 1}` };
    }
    return null;
  }

  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

  function snapshot(el: Element): PickedElement {
    const r = el.getBoundingClientRect();
    const attributes: Record<string, string> = {};
    for (const a of ATTRIBUTES) {
      const v = el.getAttribute(a);
      if (v) attributes[a] = clip(v, 200);
    }
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      url: location.href,
      title: document.title,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: clip(text, 200),
      html: clip(el.outerHTML, 1500),
      attributes,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      component: componentOf(el),
    };
  }

  function setActive(on: boolean) {
    active = on;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) highlight(null);
  }

  // Mientras se elige, la página no se entera de los clicks: si no, marcar un botón de
  // "Borrar" lo apretaría.
  function swallow(e: Event) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  window.addEventListener("mousemove", (e) => {
    if (!active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !isOurs(el) && el !== current) highlight(el);
  }, true);

  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu"]) {
    window.addEventListener(type, swallow, true);
  }

  window.addEventListener("click", (e) => {
    if (!active) return;
    swallow(e);
    const el = current ?? (e.target instanceof Element ? e.target : null);
    if (!el || isOurs(el)) return;
    // Con Shift se sigue eligiendo: es la forma de juntar varios antes de mandarlos.
    const keepPicking = e.shiftKey;
    post({ type: "pick:selected", payload: { element: snapshot(el), keepPicking } });
    if (!keepPicking) setActive(false);
  }, true);

  window.addEventListener("keydown", (e) => {
    if (active && e.key === "Escape") {
      swallow(e);
      setActive(false);
      post({ type: "pick:cancel" });
    }
  }, true);

  const reposition = () => { if (active && current) highlight(current); };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  window.addEventListener("message", (e: MessageEvent<AppMessage>) => {
    if (e.source !== window.parent || e.data?.source !== "controlcode") return;
    parentOrigin = e.origin;
    switch (e.data.type) {
      case "pick:on": setActive(true); break;
      case "pick:off": setActive(false); break;
      case "history:back": history.back(); break;
      case "history:forward": history.forward(); break;
      case "hello": reportNav(); break;
    }
  });

  // Dónde está parada la página, para la barra de direcciones. Una SPA navega sin
  // recargar, así que también se escucha `pushState` y compañía.
  function reportNav() {
    post({ type: "nav", payload: { url: location.href, title: document.title } });
  }
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      setTimeout(reportNav, 0);
      return result;
    };
  }
  window.addEventListener("popstate", reportNav);
  window.addEventListener("hashchange", reportNav);
  window.addEventListener("load", reportNav);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reportNav);
  else reportNav();
})();
