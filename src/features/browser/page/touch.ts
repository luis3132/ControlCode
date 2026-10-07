/**
 * Emular una pantalla táctil de verdad, no solo una angosta.
 *
 * Un iframe angosto prueba las media queries de ancho y nada más. Pero lo que rompe en un
 * teléfono no suele ser el ancho: es el menú que solo se abre con `:hover`, el tooltip que
 * nadie puede ver sin mouse, el `onMouseEnter` que en un dedo no existe. Todo eso lo
 * deciden `(hover)` y `(pointer)`, y el navegador los contesta por el dispositivo real.
 *
 * Acá se contestan por el dispositivo **emulado**, en tres frentes:
 *
 * 1. **El CSS**, reescribiendo las media queries de las hojas de estilo. Se puede porque
 *    todo pasa por el proxy: las hojas son del mismo origen que la página, así que sus
 *    reglas se pueden leer y escribir. Una hoja de otro origen (una fuente de Google) tira
 *    al leerla y se saltea.
 * 2. **El JavaScript**, respondiendo `matchMedia` con lo mismo que dice el CSS. Si no, la
 *    página se contradice: el CSS cree que es un teléfono y el JS que es una laptop.
 * 3. **Las reglas `:hover`**, que se desactivan reescribiendo su selector. Son la otra
 *    mitad del problema y la que se había quedado afuera: `@media (hover: hover)` lo mira
 *    poca gente, pero `.menu:hover .submenu { display: block }` lo usa todo el mundo, y con
 *    eso el menú seguía abriéndose al pasar el mouse — o sea, el táctil "no hacía nada".
 * 4. **El puntero del usuario**: mientras está prendido, sus eventos de pasar por encima
 *    (`mouseover`, `mouseenter`, `mousemove` sin apretar y sus equivalentes de puntero) no
 *    llegan a la página. Un dedo no pasa por encima: apoya.
 * 5. **Los toques**, tanto los del agente (`runtime.ts`) como los del usuario: apretar con
 *    el mouse manda `touchstart`/`touchmove`/`touchend` sobre el elemento. Cada motor los
 *    arma distinto (ver [`sendTouch`]): WebKitGTK no deja hacer `new Touch()`, y por eso en
 *    Linux no llegaba ningún toque.
 * 6. **Arrastrar desplaza**, como un dedo: la página o el contenedor que se pueda mover, en
 *    vez de seleccionar texto. Salvo que la página maneje el gesto ella misma (un carrusel
 *    que cancela el `touchmove`). El click que sigue a un arrastre no llega, y el cursor es
 *    un círculo, como en las herramientas de desarrollo de cualquier navegador.
 *
 * Lo que NO se puede: que el click nativo del usuario deje de existir. Una página que
 * escucha `touchstart` y llama a `preventDefault()` para cancelar el click igual va a
 * recibirlo, porque un evento sintético no cancela nada del navegador. Es la diferencia que
 * queda contra un teléfono de verdad.
 *
 * Se puede apagar y todo vuelve como estaba: lo original se guarda y se restaura.
 */

/** Una consulta que nunca es cierta, y una que siempre lo es. Reemplazan a la original en
 *  vez de borrarla para no cambiar la estructura de la regla (y su especificidad). */
const NEVER = "(min-width: 99999px)";
const ALWAYS = "(min-width: 0px)";

/**
 * La misma consulta como la contestaría una pantalla táctil.
 *
 * `(hover: none)` y `(pointer: coarse)` pasan a ser ciertas; `(hover: hover)` y
 * `(pointer: fine)`, falsas. La forma booleana —`(hover)`, `(pointer)`— pregunta si el
 * dispositivo tiene la capacidad: un táctil no tiene hover, pero sí puntero (grueso).
 */
export function coarseMedia(media: string): string {
  return media
    .replace(/\(\s*(any-)?(hover|pointer)\s*:\s*([a-z]+)\s*\)/gi, (_whole, _any, feature: string, value: string) => {
      const touch = feature.toLowerCase() === "hover" ? value.toLowerCase() === "none" : value.toLowerCase() === "coarse";
      return touch ? ALWAYS : NEVER;
    })
    .replace(/\(\s*(any-)?(hover|pointer)\s*\)/gi, (_whole, _any, feature: string) =>
      (feature.toLowerCase() === "hover" ? NEVER : ALWAYS));
}

/** Si la regla depende de que el mouse esté encima. Las demás no se tocan. */
export function mentionsHover(selector: string): boolean {
  return /:hover\b/i.test(selector);
}

/**
 * El mismo selector, pero sin `:hover`: se cambia por una clase que nadie tiene, así la
 * regla deja de aplicar sin cambiar cuánto pesa (una clase y una pseudo-clase valen lo
 * mismo) ni el orden en que pisa a las demás. `:not(:hover)`, que en un táctil es siempre
 * cierto, sigue aplicando.
 */
export function withoutHover(selector: string): string {
  return selector.replace(/:hover\b/gi, NO_HOVER);
}

/** Si la consulta habla de hover o de puntero. Las demás no se tocan. */
export function mentionsPointer(media: string): boolean {
  return /\(\s*(any-)?(hover|pointer)\b/i.test(media);
}

// ── Aplicarlo a la página ───────────────────────────────────────

/** Una clase que nadie tiene: reemplaza a `:hover` para que la regla deje de aplicar sin
 *  cambiarle la especificidad (una clase y una pseudo-clase pesan lo mismo). */
const NO_HOVER = ".cc-touch-no-hover";

/** Lo que decía cada regla antes de tocarla. */
const originals = new WeakMap<CSSMediaRule, string>();
/** Lo que decía el selector de cada regla con `:hover`. */
const hoverOriginals = new WeakMap<CSSStyleRule, string>();
/** Lo que decía cada `<link media>` / `<style media>`. */
const ATTR = "data-controlcode-media";

let on = false;
let observer: MutationObserver | null = null;
let realMatchMedia: typeof window.matchMedia | null = null;
/** Cómo se sueltan los oyentes del puntero del usuario al apagar. */
let releaseInput: (() => void) | null = null;

function eachMediaRule(rules: CSSRuleList, visit: (rule: CSSMediaRule) => void): void {
  for (const rule of Array.from(rules)) {
    // `CSSMediaRule` por forma y no por `instanceof`: la hoja puede venir de otro
    // documento, donde la clase es otra.
    const group = rule as CSSMediaRule & { cssRules?: CSSRuleList };
    if (group.media && typeof group.conditionText === "string") visit(group);
    if (group.cssRules) eachMediaRule(group.cssRules, visit);
  }
}

function eachStyleRule(rules: CSSRuleList, visit: (rule: CSSStyleRule) => void): void {
  for (const rule of Array.from(rules)) {
    const any = rule as CSSStyleRule & { cssRules?: CSSRuleList };
    if (typeof any.selectorText === "string") visit(any);
    // Las de adentro de `@media`, `@supports` o `@layer` cuentan igual.
    if (any.cssRules) eachStyleRule(any.cssRules, visit);
  }
}

/**
 * Apaga (o devuelve) las reglas que dependen de `:hover`.
 *
 * Reescribe el selector en vez de borrar la regla: así se puede volver atrás exactamente, y
 * `:not(:hover)` —que en un táctil es siempre cierto— sigue aplicando.
 */
function applyHoverToSheets(touch: boolean): number {
  let changed = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // De otro origen: el navegador no deja leerla.
    }
    eachStyleRule(rules, (rule) => {
      const original = hoverOriginals.get(rule) ?? rule.selectorText;
      if (!mentionsHover(original)) return;
      hoverOriginals.set(rule, original);
      const wanted = touch ? withoutHover(original) : original;
      if (rule.selectorText === wanted) return;
      try {
        rule.selectorText = wanted;
        // Un motor que no deja escribirlo lo ignora en silencio: se comprueba.
        if (rule.selectorText === wanted) changed++;
      } catch {
        /* una regla que no deja escribir su selector se queda como está */
      }
    });
  }
  return changed;
}

function applyToSheets(touch: boolean): number {
  let changed = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // De otro origen: el navegador no deja leerla.
    }
    eachMediaRule(rules, (rule) => {
      const original = originals.get(rule) ?? rule.media.mediaText;
      if (!mentionsPointer(original)) return;
      originals.set(rule, original);
      const wanted = touch ? coarseMedia(original) : original;
      if (rule.media.mediaText !== wanted) {
        try {
          rule.media.mediaText = wanted;
          changed++;
        } catch {
          /* una regla que no deja escribir su media se queda como está */
        }
      }
    });
  }
  return changed;
}

function applyToAttributes(touch: boolean): number {
  let changed = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("link[media], style[media]"))) {
    const original = el.getAttribute(ATTR) ?? el.getAttribute("media") ?? "";
    if (!mentionsPointer(original)) continue;
    if (touch) {
      el.setAttribute(ATTR, original);
      el.setAttribute("media", coarseMedia(original));
    } else {
      el.setAttribute("media", original);
      el.removeAttribute(ATTR);
    }
    changed++;
  }
  return changed;
}

/** Un punto de contacto, armado como lo acepte el motor:
 *
 * - `new Touch(...)`: Chromium (WebView2 en Windows).
 * - `document.createTouch(...)`: WebKit (WebKitGTK en Linux), donde `new Touch` tira
 *   "Illegal constructor". Verificado con WebKitGTK 2.54.
 * - Un objeto con la misma forma: Safari de escritorio (macOS), que no tiene táctil.
 */
function makeTouch(el: Element, x: number, y: number): Touch {
  const init = {
    identifier: 1, target: el, clientX: x, clientY: y,
    pageX: x + window.scrollX, pageY: y + window.scrollY,
    screenX: x + window.screenX, screenY: y + window.screenY,
    radiusX: 11, radiusY: 11, rotationAngle: 0, force: 0.5,
  };
  try {
    if (typeof Touch === "function") return new Touch(init);
  } catch {
    /* WebKit: constructor ilegal */
  }
  const legacy = document as Document & {
    createTouch?: (view: Window, target: EventTarget, id: number, pageX: number, pageY: number, screenX: number, screenY: number) => Touch;
  };
  if (typeof legacy.createTouch === "function") {
    try {
      return legacy.createTouch(window, el, 1, init.pageX, init.pageY, init.screenX, init.screenY);
    } catch {
      /* sigue abajo */
    }
  }
  return init as unknown as Touch;
}

/** Una lista de toques: WebKit exige un `TouchList` de verdad en `TouchEvent`. */
function makeList(touches: Touch[]): Touch[] | TouchList {
  const legacy = document as Document & { createTouchList?: (...t: Touch[]) => TouchList };
  try {
    if (typeof legacy.createTouchList === "function") return legacy.createTouchList(...touches);
  } catch {
    /* un objeto que no es un Touch real (Safari de escritorio) no entra en la lista */
  }
  return touches;
}

/**
 * Manda un evento táctil de verdad, para lo que escucha `touchstart` y no `pointerdown`.
 * Devuelve `false` si la página lo canceló (`preventDefault`): es la señal de que maneja
 * el gesto ella misma y no hay que desplazar por ella.
 */
export function sendTouch(el: Element, type: string, x: number, y: number): boolean {
  const point = makeTouch(el, x, y);
  // En `touchend` ya no hay dedos apoyados: `touches` va vacío y el que se levantó va en
  // `changedTouches`. Una galería que mira `touches.length` depende de eso.
  const down = type !== "touchend" ? [point] : [];
  const lists = { touches: makeList(down), targetTouches: makeList(down), changedTouches: makeList([point]) };
  const base = { bubbles: true, cancelable: true, composed: true };
  let event: Event;
  try {
    event = new TouchEvent(type, { ...base, view: window, ...lists } as TouchEventInit);
  } catch {
    // Sin `TouchEvent` (Safari de escritorio) o sin aceptar estas listas: un evento con el
    // mismo nombre y las mismas listas, que es lo que lee una página.
    event = new Event(type, base);
    for (const [key, value] of Object.entries(lists)) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
  }
  try {
    return el.dispatchEvent(event);
  } catch {
    return true;
  }
}

/** El contenedor que un arrastre movería: el primero hacia arriba que se puede desplazar
 *  en esa dirección, o la página. */
function scrollerFor(el: Element | null, dx: number, dy: number): Element {
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    const canX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    if ((dy !== 0 && canY) || (dx !== 0 && canX)) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Lo que cambia mientras está prendido: no se selecciona texto arrastrando (en un
 *  teléfono se arrastra para desplazar), salvo en los campos, y el cursor es un dedo. */
const STYLE_ID = "cc-touch-style";
const FINGER = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><circle cx='12' cy='12' r='9' fill='rgba(120,120,120,0.35)' stroke='rgba(80,80,80,0.6)' stroke-width='1.5'/></svg>\") 12 12, pointer";
function setTouchStyle(touch: boolean): void {
  const existing = document.getElementById(STYLE_ID);
  if (!touch) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `html, html * { -webkit-user-select: none !important; user-select: none !important; cursor: ${FINGER} !important; }\n` +
    "input, textarea, [contenteditable], [contenteditable] * { -webkit-user-select: text !important; user-select: text !important; }";
  (document.head ?? document.documentElement).appendChild(style);
}

/** Cuánto hay que mover para que apoyar sea arrastrar y no tocar. */
const PAN_THRESHOLD = 6;

/**
 * El puntero del usuario, contestado como un dedo: lo de pasar por encima no llega a la
 * página, apretar manda los eventos de toque, y arrastrar desplaza.
 *
 * Va en captura y sobre `window`, así que corta antes que los oyentes de la página. El
 * selector de elementos de Control Code se registra antes (se inyecta primero) y por eso
 * sigue viendo el mouse: sin eso, marcar algo dejaría de funcionar con el táctil prendido.
 */
function watchRealInput(): () => void {
  const fromMouse = (e: PointerEvent) => e.isTrusted && (!e.pointerType || e.pointerType === "mouse");
  const stopHover = (e: Event) => {
    const mouse = e as MouseEvent;
    if (mouse.isTrusted && mouse.buttons === 0) e.stopImmediatePropagation();
  };

  /** El dedo apoyado ahora. `handled`: la página canceló el toque, el gesto es suyo. */
  let finger: { target: Element; startX: number; startY: number; lastX: number; lastY: number; panning: boolean; handled: boolean } | null = null;
  let swallowClick = false;

  const down = (e: Event) => {
    const p = e as PointerEvent;
    if (!fromMouse(p) || p.button !== 0) return;
    const target = p.target instanceof Element ? p.target : document.body;
    const handled = !sendTouch(target, "touchstart", p.clientX, p.clientY);
    finger = { target, startX: p.clientX, startY: p.clientY, lastX: p.clientX, lastY: p.clientY, panning: false, handled };
  };
  const move = (e: Event) => {
    const p = e as PointerEvent;
    if (!fromMouse(p) || !finger || (p.buttons & 1) === 0) return;
    // El `touchmove` va al elemento donde empezó el toque, como en un táctil de verdad.
    if (!sendTouch(finger.target, "touchmove", p.clientX, p.clientY)) finger.handled = true;
    const dx = p.clientX - finger.lastX;
    const dy = p.clientY - finger.lastY;
    finger.lastX = p.clientX;
    finger.lastY = p.clientY;
    if (finger.handled) return;
    if (!finger.panning && Math.hypot(p.clientX - finger.startX, p.clientY - finger.startY) >= PAN_THRESHOLD) {
      finger.panning = true;
    }
    if (!finger.panning) return;
    scrollerFor(finger.target, dx, dy).scrollBy(-dx, -dy);
    window.getSelection()?.removeAllRanges();
  };
  const up = (e: Event) => {
    const p = e as PointerEvent;
    if (!fromMouse(p) || !finger) return;
    sendTouch(finger.target, "touchend", p.clientX, p.clientY);
    // Después de arrastrar, levantar el dedo no es un toque: el click no llega.
    swallowClick = finger.panning;
    finger = null;
    if (swallowClick) window.setTimeout(() => { swallowClick = false; }, 0);
  };
  const click = (e: Event) => {
    if (!swallowClick || !e.isTrusted) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // Arrastrar un link o una imagen arrancaría el arrastre nativo en vez de desplazar.
  const dragStart = (e: Event) => {
    if (e.isTrusted) e.preventDefault();
  };

  const hover = ["mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove",
    "pointerover", "pointerout", "pointerenter", "pointerleave"];
  const handlers: [string, EventListener][] = [
    ["pointerdown", down],
    ["pointermove", (e) => { stopHover(e); move(e); }],
    ["pointerup", up],
    ["pointercancel", up],
    ["click", click],
    ["dragstart", dragStart],
  ];
  for (const type of hover) window.addEventListener(type, stopHover, true);
  for (const [type, handler] of handlers) window.addEventListener(type, handler, true);
  setTouchStyle(true);

  return () => {
    for (const type of hover) window.removeEventListener(type, stopHover, true);
    for (const [type, handler] of handlers) window.removeEventListener(type, handler, true);
    setTouchStyle(false);
  };
}

/** ¿Está emulando un táctil? Lo consulta `runtime.ts` para saber qué eventos mandar. */
export function isTouch(): boolean {
  return on;
}

/**
 * Prende o apaga la emulación. Devuelve cuántas reglas quedaron afectadas —media queries de
 * hover/puntero y reglas `:hover`—, que es lo que le dice al agente si la página realmente
 * distingue el táctil o si no mira el puntero para nada.
 */
export function setTouch(touch: boolean): { rules: number } {
  on = touch;

  if (touch && !realMatchMedia) {
    realMatchMedia = window.matchMedia.bind(window);
    // El JS tiene que contestar lo mismo que el CSS: una página que pregunta
    // `matchMedia("(hover: hover)")` para decidir si monta un menú desplegable se
    // comportaría como en escritorio arriba de un CSS que ya cree que es un teléfono.
    window.matchMedia = ((query: string) => realMatchMedia!(on ? coarseMedia(query) : query)) as typeof window.matchMedia;
    try {
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => (on ? 5 : 0) });
    } catch {
      /* si no se deja redefinir, el resto igual sirve */
    }
    // Media página detecta táctil con esto y nada más.
    if (!("ontouchstart" in window)) {
      try {
        Object.defineProperty(window, "ontouchstart", { configurable: true, value: null, writable: true });
      } catch {
        /* idem */
      }
    }
  }

  const rules = applyToSheets(touch) + applyToAttributes(touch) + applyHoverToSheets(touch);

  // El puntero del usuario: que pasar por encima deje de existir, y que apretar sea un toque.
  if (touch && !releaseInput) releaseInput = watchRealInput();
  if (!touch && releaseInput) {
    releaseInput();
    releaseInput = null;
  }

  // Las hojas que la página agrega después (un componente que carga su CSS al montarse)
  // llegarían sin reescribir. Se vuelve a pasar cuando aparecen.
  if (touch && !observer) {
    observer = new MutationObserver((records) => {
      if (!on) return;
      const relevant = records.some((r) =>
        Array.from(r.addedNodes).some((n) => n.nodeName === "STYLE" || n.nodeName === "LINK"));
      if (relevant) {
        applyToSheets(true);
        applyToAttributes(true);
        applyHoverToSheets(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (!touch && observer) {
    observer.disconnect();
    observer = null;
  }
  return { rules };
}
