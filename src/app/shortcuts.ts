/**
 * Atajos de teclado globales para moverse por la app.
 *
 * ## Por qué son globales de verdad
 *
 * El punto del atajo es salir de donde estás sin levantar las manos del teclado, y donde
 * más se está es adentro de una terminal. Así que el listener se registra en `window` con
 * `capture: true`: la fase de captura baja desde `window` hasta el elemento, o sea que
 * corre ANTES que el handler del textarea de xterm. Con `preventDefault` +
 * `stopPropagation` el atajo nunca llega al proceso del agente.
 *
 * ## El precio, dicho explícitamente
 *
 * Un Ctrl+letra no es solo un acorde: en una terminal ya significa algo. Ctrl+M ES Enter
 * (CR) y Ctrl+H ES Backspace a nivel protocolo, y Ctrl+E (fin de línea) y Ctrl+K (borrar
 * hasta el final) son edición estilo emacs que readline usa. Al capturarlos acá, esas
 * combinaciones dejan de existir DENTRO de las TUIs.
 *
 * En la práctica pesa poco: Enter y Backspace tienen sus propias teclas y son las que se
 * usan; lo que se pierde de verdad es la edición emacs para quien la tenga en los dedos.
 * Si molesta, se cambia una línea de la tabla de abajo y nada más — por eso la tabla es
 * el único lugar donde vive esta decisión.
 *
 * ## Ir y volver con la misma tecla
 *
 * Cada atajo de sección es un interruptor: si ya estás en esa sección, te devuelve a la
 * terminal. Sin eso los atajos serían de ida nomás — rápido para irte de tu trabajo y un
 * click para volver, que es al revés de lo que hace falta.
 */

import { keyName } from "@/shared/keyboard";

/** La ruta del área de terminales. Volver acá es volver a trabajar. */
export const WORKSPACE_PATH = "/workspace";

export type ShortcutAction =
  | { kind: "goto"; path: string }
  /** Configuración es un modal, no una ruta: se abre encima sin tapar las terminales. */
  | { kind: "openSettings" }
  /** `delta` en el ORDEN de la barra de tabs: +1 la siguiente, -1 la anterior. */
  | { kind: "cycleTab"; delta: 1 | -1 };

export interface Shortcut {
  /** `KeyboardEvent.key` en minúscula. */
  key: string;
  /** `true` exige Shift; ausente exige que NO esté. */
  shift?: boolean;
  action: ShortcutAction;
  /** La ruta con la que se busca este acorde desde un botón (ver `shortcutForPath`).
   *  Se declara aparte porque no toda acción es una navegación: configuración abre un
   *  modal, pero el botón que lo abre sigue queriendo mostrar "Ctrl+G". */
  path?: string;
  /** Cómo se escribe para el usuario. No se traduce: "Ctrl" se llama igual en los dos idiomas. */
  display: string;
  /** Clave i18n de qué hace. */
  labelKey: string;
}

/**
 * Las letras siguen la inicial en español —**H**ome, s**E**siones, s**K**ills,
 * **M**arketplace, **F**lota, confi**G**uración— salvo skills, que empieza igual que
 * sesiones. Ctrl+F se le saca a la terminal (en readline es "avanzar un carácter"), el
 * mismo precio que ya pagan Ctrl+E y Ctrl+K, y bastante menos grave que lo que se evitó
 * con Ctrl+W y Ctrl+S.
 *
 * Workspaces queda a propósito sin atajo: las teclas que le tocarían (Ctrl+W cierra,
 * Ctrl+S congela la terminal con XOFF) hacen más daño que bien, y se llega desde Home.
 */
export const SHORTCUTS: Shortcut[] = [
  { key: "h", action: { kind: "goto", path: "/" }, display: "Ctrl+H", labelKey: "sidebar.home" },
  { key: "e", action: { kind: "goto", path: "/sessions" }, display: "Ctrl+E", labelKey: "sidebar.sessions" },
  { key: "k", action: { kind: "goto", path: "/skills" }, display: "Ctrl+K", labelKey: "sidebar.skills" },
  { key: "m", action: { kind: "goto", path: "/marketplace" }, display: "Ctrl+M", labelKey: "sidebar.marketplace" },
  { key: "f", action: { kind: "goto", path: "/fleet" }, display: "Ctrl+F", labelKey: "sidebar.fleet" },
  { key: "g", action: { kind: "openSettings" }, path: "/settings", display: "Ctrl+G", labelKey: "sidebar.settings" },
  { key: "tab", action: { kind: "cycleTab", delta: 1 }, display: "Ctrl+Tab", labelKey: "shortcuts.nextTab" },
  {
    key: "tab",
    shift: true,
    action: { kind: "cycleTab", delta: -1 },
    display: "Ctrl+Shift+Tab",
    labelKey: "shortcuts.prevTab",
  },
];

/** Lo que hace falta de un `KeyboardEvent` — estructural para poder testear sin DOM. */
export interface KeyChord {
  key: string;
  /** La tecla física. Hace falta para reconocer Shift+Tab en WebKitGTK (ver `keyName`). */
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function matchShortcut(e: KeyChord): Shortcut | null {
  // Alt tiene que estar ausente, y no es un detalle: en Windows y Linux AltGr llega como
  // Ctrl+Alt, así que sin esta condición escribir un carácter con AltGr dispararía atajos.
  // Meta queda afuera por lo mismo (Cmd+M minimiza en macOS).
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = keyName(e).toLowerCase();
  return SHORTCUTS.find((s) => s.key === key && Boolean(s.shift) === e.shiftKey) ?? null;
}

/**
 * A dónde lleva un atajo de sección. `null` = no hay nada que hacer.
 *
 * Estando ya en la sección devuelve a la terminal, pero solo si hay alguna tab: sin tabs
 * `/workspace` rebota a Home solo (ver `AppShell`), así que el atajo haría parpadear la
 * vista para terminar donde ya estaba.
 */
export function resolveGoto(target: string, currentPath: string, hasTabs: boolean): string | null {
  if (target !== currentPath) return target;
  return hasTabs ? WORKSPACE_PATH : null;
}

/**
 * La tab a activar al ciclar. Da la vuelta en los dos extremos: llegar a la última y
 * quedarse trabado ahí obliga a hacer el camino de vuelta tecla por tecla.
 */
export function nextTabId(tabIds: string[], activeId: string | null, delta: number): string | null {
  if (tabIds.length === 0) return null;
  const current = activeId === null ? -1 : tabIds.indexOf(activeId);
  // Sin tab activa se entra por la punta que corresponde al sentido del ciclo.
  if (current === -1) return delta > 0 ? tabIds[0] : tabIds[tabIds.length - 1];
  return tabIds[(current + delta + tabIds.length) % tabIds.length];
}

/** El acorde que lleva a esta ruta, para mostrarlo en el tooltip del botón que hace lo mismo. */
export function shortcutForPath(path: string): string | null {
  const found = SHORTCUTS.find(
    (s) => s.path === path || (s.action.kind === "goto" && s.action.path === path)
  );
  return found?.display ?? null;
}
