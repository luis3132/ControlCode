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
 * 3. **Los eventos**, que los manda `runtime.ts`: un toque no pasa por encima antes de
 *    apretar, y eso es exactamente lo que rompe un menú que depende de `:hover`.
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

/** Si la consulta habla de hover o de puntero. Las demás no se tocan. */
export function mentionsPointer(media: string): boolean {
  return /\(\s*(any-)?(hover|pointer)\b/i.test(media);
}

// ── Aplicarlo a la página ───────────────────────────────────────

/** Lo que decía cada regla antes de tocarla. */
const originals = new WeakMap<CSSMediaRule, string>();
/** Lo que decía cada `<link media>` / `<style media>`. */
const ATTR = "data-controlcode-media";

let on = false;
let observer: MutationObserver | null = null;
let realMatchMedia: typeof window.matchMedia | null = null;

function eachMediaRule(rules: CSSRuleList, visit: (rule: CSSMediaRule) => void): void {
  for (const rule of Array.from(rules)) {
    // `CSSMediaRule` por forma y no por `instanceof`: la hoja puede venir de otro
    // documento, donde la clase es otra.
    const group = rule as CSSMediaRule & { cssRules?: CSSRuleList };
    if (group.media && typeof group.conditionText === "string") visit(group);
    if (group.cssRules) eachMediaRule(group.cssRules, visit);
  }
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

/** ¿Está emulando un táctil? Lo consulta `runtime.ts` para saber qué eventos mandar. */
export function isTouch(): boolean {
  return on;
}

/**
 * Prende o apaga la emulación. Devuelve cuántas media queries quedaron afectadas, que es lo
 * que le dice al agente si la página realmente distingue el táctil o no mira el puntero
 * para nada.
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

  const rules = applyToSheets(touch) + applyToAttributes(touch);

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
